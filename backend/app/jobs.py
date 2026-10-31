"""Análisis en segundo plano.

POST /analyses valida al instante lo que se puede validar (formato, canales,
ventana) y responde 202; el análisis corre aquí, en otro hilo, porque el modelo
puede tardar minutos (el endpoint de SageMaker se apaga cuando no se usa). El
tablero consulta el registro hasta que su estado pasa a `done` o `failed`.
"""
import logging
import re
import shutil
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from . import channels, config, db, signals
from .model.client import ModelError, StagingRequest, check_result, get_client
from .pipeline import edf_io, hypnogram, metrics, review, window

log = logging.getLogger("somnoai.jobs")
_pool = ThreadPoolExecutor(max_workers=config.WORKERS, thread_name_prefix="analisis")
EP = config.EPOCH_S

STEPS = {
    "queued": "En cola",
    "reading": "Leyendo el registro",
    "staging": "Estadificando",
    "metrics": "Calculando métricas",
}


def progress(step: str, message: str | None = None) -> dict:
    return {"step": step, "label": STEPS[step], "message": message or STEPS[step]}


@dataclass
class Job:
    record_id: str
    psg_path: str
    file_name: str
    size_mb: float | None
    source: str                       # upload | demo
    header: dict
    selected: dict[str, str]          # modalidad → etiqueta del EDF (ya validada)
    reference: np.ndarray | None      # hipnograma de referencia del registro completo
    win: dict                         # {mode, start_epoch, end_epoch}
    lights_off_clock: str | None
    lights_off_s: float | None
    lights_off_source: str | None     # manual | dataset-index
    dataset: dict | None
    created_by: str
    cleanup_dir: str | None = None


def subject_code(file_name: str) -> str:
    m = re.match(r"SC4(\d\d)\d", file_name, re.I)       # convención Sleep-EDFx: SC4ssN
    return f"SC{m.group(1)}" if m else Path(file_name).stem[:8].upper()


def prepare(*, record_id: str, psg_path: str, hyp_path: str | None, file_name: str,
            size_mb: float | None, source: str, selected: list[str], channel_map: dict | None,
            window_mode: str | None, start_clock: str | None, end_clock: str | None,
            lights_off_clock: str | None, lights_off_source: str | None, dataset: dict | None,
            created_by: str, cleanup_dir: str | None = None) -> Job:
    """Todo lo que puede fallar por culpa de la entrada, antes de encolar el análisis."""
    header = edf_io.read_header(psg_path)
    if header["annotations_only"]:
        raise edf_io.InvalidFile("Ese archivo es solo un hipnograma (anotaciones, sin señal). "
                                 "Cargue el PSG, o un .zip con el par PSG + hipnograma.")
    mapping = channels.resolve(selected, channel_map, header["labels"])
    total = int(header["duration_s"] // EP)
    reference = hypnogram.read_reference(hyp_path, total, header["start"]) if hyp_path else None
    mode = window_mode or ("reference" if reference is not None else "full")
    win = window.resolve(mode, header, reference, start_clock, end_clock)
    lo_s = window.lights_off(lights_off_clock, header)
    if lo_s is not None and lo_s >= win["end_epoch"] * EP:
        if lights_off_source == "manual":
            raise edf_io.InvalidFile(f"La hora de apagado de luces ({lights_off_clock}) queda después "
                                     "del final de la ventana analizada.")
        lo_s = None                    # la del índice no corresponde a este recorte: se ignora
    return Job(record_id=record_id, psg_path=psg_path, file_name=file_name, size_mb=size_mb,
               source=source, header=header, selected=mapping, reference=reference, win=win,
               lights_off_clock=lights_off_clock if lo_s is not None else None, lights_off_s=lo_s,
               lights_off_source=lights_off_source if lo_s is not None else None,
               dataset=dataset, created_by=created_by, cleanup_dir=cleanup_dir)


def base_summary(job: Job) -> dict:
    slots = channels.ordered(job.selected)
    patient = job.header["patient"]
    ds = job.dataset or {}
    return {
        "id": job.record_id,
        "created_at": db.now(),
        "created_by": job.created_by,
        "source": job.source,
        "file_name": job.file_name,
        "subject_code": subject_code(job.file_name),
        "sex": patient["sex"] or ds.get("sex"),
        "age": patient["age"] or ds.get("age"),
        "channels": slots,
        "combination": channels.combination_key(slots),
        "combination_name": channels.combination_name(slots),
        "window_mode": job.win["mode"],
        "n_epochs": job.win["end_epoch"] - job.win["start_epoch"],
        "has_reference": job.reference is not None,
        "dataset_split": ds.get("split"),
        "model_version": get_client().version(),
    }


def create(job: Job) -> dict:
    """Registra el análisis como «en cola» y lo lanza. Devuelve el resumen."""
    summary = base_summary(job)
    db.insert(job.record_id, summary, progress("queued"))
    _pool.submit(_run, job, summary)
    return {**summary, "status": "queued", "progress": progress("queued")}


def _composition(header: dict, a: int, b: int) -> list[dict]:
    hours = lambda epochs: round(epochs * EP / 3600, 2)  # noqa: E731
    total = header["duration_s"] / EP
    return [seg for seg in (
        {"label": "Antes de la ventana", "hours": hours(a), "kind": "outside"},
        {"label": "Ventana analizada", "hours": hours(b - a), "kind": "window"},
        {"label": "Después de la ventana", "hours": hours(total - b), "kind": "outside"},
    ) if seg["hours"] > 0]


def _run(job: Job, summary: dict):
    rid, sig_dir = job.record_id, config.SIGNAL_DIR / job.record_id
    t0 = time.perf_counter()
    try:
        db.set_progress(rid, progress("reading"))
        h, a, b = job.header, job.win["start_epoch"], job.win["end_epoch"]
        n = b - a
        # El visor muestra todas las modalidades reconocibles del archivo, también
        # las que no se le dieron al modelo (el especialista puede querer verlas).
        # Si se asignó a mano una etiqueta a otra modalidad, esa etiqueta no se repite.
        used = set(job.selected.values())
        detected = {s: lab for s, lab in channels.detect(h["labels"]).items() if lab not in used}
        available = {**detected, **job.selected}
        available = {s: available[s] for s in channels.ordered(available)}
        series, sfreq = edf_io.load_signals(job.psg_path, list(available.values()), a * EP, b * EP)
        signals.save(sig_dir, {slot: series[label] for slot, label in available.items()}, sfreq)
        t_read = time.perf_counter()

        client = get_client()
        db.set_progress(rid, progress("staging", f"Estadificando con {client.version()}"))
        ref = job.reference[a:b] if job.reference is not None else None
        combo = channels.combination_key(job.selected)
        req = StagingRequest(
            record_id=rid, psg_path=job.psg_path, channels=job.selected,
            mask=channels.mask(job.selected), combination=combo, start_epoch=a, n_epochs=n,
            lights_off_s=job.lights_off_s,
            channel_fs={s: h["fs"].get(lab, 0.0) for s, lab in job.selected.items()},
            reference=ref if client.kind == "mock" else None)
        res = client.stage(req)
        probs = check_result(res, req)
        t_model = time.perf_counter()

        db.set_progress(rid, progress("metrics"))
        threshold = res.threshold or config.CONFIDENCE_THRESHOLD
        night_fraction = res.night_review_fraction or config.NIGHT_REVIEW_FRACTION
        epochs = review.decide(probs, threshold)
        epochs["reference"] = ref.tolist() if ref is not None else None
        lo_epoch = int(job.lights_off_s // EP) - a if job.lights_off_s is not None else None
        expected = config.EXPECTED[combo]

        detail = {
            **summary,
            "model_version": res.model_version,
            "finished_at": db.now(),
            "patient": {"age": summary["age"], "sex": summary["sex"],
                        "source": "edf-header" if h["patient"]["age"] else ("dataset-index" if summary["age"] else None)},
            "channels": {
                "selected": channels.ordered(job.selected),
                "combination": combo,
                "combination_name": channels.combination_name(job.selected),
                "mask": channels.mask(job.selected),
                "map": job.selected,
                "available": available,
                "file_labels": h["labels"],
                "fs": {s: h["fs"].get(lab, 0.0) for s, lab in available.items()},
            },
            "model": {
                "version": res.model_version,
                "kind": client.kind,
                "threshold": threshold,
                "night_review_fraction": night_fraction,
                "notes": res.notes,
                "expected": {**expected, "below_goal": expected["test_mf1"] < config.MF1_GOAL,
                             "goal_mf1": config.MF1_GOAL},
            },
            "night": {
                "epoch_s": EP,
                "n_epochs": n,
                "start_epoch": a,
                "start_clock_s": h["start_clock_s"] + a * EP if h["start_clock_s"] is not None else None,
                "window": {"mode": job.win["mode"], "start_s": a * EP, "end_s": b * EP},
                "lights_off_clock": job.lights_off_clock,
                "lights_off_source": job.lights_off_source,
                "lights_off_epoch": lo_epoch,
            },
            "epochs": epochs,
            "metrics": {
                "predicted": metrics.architecture(epochs["stage"], lo_epoch),
                "reference": metrics.architecture(ref, lo_epoch) if ref is not None else None,
            },
            "agreement": {"predicted": metrics.agreement(epochs["stage"], ref)} if ref is not None else None,
            "quality": {
                "file": {
                    "name": job.file_name,
                    "size_mb": round(job.size_mb, 1) if job.size_mb else None,
                    "start": h["start"],
                    "start_clock_s": h["start_clock_s"],
                    "total_duration_s": h["duration_s"],
                    "channels": h["n_channels"],
                    "sampling_hz": sfreq,
                },
                "composition": _composition(h, a, b),
                "reference_unscored": int((ref < 0).sum()) if ref is not None else None,
                "timings": {
                    "read_s": round(t_read - t0, 2),
                    "model_s": round(t_model - t_read, 2),
                    "total_s": round(time.perf_counter() - t0, 2),
                    **{f"model_{k}": v for k, v in res.timings.items()},
                },
            },
            "dataset": job.dataset,
        }
        rev = review.state(epochs, {}, {}, night_fraction)
        db.finish(rid, {**summary, "model_version": res.model_version, "finished_at": detail["finished_at"]},
                  detail, rev, str(sig_dir))
        log.info("Análisis %s listo: %s · %d épocas · %d marcadas (%.1f s)",
                 rid, combo, n, rev["flagged"], time.perf_counter() - t0)
    except (edf_io.InvalidFile, channels.InvalidSelection, ModelError) as e:
        signals.remove(str(sig_dir))
        db.fail(rid, str(e))
    except Exception as e:
        log.exception("Análisis %s falló", rid)
        signals.remove(str(sig_dir))
        db.fail(rid, f"Error interno al analizar el registro ({type(e).__name__}: {e}).")
    finally:
        if job.cleanup_dir:
            shutil.rmtree(job.cleanup_dir, ignore_errors=True)
