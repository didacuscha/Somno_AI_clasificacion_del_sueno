"""API de SomnoAI v2 — implementa docs/API_CONTRACT.md.

Arranque:  ./run.sh   (equivale a: uvicorn app.main:app --port 8000)
Con la base vacía y las noches demo en el catálogo, lanza unos análisis de muestra.
La API también sirve el tablero (frontend/) en http://localhost:8000/.
"""
import base64
import csv
import hashlib
import hmac
import io
import json
import logging
import os
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import catalog, channels as ch
from . import config, db, jobs, signals, uploads
from .model.adapter import get_adapter
from .pipeline import edf_io, review, spectral

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("somnoai.api")
API = "/api/v1"


def _err(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init()
    if n := jobs.recover_interrupted():
        log.warning("%d análisis interrumpidos por el reinicio quedaron como fallidos (se pueden reintentar)", n)
    if n := uploads.purge_stale():
        log.info("%d cargas sin analizar borradas", n)
    info = get_adapter().info()
    log.info("Modelo activo: %s · %s (%s)", info.name, info.version, info.kind)
    log.info("Catálogo de noches: %s", catalog.get_catalog().source["location"])
    if config.SEED_DEMOS and db.count() == 0:
        jobs.seed()
    log.info("SomnoAI API lista · %d registros en la base", db.count())
    yield


app = FastAPI(title="SomnoAI v2 API", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.exception_handler(HTTPException)
async def http_exc(_, exc: HTTPException):
    detail = exc.detail if isinstance(exc.detail, dict) else {"code": "error", "message": str(exc.detail)}
    return JSONResponse(status_code=exc.status_code, content={"error": detail})


@app.get(f"{API}/health")
def health():
    """Sin auth: para el healthcheck de Docker Compose y monitoreo."""
    info = get_adapter().info()
    return {"status": "ok", "records": db.count(),
            "model": {"kind": info.kind, "name": info.name, "version": info.version}}


# ── sesión ────────────────────────────────────────────────────────────
# Token firmado (usuario|vencimiento|HMAC): sobrevive a reinicios de la API.
def _public_user(username: str) -> dict:
    u = config.USERS[username]
    name = u.get("name", username)
    initials = u.get("initials") or "".join(w[0] for w in name.split()[:2]).upper()
    return {"username": username, "name": name, "initials": initials}


def _sign(msg: str) -> str:
    return hmac.new(config.SECRET, msg.encode(), hashlib.sha256).hexdigest()


class LoginBody(BaseModel):
    username: str
    password: str


@app.post(f"{API}/auth/login")
def login(body: LoginBody):
    username = body.username.strip()
    user = config.USERS.get(username)
    if not user or not hmac.compare_digest(body.password, user["password"]):
        raise _err(401, "invalid_credentials", "Usuario o contraseña incorrectos.")
    msg = f"{username}|{int(time.time()) + config.TOKEN_HOURS * 3600}"
    token = base64.urlsafe_b64encode(f"{msg}|{_sign(msg)}".encode()).decode()
    return {"token": token, "user": _public_user(username)}


def auth(authorization: str = Header(default="")) -> dict:
    try:
        raw = base64.urlsafe_b64decode(authorization.removeprefix("Bearer ").strip().encode()).decode()
        username, exp, mac = raw.rsplit("|", 2)
        ok = (hmac.compare_digest(mac, _sign(f"{username}|{exp}"))
              and int(exp) > time.time() and username in config.USERS)
    except Exception:
        ok = False
    if not ok:
        raise _err(401, "unauthorized", "La sesión expiró. Inicie sesión de nuevo.")
    return _public_user(username)


# ── configuración y catálogo ──────────────────────────────────────────
@app.get(f"{API}/config")
def get_config(_: dict = Depends(auth)):
    """Reglas del modelo (las reporta el adaptador) y catálogo de canales: el tablero no las duplica."""
    info = get_adapter().info()
    return {
        "stages": config.STAGES,
        "epoch_s": config.EPOCH_S,
        "channels": config.CHANNELS,
        "channel_aliases": config.CHANNEL_ALIASES,
        "channel_kinds": config.CHANNEL_KINDS,
        "confidence_threshold": info.threshold,
        "night_review_fraction": info.night_review_fraction,
        "mf1_goal": config.MF1_GOAL,
        "window_margin_min": config.WINDOW_MARGIN_EPOCHS * config.EPOCH_S // 60,
        "min_window_min": config.MIN_WINDOW_EPOCHS * config.EPOCH_S // 60,
        "expected": info.expected,
        "expected_source": info.expected_source,
        "max_upload_mb": config.MAX_UPLOAD_MB,
        "max_note_chars": config.MAX_NOTE_CHARS,
        "model": info.public(),
        "bands": config.SPECTRAL_BANDS,
        "steps": [{"key": k, "label": label} for k, label in jobs.STEPS],
        "catalog": catalog.get_catalog().source,
    }


@app.get(f"{API}/catalog")
def list_catalog(refresh: bool = False, _: dict = Depends(auth)):
    """Noches del catálogo (S3 o carpeta local) con sus canales, sin descargarlas."""
    cat = catalog.get_catalog()
    try:
        nights = cat.nights(refresh=refresh)
    except catalog.CatalogError as e:
        raise _err(502, "catalog_unavailable", str(e))
    return {"source": cat.source, "nights": [catalog.public(n) for n in nights]}


# ── cargas propias (PSG .edf) ─────────────────────────────────────────
def _upload_error(e: Exception) -> HTTPException:
    if isinstance(e, uploads.UploadNotFound):
        return _err(404, "not_found", "La carga no existe o ya se borró: suba el archivo de nuevo.")
    return _err(422, "invalid_file", str(e))


@app.post(f"{API}/uploads", status_code=201)
def create_upload(file: UploadFile, hypnogram: UploadFile | None = File(None), user: dict = Depends(auth)):
    """Guarda y valida un PSG: responde con los canales encontrados (o con lo que está mal)."""
    try:
        return uploads.create(file.file, file.filename, hypnogram.file if hypnogram else None,
                              hypnogram.filename if hypnogram else None, user["name"])
    except (edf_io.InvalidFile, uploads.UploadNotFound) as e:
        raise _upload_error(e)


@app.get(f"{API}/uploads/{{upload_id}}")
def get_upload(upload_id: str, _: dict = Depends(auth)):
    try:
        return uploads.describe(upload_id)
    except (edf_io.InvalidFile, uploads.UploadNotFound) as e:
        raise _upload_error(e)


@app.post(f"{API}/uploads/{{upload_id}}/hypnogram")
def attach_hypnogram(upload_id: str, file: UploadFile, _: dict = Depends(auth)):
    try:
        return uploads.attach_hypnogram(upload_id, file.file, file.filename)
    except (edf_io.InvalidFile, uploads.UploadNotFound) as e:
        raise _upload_error(e)


@app.delete(f"{API}/uploads/{{upload_id}}/hypnogram")
def remove_hypnogram(upload_id: str, _: dict = Depends(auth)):
    try:
        return uploads.remove_hypnogram(upload_id)
    except (edf_io.InvalidFile, uploads.UploadNotFound) as e:
        raise _upload_error(e)


@app.delete(f"{API}/uploads/{{upload_id}}")
def delete_upload(upload_id: str, _: dict = Depends(auth)):
    if db.upload_in_use(upload_id):
        raise _err(409, "in_use", "Esta carga pertenece a un análisis; se borra al borrar el registro.")
    uploads.delete(upload_id)
    return {"deleted": upload_id}


# ── análisis ──────────────────────────────────────────────────────────
class SourceRef(BaseModel):
    type: str                          # catalog | upload
    id: str


class AnalysisBody(BaseModel):
    source: SourceRef
    channels: list[str]
    channel_map: dict[str, str] | None = None
    window_mode: str | None = None     # reference | range | full
    start_clock: str | None = None
    end_clock: str | None = None
    lights_off: str | None = None      # None → índice de Sleep-EDFx; "none" → sin apagado de luces


def _job_error(e: Exception) -> HTTPException:
    if isinstance(e, ch.InvalidSelection):
        return _err(422, "invalid_channels", str(e))
    if isinstance(e, catalog.NightNotFound):
        return _err(404, "not_found", str(e))
    if isinstance(e, catalog.CatalogError):
        return _err(502, "catalog_unavailable", str(e))
    if isinstance(e, uploads.UploadNotFound):
        return _err(404, "not_found", "La carga no existe o ya se borró: suba el archivo de nuevo.")
    return _err(422, "invalid_file", str(e))


_JOB_ERRORS = (edf_io.InvalidFile, ch.InvalidSelection, catalog.CatalogError, uploads.UploadNotFound)


def start_analysis(body: AnalysisBody, created_by: str) -> dict:
    spec = body.model_dump()
    try:
        job = jobs.prepare(uuid.uuid4().hex[:12], spec, created_by)
    except _JOB_ERRORS as e:
        raise _job_error(e)
    return jobs.create(job)


@app.post(f"{API}/analyses", status_code=202)
def create_analysis(body: AnalysisBody, user: dict = Depends(auth)):
    return start_analysis(body, user["name"])


# ── registros ─────────────────────────────────────────────────────────
def _summary(row: dict) -> dict:
    return {**row["summary"], "status": row["status"], "progress": row["progress"],
            "error": row["error"], "review": row["review"], "attempts": row.get("attempts", 1)}


def _get(record_id: str) -> dict:
    row = db.get(record_id)
    if not row:
        raise _err(404, "not_found", "El registro no existe.")
    return row


def _get_done(record_id: str) -> dict:
    row = _get(record_id)
    if row["status"] != "done":
        raise _err(409, "not_ready", "El análisis todavía no termina.")
    return row


def _dynamic(row: dict) -> dict:
    """Lo que depende de las decisiones del revisor: se calcula en cada lectura."""
    detail, rid = row["detail"], row["id"]
    corr = db.corrections(rid)
    der = review.derived(detail, {e: c["stage"] for e, c in corr.items()})
    return {
        "final": der["final"],
        "metrics_final": der["metrics_final"],
        "agreement_final": der["agreement_final"],
        "corrections": list(corr.values()),
        "review": row["review"],
        "history": db.history(rid, 200),
        "notes": db.notes(rid),
    }


@app.get(f"{API}/records")
def list_records(_: dict = Depends(auth)):
    return {"records": [_summary(r) for r in db.list_all()]}


@app.get(f"{API}/records/{{record_id}}")
def get_record(record_id: str, _: dict = Depends(auth)):
    row = _get(record_id)
    if row["status"] != "done":
        return _summary(row)
    d = {**row["detail"], "status": "done", "progress": row["progress"], "attempts": row.get("attempts", 1)}
    dyn = _dynamic(row)
    d["epochs"]["final"] = dyn["final"]
    d["metrics"]["final"] = dyn["metrics_final"]
    if d.get("agreement"):
        d["agreement"]["final"] = dyn["agreement_final"]
    d.update(corrections=dyn["corrections"], review=dyn["review"], history=dyn["history"], notes=dyn["notes"])
    return d


@app.delete(f"{API}/records/{{record_id}}")
def delete_record(record_id: str, _: dict = Depends(auth)):
    row = _get(record_id)
    if row["status"] in ("queued", "running"):
        raise _err(409, "busy", "El análisis está en curso: espere a que termine para borrarlo.")
    db.delete(record_id)
    signals.remove(row["signal_dir"])
    src = (row.get("spec") or {}).get("source") or {}
    if src.get("type") == "upload" and not db.upload_in_use(src.get("id", "")):
        uploads.delete(src.get("id", ""))
    return {"deleted": record_id}


@app.post(f"{API}/records/{{record_id}}/retry", status_code=202)
def retry_record(record_id: str, user: dict = Depends(auth)):
    """Vuelve a lanzar un análisis fallido con la misma configuración."""
    row = _get(record_id)
    if row["status"] != "failed":
        raise _err(409, "not_failed", "Solo se puede reintentar un análisis que falló.")
    if not row.get("spec"):
        raise _err(409, "no_spec", "Este análisis es de una versión anterior y no guardó su configuración: "
                                   "lance uno nuevo desde «Analizar nuevo».")
    try:
        return jobs.retry(record_id, user["name"])
    except _JOB_ERRORS as e:
        raise _job_error(e)


@app.get(f"{API}/records/{{record_id}}/signal")
def get_signal(record_id: str, start_s: float, duration_s: float, points: int = 1000,
               channels: str = "", _: dict = Depends(auth)):
    row = _get_done(record_id)
    sig_dir = Path(row["signal_dir"] or "")
    if not (sig_dir / "meta.json").exists():
        raise _err(404, "not_found", "La señal de este registro no está disponible.")
    if not (1 <= points <= 4000) or duration_s <= 0:
        raise _err(422, "out_of_range", "Parámetros de ventana inválidos.")
    stored = signals.meta(sig_dir)["channels"]
    wanted = [c for c in channels.replace(" ", "").split(",") if c in stored] or stored
    window_s = row["detail"]["night"]["n_epochs"] * config.EPOCH_S
    start_s = max(0.0, min(start_s, window_s))
    duration_s = min(duration_s, window_s - start_s) or 1.0
    traces = {}
    for slot in wanted:
        mins, maxs = signals.envelope(sig_dir, slot, start_s, duration_s, points)
        traces[slot] = {"min": mins, "max": maxs}
    return {"start_s": start_s, "duration_s": duration_s, "points": points, "unit": "µV", "traces": traces}


# ── evidencia de la señal (US-11) ─────────────────────────────────────
_BANDS_KEY = hashlib.sha1(json.dumps(config.SPECTRAL_BANDS, sort_keys=True).encode()).hexdigest()[:8]


@app.get(f"{API}/records/{{record_id}}/epochs/{{epoch}}/evidence")
def epoch_evidence(record_id: str, epoch: int, channel: str | None = None, _: dict = Depends(auth)):
    """Potencia relativa por banda del EEG en la época, con el perfil típico de cada
    estadio en esta misma noche para comparar."""
    row = _get_done(record_id)
    d = row["detail"]
    n, EP = d["night"]["n_epochs"], d["night"]["epoch_s"]
    if not 0 <= epoch < n:
        raise _err(422, "out_of_range", f"La época {epoch} no existe (hay {n}).")
    sig_dir = Path(row["signal_dir"] or "")
    if not (sig_dir / "meta.json").exists():
        raise _err(404, "not_found", "La señal de este registro no está disponible.")
    stored = signals.meta(sig_dir)["channels"]
    eeg = [s for s in stored if config.CHANNELS.get(s, {}).get("kind") == "eeg"]
    if not eeg:
        raise _err(404, "no_eeg", "Este registro no tiene un EEG guardado para calcular la evidencia.")
    channel = channel or next((s for s in d["channels"]["selected"] if s in eeg), eeg[0])
    if channel not in eeg:
        raise _err(422, "invalid_channel", f"Elija un EEG de este registro: {', '.join(eeg)}.")
    powers = signals.cached(sig_dir, f"bands_{channel}_{_BANDS_KEY}",
                            lambda: spectral.band_powers(*signals.epochs(sig_dir, channel, n, EP)))
    corr = {e: c["stage"] for e, c in db.corrections(record_id).items()}
    ep = d["epochs"]
    final = review.final_stages(ep["stage"], corr)
    thr = d["model"]["threshold"]
    trusted = [i in corr or ep["confidence"][i] >= thr for i in range(len(final))]
    typical = spectral.typical_profiles(powers, final[:len(powers)], trusted[:len(powers)])
    row_i = powers[epoch] if epoch < len(powers) else [float("nan")] * len(config.SPECTRAL_BANDS)
    val = lambda v: None if v is None or v != v else round(float(v), 4)  # noqa: E731
    cands = [ep["stage"][epoch], ep["second"][epoch]]
    near = spectral.closest(row_i, typical, cands)
    return {
        "epoch": epoch,
        "channel": channel,
        "channel_name": config.CHANNELS[channel]["name"],
        "file_label": d["channels"]["available"].get(channel),
        "channels": eeg,
        "fs": signals.meta(sig_dir)["sfreq"],
        "bands": [{**b, "value": val(row_i[j])} for j, b in enumerate(config.SPECTRAL_BANDS)],
        "typical": {config.STAGES[k]: v for k, v in typical.items()},
        "candidates": cands,
        "closest": near,               # candidato con el perfil típico más parecido (o None)
        "method": "Potencia relativa del EEG por banda (Welch, ventanas de 4 s) entre 0,5 y 30 Hz.",
    }


# ── revisión del especialista ─────────────────────────────────────────
class EpochChange(BaseModel):
    epoch: int
    stage: int | None                  # None = volver a la predicción del modelo


class EpochsBody(BaseModel):
    changes: list[EpochChange]


def _review_payload(row: dict) -> dict:
    dyn = _dynamic(row)
    return {"final": dyn["final"], "metrics_final": dyn["metrics_final"],
            "agreement_final": dyn["agreement_final"], "corrections": dyn["corrections"],
            "review": dyn["review"], "history": dyn["history"], "notes": dyn["notes"]}


def _finalized(row: dict) -> dict:
    rv = row["review"] or {}
    return {"by": rv.get("finalized_by"), "at": rv.get("finalized_at")} if rv.get("finalized_by") else {}


@app.patch(f"{API}/records/{{record_id}}/epochs")
def change_epochs(record_id: str, body: EpochsBody, user: dict = Depends(auth)):
    """Confirmar (mismo estadio que el modelo), corregir o volver a la predicción del modelo."""
    row = _get_done(record_id)
    if (row["review"] or {}).get("status") == "finalized":
        raise _err(409, "review_locked", "La revisión está finalizada. Reábrala para hacer cambios.")
    detail = row["detail"]
    n = detail["night"]["n_epochs"]
    pred = detail["epochs"]["stage"]
    current = {e: c["stage"] for e, c in db.corrections(record_id).items()}
    changes = []
    for c in body.changes:
        if not 0 <= c.epoch < n:
            raise _err(422, "out_of_range", f"La época {c.epoch} no existe (hay {n}).")
        if c.stage is not None and not 0 <= c.stage < len(config.STAGES):
            raise _err(422, "invalid_stage", "Estadio inválido: use 0=W, 1=N1, 2=N2, 3=N3, 4=REM.")
        if c.stage is None and c.epoch not in current:
            continue                    # ya estaba como la predijo el modelo
        changes.append((c.epoch, c.stage, current.get(c.epoch, pred[c.epoch]), pred[c.epoch]))
        if c.stage is None:
            current.pop(c.epoch, None)
        else:
            current[c.epoch] = c.stage
    if changes:
        db.apply_changes(record_id, changes, user["name"])
    db.set_review(record_id, review.state(detail["epochs"], current, {}, detail["model"]["night_review_fraction"]))
    return _review_payload(db.get(record_id))


@app.get(f"{API}/records/{{record_id}}/changes")
def review_changes(record_id: str, _: dict = Depends(auth)):
    """Resumen antes de finalizar (US-14): confirmadas, corregidas y la lista de cambios."""
    row = _get_done(record_id)
    return {**review.changes(row["detail"], db.corrections(record_id)), "review": row["review"]}


class ReviewBody(BaseModel):
    action: str                        # finalize | reopen
    expected_corrected: int | None = None   # cambios que vio el revisor en el resumen


@app.post(f"{API}/records/{{record_id}}/review")
def review_action(record_id: str, body: ReviewBody, user: dict = Depends(auth)):
    row = _get_done(record_id)
    if body.action not in ("finalize", "reopen"):
        raise _err(422, "invalid_action", "Acción desconocida: use finalize o reopen.")
    detail, rv = row["detail"], row["review"] or {}
    corr_rows = db.corrections(record_id)
    corr = {e: c["stage"] for e, c in corr_rows.items()}
    frac = detail["model"]["night_review_fraction"]
    if body.action == "finalize":
        if rv.get("status") == "finalized":
            raise _err(409, "already_finalized", "La revisión ya está finalizada.")
        summary = review.changes(detail, corr_rows)
        if body.expected_corrected is not None and body.expected_corrected != summary["corrected"]:
            raise _err(409, "stale_summary", f"Los cambios de esta noche cambiaron mientras veía el resumen "
                                             f"(ahora son {summary['corrected']}). Revise el resumen de nuevo.")
        new = review.state(detail["epochs"], corr, {"by": user["name"], "at": db.now()}, frac)
    else:
        if rv.get("status") != "finalized":
            raise _err(409, "not_finalized", "La revisión no está finalizada.")
        new = review.state(detail["epochs"], corr, {}, frac)
    db.set_review(record_id, new)
    db.log_action(record_id, user["name"], body.action, rv.get("status"), new["status"])
    return _review_payload(db.get(record_id))


# ── notas del técnico (US-15) ─────────────────────────────────────────
class NoteBody(BaseModel):
    text: str


@app.post(f"{API}/records/{{record_id}}/notes", status_code=201)
def add_note(record_id: str, body: NoteBody, user: dict = Depends(auth)):
    row = _get_done(record_id)
    text = body.text.strip()
    if not text:
        raise _err(422, "empty_note", "Escriba la nota antes de guardarla.")
    if len(text) > config.MAX_NOTE_CHARS:
        raise _err(422, "note_too_long", f"La nota supera los {config.MAX_NOTE_CHARS} caracteres.")
    db.add_note(row["id"], user["name"], text)
    return {"notes": db.notes(record_id), "history": db.history(record_id, 200)}


# ── exportación ───────────────────────────────────────────────────────
def _clock(clock_s: float | None) -> str:
    if clock_s is None:
        return ""
    s = int(clock_s) % 86400
    return f"{s // 3600:02d}:{s // 60 % 60:02d}:{s % 60:02d}"


def _csv_response(rows: list[list], header: list[str], filename: str) -> Response:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(header)
    w.writerows(rows)
    return Response(buf.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@app.get(f"{API}/records/{{record_id}}/export.csv")
def export_record(record_id: str, _: dict = Depends(auth)):
    """Hipnograma por época: predicción, probabilidades, revisión y estadio final."""
    row = _get_done(record_id)
    d = row["detail"]
    ep, night, st = d["epochs"], d["night"], config.STAGES
    corr = db.corrections(record_id)
    ref = ep.get("reference")
    rows = []
    for i in range(night["n_epochs"]):
        c = corr.get(i)
        final = c["stage"] if c else ep["stage"][i]
        status = "" if not c else ("confirmada" if c["stage"] == ep["stage"][i] else "corregida")
        if not status and ep["review"][i]:
            status = "pendiente"
        clock = night["start_clock_s"] + i * config.EPOCH_S if night["start_clock_s"] is not None else None
        rows.append([i, _clock(clock), (night["start_epoch"] + i) * config.EPOCH_S, st[ep["stage"][i]],
                     ep["confidence"][i], st[ep["second"][i]], *ep["probs"][i], ep["review"][i],
                     st[final], status, c["author"] if c else "",
                     (st[ref[i]] if ref[i] >= 0 else "?") if ref else ""])
    header = ["epoca", "hora", "inicio_s", "prediccion", "confianza", "segunda_opcion",
              *[f"p_{s}" for s in st], "marcada_revisar", "estadio_final", "revision", "revisado_por",
              "referencia"]
    return _csv_response(rows, header, f"{Path(d['file_name']).stem}_{d['combination']}_{record_id}.csv")


@app.get(f"{API}/corrections/export.csv")
def export_corrections(_: dict = Depends(auth)):
    """Todas las épocas que corrigió o confirmó un especialista: insumo para reentrenar."""
    rows, details = [], {}
    for c in db.all_corrections():
        rid = c["record_id"]
        if rid not in details:
            details[rid] = db.get(rid)["detail"]
        d = details[rid]
        ep, i, st = d["epochs"], c["epoch"], config.STAGES
        ref = ep.get("reference")
        rows.append([rid, d["file_name"], d["subject_code"], d["combination"], d["model_version"], i,
                     (d["night"]["start_epoch"] + i) * config.EPOCH_S, st[ep["stage"][i]],
                     ep["confidence"][i], ep["review"][i], st[c["stage"]], c["author"], c["at"],
                     (st[ref[i]] if ref[i] >= 0 else "?") if ref else ""])
    header = ["registro", "archivo", "sujeto", "combinacion", "version_modelo", "epoca", "inicio_s",
              "prediccion", "confianza", "marcada_revisar", "estadio_especialista", "autor", "fecha",
              "referencia"]
    return _csv_response(rows, header, "correcciones_somnoai.csv")


# ── tablero ───────────────────────────────────────────────────────────
# Servir el frontend desde la misma API evita CORS y un segundo proceso en local.
class _Frontend(StaticFiles):
    """El HTML se revalida siempre (ETag → 304 si no cambió): tras un despliegue, recargar
    trae la versión nueva. Los scripts se versionan con ?v=N en index.html."""

    async def get_response(self, path, scope):
        res = await super().get_response(path, scope)
        if res.headers.get("content-type", "").startswith("text/html"):
            res.headers["Cache-Control"] = "no-cache"
        return res


_FRONT = Path(os.environ.get("SOMNOAI_FRONTEND_DIR", config.BASE_DIR.parent / "frontend"))
if _FRONT.is_dir():
    app.mount("/", _Frontend(directory=_FRONT, html=True), name="frontend")
