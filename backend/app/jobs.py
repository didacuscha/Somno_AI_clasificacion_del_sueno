"""Pipeline de análisis en segundo plano (US-02), con el estado de cada paso (US-20).

POST /analyses valida al instante lo que se puede validar (fuente, canales,
ventana) y responde 202; el análisis corre aquí, en otro hilo:

  1. load        leer el EDF (descargarlo de S3 si hace falta) y quedarse con los
                 canales de la ventana de análisis
  2. preprocess  dividir en épocas de 30 s; guardar la señal para el visor
  3. predict     estadificar con el adaptador del modelo y validar su salida
  4. flag        marcar las épocas bajo el umbral de confianza; métricas de la noche
  5. save        guardar la noche con estado «to_review» o «full_review_suggested»

Cada paso deja su estado en el registro (pendiente, en curso, listo o fallido con
el motivo). Si un paso falla no se guarda ningún resultado de esa noche: la señal se
escribe en una carpeta temporal que solo pasa a su lugar al guardar, y el registro
queda «failed» con su configuración para poder reintentarlo.
"""
import logging
import re
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from . import catalog, channels, config, db, signals, uploads
from .model import adapter as model
from .pipeline import edf_io, epochs, hypnogram, metrics, review, window

log = logging.getLogger("somnoai.jobs")
_pool = ThreadPoolExecutor(max_workers=config.WORKERS, thread_name_prefix="analisis")
EP = config.EPOCH_S

STEPS = [
    ("load", "Cargar señales"),
    ("preprocess", "Preprocesar"),
    ("predict", "Predecir"),
    ("flag", "Marcar épocas"),
    ("save", "Guardar"),
]
KNOWN_ERRORS = (edf_io.InvalidFile, channels.InvalidSelection, model.ModelError, catalog.CatalogError,
                uploads.UploadNotFound)


def new_progress() -> dict:
    return {"current": None,
            "steps": [{"key": k, "label": label, "status": "pending", "message": None, "seconds": None}
                      for k, label in STEPS]}


def _es(v: float, d: int = 1) -> str:
    """Número con coma decimal, como el resto del tablero (es-CO)."""
    return f"{v:.{d}f}".replace(".", ",")


def reason(e: Exception) -> str:
    if isinstance(e, uploads.UploadNotFound):
        return "El archivo subido ya no está en el servidor: súbalo de nuevo."
    if isinstance(e, KNOWN_ERRORS):
        return str(e)
    return f"Error interno ({type(e).__name__}: {e})."


class Steps:
    """Estado de los pasos de un análisis, guardado en el registro a medida que avanza."""

    def __init__(self, record_id: str, progress: dict | None = None):
        self.rid = record_id
        self.progress = progress or new_progress()
        self._t0: dict[str, float] = {}
        self._noted = 0.0

    def step(self, key: str) -> dict:
        return next(s for s in self.progress["steps"] if s["key"] == key)

    def save(self):
        db.set_progress(self.rid, self.progress, "running")

    def start(self, key: str, message: str | None = None):
        self.step(key).update(status="running", message=message)
        self.progress["current"] = key
        self._t0[key] = time.perf_counter()
        self.save()

    def note(self, message: str):
        """Mensaje del paso en curso (p. ej. avance de la descarga), a lo sumo cada 0,8 s."""
        if time.perf_counter() - self._noted < 0.8:
            return
        self._noted = time.perf_counter()
        self.step(self.progress["current"])["message"] = message
        self.save()

    def done(self, key: str, message: str | None = None, save: bool = True):
        self.step(key).update(status="done", message=message,
                              seconds=round(time.perf_counter() - self._t0.get(key, time.perf_counter()), 2))
        if save:
            self.save()

    def failed(self, why: str):
        key = self.progress["current"] or STEPS[0][0]
        self.step(key).update(status="failed", message=why)

    @contextmanager
    def run(self, key: str, message: str | None = None):
        self.start(key, message)
        yield
        if self.step(key)["status"] == "running":
            self.done(key)


# ── qué se analiza ────────────────────────────────────────────────────
@dataclass
class Source:
    type: str                      # catalog | upload
    id: str
    file_name: str
    label: str                     # nombre corto para mostrar
    size_mb: float | None
    header: dict
    hyp_path: str | None           # hipnograma de referencia, ya en disco
    psg_path: str | None           # None = hay que descargarlo (S3) al cargar señales
    dataset: dict | None
    subset: bool = False
    night: dict | None = None


def resolve_source(src: dict | None) -> Source:
    from . import dataset

    src = src or {}
    if src.get("type") == "catalog":
        cat = catalog.get_catalog()
        night = cat.get(str(src.get("id")))
        hyp = cat.fetch_hypnogram(night)
        local = str(cat.store.root / night["id"]) if cat.store.kind == "local" else None
        return Source(type="catalog", id=night["id"], file_name=night["psg"], label=night["label"],
                      size_mb=night["size_mb"], header=night["header"], hyp_path=str(hyp) if hyp else None,
                      psg_path=local, dataset=dataset.lookup(night["psg"]), subset=night["subset"], night=night)
    if src.get("type") == "upload":
        up = uploads.get(str(src.get("id")))
        header = edf_io.read_header(up["psg_path"])
        return Source(type="upload", id=up["id"], file_name=up["file_name"], label=Path(up["file_name"]).stem,
                      size_mb=up["size_mb"], header=header, hyp_path=up["hyp_path"], psg_path=up["psg_path"],
                      dataset=dataset.lookup(up["file_name"]))
    raise edf_io.InvalidFile("Indique la noche a analizar: una del catálogo o un PSG subido.")


def lights_off_value(value: str | None, night: dict | None) -> tuple[str | None, str | None]:
    """None → la del índice de Sleep-EDFx si la hay; "none" → sin apagado de luces."""
    if value is None:
        return (night["lights_off"], "dataset-index") if night else (None, None)
    if value.strip().lower() in ("none", "-", ""):
        return None, None
    # el tablero prellena la del índice: si llega sin cambios, se registra con ese origen
    if night and value.strip() == night["lights_off"]:
        return value.strip(), "dataset-index"
    return value.strip(), "manual"


@dataclass
class Job:
    record_id: str
    spec: dict
    source: Source
    selected: dict[str, str]          # entrada → etiqueta del EDF (ya validada)
    reference: np.ndarray | None      # hipnograma de referencia del registro completo
    win: dict                         # {mode, start_epoch, end_epoch}
    lights_off_clock: str | None
    lights_off_s: float | None
    lights_off_source: str | None     # manual | dataset-index
    created_by: str


def prepare(record_id: str, spec: dict, created_by: str) -> Job:
    """Todo lo que puede fallar por culpa de la entrada, antes de encolar el análisis."""
    src = resolve_source(spec.get("source"))
    header = src.header
    if header["annotations_only"]:
        raise edf_io.InvalidFile("Ese archivo es solo un hipnograma (anotaciones, sin señal).")
    mapping = channels.resolve(spec.get("channels") or [], spec.get("channel_map"), header["labels"])
    total = int(header["duration_s"] // EP)
    reference = hypnogram.read_reference(src.hyp_path, total, header.get("start")) if src.hyp_path else None
    mode = spec.get("window_mode") or ("reference" if reference is not None else "full")
    win = window.resolve(mode, header, reference, spec.get("start_clock"), spec.get("end_clock"))
    lo_clock, lo_source = lights_off_value(spec.get("lights_off"), src.dataset)
    lo_s = window.lights_off(lo_clock, header)
    if lo_s is not None and lo_s >= win["end_epoch"] * EP:
        if lo_source == "manual":
            raise edf_io.InvalidFile(f"La hora de apagado de luces ({lo_clock}) queda después "
                                     "del final de la ventana analizada.")
        lo_s = None                    # la del índice no corresponde a este recorte: se ignora
    return Job(record_id=record_id, spec=spec, source=src, selected=mapping, reference=reference, win=win,
               lights_off_clock=lo_clock if lo_s is not None else None, lights_off_s=lo_s,
               lights_off_source=lo_source if lo_s is not None else None, created_by=created_by)


def subject_code(file_name: str) -> str:
    m = re.match(r"SC4(\d\d)\d", file_name, re.I)       # convención Sleep-EDFx: SC4ssN
    return f"SC{m.group(1)}" if m else Path(file_name).stem[:8].upper()


def base_summary(job: Job, created_at: str | None = None) -> dict:
    slots = channels.ordered(job.selected)
    patient = job.source.header.get("patient") or {}
    ds = job.source.dataset or {}
    return {
        "id": job.record_id,
        "created_at": created_at or db.now(),
        "created_by": job.created_by,
        "source": job.source.type,
        "source_id": job.source.id,
        "night_label": job.source.label,
        "subset": job.source.subset,
        "file_name": job.source.file_name,
        "subject_code": subject_code(job.source.file_name),
        "sex": patient.get("sex") or ds.get("sex"),
        "age": patient.get("age") or ds.get("age"),
        "channels": slots,
        "combination": channels.combination_key(slots),
        "combination_name": channels.combination_name(slots),
        "window_mode": job.win["mode"],
        "n_epochs": job.win["end_epoch"] - job.win["start_epoch"],
        "has_reference": job.reference is not None,
        "dataset_split": ds.get("split"),
        "model_version": model.get_adapter().info().version,
    }


def create(job: Job) -> dict:
    """Registra el análisis como «en cola» y lo lanza. Devuelve el resumen."""
    summary = base_summary(job)
    progress = new_progress()
    db.insert(job.record_id, summary, job.spec, progress)
    _pool.submit(_run, job, summary)
    return {**summary, "status": "queued", "progress": progress, "error": None, "review": None}


def retry(record_id: str, user: str) -> dict:
    """Vuelve a lanzar un análisis fallido con la misma configuración (mismo registro)."""
    row = db.get(record_id)
    job = prepare(record_id, row["spec"], row["summary"]["created_by"])
    summary = base_summary(job, created_at=row["summary"]["created_at"])
    progress = new_progress()
    db.requeue(record_id, summary, progress)
    db.log_action(record_id, user, "retry", "failed", "queued")
    _pool.submit(_run, job, summary)
    return {**summary, "status": "queued", "progress": progress, "error": None, "review": None}


def recover_interrupted() -> int:
    """Al arrancar: lo que estaba en curso murió con el proceso anterior → fallido, reintentable."""
    rows = db.interrupted()
    for r in rows:
        steps = Steps(r["id"], r["progress"] if r["progress"] and "steps" in r["progress"] else None)
        why = "El servidor se reinició durante el análisis. Reinténtelo."
        steps.failed(why)
        db.fail(r["id"], why, steps.progress)
    return len(rows)


def _composition(header: dict, a: int, b: int) -> list[dict]:
    hours = lambda n: round(n * EP / 3600, 2)  # noqa: E731
    total = header["duration_s"] / EP
    return [seg for seg in (
        {"label": "Antes de la ventana", "hours": hours(a), "kind": "outside"},
        {"label": "Ventana analizada", "hours": hours(b - a), "kind": "window"},
        {"label": "Después de la ventana", "hours": hours(total - b), "kind": "outside"},
    ) if seg["hours"] > 0]


def _run(job: Job, summary: dict):
    rid = job.record_id
    final_dir, tmp_dir = config.SIGNAL_DIR / rid, config.SIGNAL_DIR / f"{rid}.part"
    steps = Steps(rid)
    t0 = time.perf_counter()
    timings = {}
    ok = False
    try:
        h, a, b = job.source.header, job.win["start_epoch"], job.win["end_epoch"]
        n = b - a

        # 1 · cargar señales: el EDF, solo los canales que se usan y solo la ventana
        with steps.run("load", "Leyendo el EDF"):
            psg = job.source.psg_path
            if psg is None:
                steps.note("Descargando la noche del catálogo")
                psg = str(catalog.get_catalog().fetch_psg(
                    job.source.night, lambda got, size: steps.note(
                        f"Descargando la noche del catálogo: {got / 1048576:.0f} de {size / 1048576:.0f} MB")))
                steps.note("Leyendo el EDF")
            # el visor muestra también las entradas reconocibles que no se le dieron al modelo
            used = set(job.selected.values())
            detected = {s: lab for s, lab in channels.detect(h["labels"]).items() if lab not in used}
            available = {s: ({**detected, **job.selected})[s] for s in channels.ordered({**detected, **job.selected})}
            raw = edf_io.read_window(psg, list(available.values()), a * EP, b * EP)
            steps.done("load", f"{len(job.selected)} canal{'es' if len(job.selected) > 1 else ''} del modelo · "
                               f"{_es(n * EP / 3600)} h de ventana")
        timings["read_s"] = steps.step("load")["seconds"]

        # 2 · preprocesar: épocas de 30 s por canal del modelo y señal del visor
        with steps.run("preprocess"):
            model_epochs = {s: epochs.split(*raw[lab], n, EP) for s, lab in job.selected.items()}
            viewer, sfreq = edf_io.to_common_rate({s: raw[lab] for s, lab in available.items()})
            signals.remove(tmp_dir)
            units = {s: (h.get("units") or {}).get(lab, signals.DEFAULT_UNIT) for s, lab in available.items()}
            signals.save(tmp_dir, viewer, sfreq, units)
            steps.done("preprocess", f"{n} épocas de {EP} s")

        # 3 · predecir con el adaptador (lo único que el pipeline sabe del modelo)
        adapter = model.get_adapter()
        info = adapter.info()
        with steps.run("predict", f"Estadificando con {info.name}"):
            req = model.StagingRequest(
                record_id=rid, epochs=model_epochs, fs={s: raw[lab][1] for s, lab in job.selected.items()},
                labels=dict(job.selected), start_epoch=a, lights_off_s=job.lights_off_s, epoch_s=EP,
                source=psg, progress=steps.note)
            res = adapter.predict(req)
            stages, probs = model.validate(res, req)
            steps.done("predict", f"{info.version}")
        timings["model_s"] = steps.step("predict")["seconds"]

        # 4 · marcar épocas bajo el umbral y calcular la noche
        with steps.run("flag"):
            ep = review.decide(stages, probs, info.threshold)
            ref = job.reference[a:b] if job.reference is not None else None
            ep["reference"] = ref.tolist() if ref is not None else None
            lo_epoch = int(job.lights_off_s // EP) - a if job.lights_off_s is not None else None
            combo = channels.combination_key(job.selected)
            expected = info.expected.get(combo, {})
            rev = review.state(ep, {}, {}, info.night_review_fraction)
            detail = {
                **summary,
                "model_version": info.version,
                "finished_at": db.now(),
                "patient": {"age": summary["age"], "sex": summary["sex"],
                            "source": "edf-header" if (h.get("patient") or {}).get("age")
                            else ("dataset-index" if summary["age"] else None)},
                "channels": {
                    "selected": channels.ordered(job.selected),
                    "combination": combo,
                    "combination_name": channels.combination_name(job.selected),
                    "mask": channels.mask(job.selected),
                    "map": job.selected,
                    "available": available,
                    "file_labels": h["labels"],
                    "unused": channels.inspect(h["labels"])["unused"],
                    "fs": {s: h["fs"].get(lab, 0.0) for s, lab in available.items()},
                    "units": {s: signals.display_unit(u)[0] for s, u in units.items()},
                },
                "model": {**info.public(), "notes": res.notes,
                          "expected": {**expected, "below_goal": expected.get("test_mf1", 1) < config.MF1_GOAL,
                                       "goal_mf1": config.MF1_GOAL}},
                "night": {
                    "epoch_s": EP,
                    "n_epochs": n,
                    "start_epoch": a,
                    "start_clock_s": h["start_clock_s"] + a * EP if h.get("start_clock_s") is not None else None,
                    "window": {"mode": job.win["mode"], "start_s": a * EP, "end_s": b * EP},
                    "lights_off_clock": job.lights_off_clock,
                    "lights_off_source": job.lights_off_source,
                    "lights_off_epoch": lo_epoch,
                },
                "epochs": ep,
                "metrics": {
                    "predicted": metrics.architecture(ep["stage"], lo_epoch),
                    "reference": metrics.architecture(ref, lo_epoch) if ref is not None else None,
                },
                "agreement": {"predicted": metrics.agreement(ep["stage"], ref)} if ref is not None else None,
                "quality": {
                    "file": {
                        "name": job.source.file_name,
                        "size_mb": job.source.size_mb,
                        "start": h.get("start"),
                        "start_clock_s": h.get("start_clock_s"),
                        "total_duration_s": h["duration_s"],
                        "channels": h["n_channels"],
                        "sampling_hz": sfreq,
                    },
                    "composition": _composition(h, a, b),
                    "reference_unscored": int((ref < 0).sum()) if ref is not None else None,
                },
                "dataset": job.source.dataset,
                "source_info": {"type": job.source.type, "id": job.source.id, "label": job.source.label,
                                "subset": job.source.subset,
                                "location": catalog.get_catalog().source["location"] if job.source.type == "catalog" else None},
            }
            steps.done("flag", f"{rev['flagged']} de {n} épocas marcadas ({_es(100 * rev['flagged_fraction'])} %)"
                       + (" · se sugiere revisión completa" if rev["whole_night_recommended"] else ""))

        # 5 · guardar todo de una vez; la señal pasa a su lugar solo si se guarda
        with steps.run("save"):
            detail["quality"]["timings"] = {**timings, "total_s": round(time.perf_counter() - t0, 2),
                                            **{f"model_{k}": v for k, v in res.timings.items() if k != "model_s"}}
            signals.remove(final_dir)
            tmp_dir.replace(final_dir)
            steps.done("save", "Lista para revisar", save=False)
            db.finish(rid, {**summary, "model_version": info.version, "finished_at": detail["finished_at"]},
                      detail, rev, str(final_dir), steps.progress)
        ok = True
        log.info("Análisis %s listo: %s · %d épocas · %d marcadas (%.1f s)",
                 rid, combo, n, rev["flagged"], time.perf_counter() - t0)
    except Exception as e:
        if not isinstance(e, KNOWN_ERRORS):
            log.exception("Análisis %s falló", rid)
        why = reason(e)
        steps.failed(why)
        signals.remove(tmp_dir)
        signals.remove(final_dir)
        db.fail(rid, why, steps.progress)
    finally:
        if ok and job.source.type == "upload":
            uploads.delete(job.source.id)       # la señal de la ventana ya quedó guardada


def seed(created_by: str = "Sistema") -> int:
    """Base vacía: lanza unos análisis de muestra con noches del catálogo (si están)."""
    import uuid

    n = 0
    try:
        nights = catalog.get_catalog().nights()
    except catalog.CatalogError as e:
        log.warning("Sin análisis de muestra: %s", e)
        return 0
    for s in config.SEED_ANALYSES:
        night = next((x for x in nights if x["psg"] == s["psg"] and not x["subset"]), None)
        if not night:
            continue
        try:
            spec = {"source": {"type": "catalog", "id": night["id"]}, "channels": s["channels"]}
            create(prepare(uuid.uuid4().hex[:12], spec, created_by))
            n += 1
        except Exception as e:  # una semilla rota no debe tumbar la API
            log.warning("No se pudo sembrar %s: %s", s, e)
    return n
