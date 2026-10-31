"""API de SomnoAI v2 — implementa docs/API_CONTRACT.md.

Arranque:  ./run.sh   (equivale a: uvicorn app.main:app --port 8000)
Con la base vacía y las noches demo en data/demo/, lanza unos análisis de muestra.
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
import re
import shutil
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import channels as ch
from . import config, dataset, db, jobs, signals
from .model.client import get_client
from .pipeline import edf_io, review

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("somnoai.api")
API = "/api/v1"


def _err(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init()
    if n := db.mark_interrupted():
        log.warning("%d análisis interrumpidos por el reinicio quedaron como fallidos", n)
    log.info("Modelo activo: %s (%s)", get_client().version(), get_client().kind)
    if config.SEED_DEMOS and db.count() == 0:
        for seed in config.SEED_ANALYSES:
            if dataset.demo(seed["demo_id"]):
                try:
                    _start_demo(DemoBody(**seed), created_by="Sistema")
                except Exception as e:  # una semilla rota no debe tumbar la API
                    log.warning("No se pudo sembrar %s: %s", seed, e)
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
    client = get_client()
    return {"status": "ok", "records": db.count(), "model": {"kind": client.kind, "version": client.version()}}


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


# ── configuración y demos ─────────────────────────────────────────────
@app.get(f"{API}/config")
def get_config(_: dict = Depends(auth)):
    """Reglas del modelo y catálogo de canales: el tablero no las duplica."""
    client = get_client()
    return {
        "stages": config.STAGES,
        "epoch_s": config.EPOCH_S,
        "channels": config.CHANNELS,
        "channel_aliases": config.CHANNEL_ALIASES,
        "confidence_threshold": config.CONFIDENCE_THRESHOLD,
        "night_review_fraction": config.NIGHT_REVIEW_FRACTION,
        "mf1_goal": config.MF1_GOAL,
        "window_margin_min": config.WINDOW_MARGIN_EPOCHS * config.EPOCH_S // 60,
        "min_window_min": config.MIN_WINDOW_EPOCHS * config.EPOCH_S // 60,
        "expected": config.EXPECTED,
        "max_upload_mb": config.MAX_UPLOAD_MB,
        "model": {"kind": client.kind, "version": client.version()},
    }


@app.get(f"{API}/demos")
def list_demos(_: dict = Depends(auth)):
    out = []
    for d in dataset.demos():
        h = edf_io.read_header(str(config.DEMO_DIR / d["psg"]))
        out.append({**d, "header": {k: h[k] for k in ("labels", "fs", "start_clock_s", "duration_s")},
                    "detected": ch.detect(h["labels"])})
    return {"demos": out}


@app.get(f"{API}/dataset/lookup")
def dataset_lookup(file_name: str, _: dict = Depends(auth)):
    """Datos de una noche de Sleep-EDFx a partir del nombre del archivo (o null)."""
    return {"night": dataset.lookup(file_name)}


# ── análisis ──────────────────────────────────────────────────────────
def _lights_off(value: str | None, night: dict | None) -> tuple[str | None, str | None]:
    """None → la del índice de Sleep-EDFx si la hay; "none" → sin apagado de luces."""
    if value is None:
        return (night["lights_off"], "dataset-index") if night else (None, None)
    if value.strip().lower() in ("none", "-"):
        return None, None
    # el tablero prellena la del índice: si llega sin cambios, se registra con ese origen
    if night and value.strip() == night["lights_off"]:
        return value.strip(), "dataset-index"
    return value.strip(), "manual"


def _parse_channels(value) -> list[str]:
    items = value if isinstance(value, list) else re.split(r"[,\s]+", value or "")
    return [s for s in items if s]


def _save_upload(upload: UploadFile, dest: Path, limit_bytes: int) -> int:
    size = 0
    with open(dest, "wb") as out:
        while chunk := upload.file.read(1 << 20):
            size += len(chunk)
            if size > limit_bytes:
                raise _err(413, "too_large", f"El archivo supera el límite de {config.MAX_UPLOAD_MB} MB.")
            out.write(chunk)
    return size


@app.post(f"{API}/analyses", status_code=202)
def create_analysis(file: UploadFile, hypnogram: UploadFile | None = File(None),
                    channels: str = Form(...), channel_map: str | None = Form(None),
                    window_mode: str | None = Form(None), start_clock: str | None = Form(None),
                    end_clock: str | None = Form(None), lights_off: str | None = Form(None),
                    user: dict = Depends(auth)):
    name = Path(file.filename or "registro.edf").name
    if not re.search(r"\.(edf|zip)$", name, re.I):
        raise _err(422, "invalid_file", "Formato no aceptado: cargue un .edf o un .zip.")
    if hypnogram is not None and not re.search(r"\.edf$", hypnogram.filename or "", re.I):
        raise _err(422, "invalid_file", "El hipnograma debe ser un archivo .edf (EDF+ con anotaciones).")
    try:
        cmap = json.loads(channel_map) if channel_map else None
    except json.JSONDecodeError:
        raise _err(422, "invalid_channels", "channel_map debe ser un JSON {modalidad: etiqueta}.")

    rid = uuid.uuid4().hex[:12]
    updir = config.UPLOAD_DIR / rid
    updir.mkdir(parents=True)
    try:
        limit = config.MAX_UPLOAD_MB * 1048576
        size = _save_upload(file, updir / name, limit)
        if name.lower().endswith(".zip"):
            psg_path, hyp_path, psg_name = edf_io.extract_zip(str(updir / name), str(updir / "zip"))
        else:
            psg_path, hyp_path, psg_name = str(updir / name), None, name
        if hypnogram is not None:
            hyp_path = str(updir / ("ref-" + Path(hypnogram.filename).name))
            _save_upload(hypnogram, Path(hyp_path), limit)
        night = dataset.lookup(psg_name)
        lo_clock, lo_source = _lights_off(lights_off, night)
        job = jobs.prepare(
            record_id=rid, psg_path=psg_path, hyp_path=hyp_path, file_name=psg_name,
            size_mb=size / 1048576, source="upload", selected=_parse_channels(channels),
            channel_map=cmap, window_mode=window_mode, start_clock=start_clock, end_clock=end_clock,
            lights_off_clock=lo_clock, lights_off_source=lo_source, dataset=night,
            created_by=user["name"], cleanup_dir=str(updir))
    except edf_io.InvalidFile as e:
        shutil.rmtree(updir, ignore_errors=True)
        raise _err(422, "invalid_file", str(e))
    except ch.InvalidSelection as e:
        shutil.rmtree(updir, ignore_errors=True)
        raise _err(422, "invalid_channels", str(e))
    except BaseException:
        shutil.rmtree(updir, ignore_errors=True)
        raise
    return jobs.create(job)


class DemoBody(BaseModel):
    demo_id: str
    channels: list[str]
    channel_map: dict[str, str] | None = None
    window_mode: str | None = None
    start_clock: str | None = None
    end_clock: str | None = None
    lights_off: str | None = None       # None → índice de Sleep-EDFx; "none" → sin apagado de luces


def _start_demo(body: DemoBody, created_by: str) -> dict:
    demo = dataset.demo(body.demo_id)
    if not demo:
        raise _err(404, "not_found", "Registro demo desconocido o sin sus archivos en el servidor.")
    hyp = config.DEMO_DIR / demo["hypnogram"]
    lo_clock, lo_source = _lights_off(body.lights_off, demo)
    try:
        job = jobs.prepare(
            record_id=uuid.uuid4().hex[:12], psg_path=str(config.DEMO_DIR / demo["psg"]),
            hyp_path=str(hyp) if hyp.exists() else None, file_name=demo["psg"],
            size_mb=(config.DEMO_DIR / demo["psg"]).stat().st_size / 1048576, source="demo",
            selected=_parse_channels(body.channels), channel_map=body.channel_map,
            window_mode=body.window_mode, start_clock=body.start_clock, end_clock=body.end_clock,
            lights_off_clock=lo_clock, lights_off_source=lo_source, dataset=dataset.lookup(demo["psg"]),
            created_by=created_by)
    except edf_io.InvalidFile as e:
        raise _err(422, "invalid_file", str(e))
    except ch.InvalidSelection as e:
        raise _err(422, "invalid_channels", str(e))
    return jobs.create(job)


@app.post(f"{API}/analyses/demo", status_code=202)
def create_demo_analysis(body: DemoBody, user: dict = Depends(auth)):
    return _start_demo(body, created_by=user["name"])


# ── registros ─────────────────────────────────────────────────────────
def _summary(row: dict) -> dict:
    return {**row["summary"], "status": row["status"], "progress": row["progress"],
            "error": row["error"], "review": row["review"]}


def _get_done(record_id: str) -> dict:
    row = db.get(record_id)
    if not row:
        raise _err(404, "not_found", "El registro no existe.")
    if row["status"] != "done":
        raise _err(409, "not_ready", "El análisis todavía no termina.")
    return row


def _dynamic(row: dict) -> dict:
    """Lo que depende de las correcciones: se calcula en cada lectura."""
    detail, rid = row["detail"], row["id"]
    corr = db.corrections(rid)
    der = review.derived(detail, {e: c["stage"] for e, c in corr.items()})
    return {
        "final": der["final"],
        "metrics_final": der["metrics_final"],
        "agreement_final": der["agreement_final"],
        "corrections": list(corr.values()),
        "review": row["review"],
        "history": db.history(rid, 100),
    }


@app.get(f"{API}/records")
def list_records(_: dict = Depends(auth)):
    return {"records": [_summary(r) for r in db.list_all()]}


@app.get(f"{API}/records/{{record_id}}")
def get_record(record_id: str, _: dict = Depends(auth)):
    row = db.get(record_id)
    if not row:
        raise _err(404, "not_found", "El registro no existe.")
    if row["status"] != "done":
        return _summary(row)
    d = {**row["detail"], "status": "done"}
    dyn = _dynamic(row)
    d["epochs"]["final"] = dyn["final"]
    d["metrics"]["final"] = dyn["metrics_final"]
    if d.get("agreement"):
        d["agreement"]["final"] = dyn["agreement_final"]
    d.update(corrections=dyn["corrections"], review=dyn["review"], history=dyn["history"])
    return d


@app.delete(f"{API}/records/{{record_id}}")
def delete_record(record_id: str, _: dict = Depends(auth)):
    row = db.get(record_id)
    if not row:
        raise _err(404, "not_found", "El registro no existe.")
    if row["status"] in ("queued", "running"):
        raise _err(409, "busy", "El análisis está en curso: espere a que termine para borrarlo.")
    db.delete(record_id)
    signals.remove(row["signal_dir"])
    return {"deleted": record_id}


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
    wanted = [c for c in _parse_channels(channels) if c in stored] or stored
    window_s = row["detail"]["night"]["n_epochs"] * config.EPOCH_S
    start_s = max(0.0, min(start_s, window_s))
    duration_s = min(duration_s, window_s - start_s) or 1.0
    traces = {}
    for slot in wanted:
        mins, maxs = signals.envelope(sig_dir, slot, start_s, duration_s, points)
        traces[slot] = {"min": mins, "max": maxs}
    return {"start_s": start_s, "duration_s": duration_s, "points": points, "unit": "µV", "traces": traces}


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
            "review": dyn["review"], "history": dyn["history"]}


@app.patch(f"{API}/records/{{record_id}}/epochs")
def change_epochs(record_id: str, body: EpochsBody, user: dict = Depends(auth)):
    row = _get_done(record_id)
    if (row["review"] or {}).get("status") == "signed_off":
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
        changes.append((c.epoch, c.stage, current.get(c.epoch, pred[c.epoch])))
    if changes:
        db.apply_changes(record_id, changes, user["name"])
    corr = {e: c["stage"] for e, c in db.corrections(record_id).items()}
    db.set_review(record_id, review.state(detail["epochs"], corr, {},
                                          detail["model"]["night_review_fraction"]))
    return _review_payload(db.get(record_id))


class ReviewBody(BaseModel):
    action: str                        # sign_off | reopen


@app.post(f"{API}/records/{{record_id}}/review")
def review_action(record_id: str, body: ReviewBody, user: dict = Depends(auth)):
    row = _get_done(record_id)
    if body.action not in ("sign_off", "reopen"):
        raise _err(422, "invalid_action", "Acción desconocida: use sign_off o reopen.")
    detail = row["detail"]
    signed = {"by": user["name"], "at": db.now()} if body.action == "sign_off" else {}
    corr = {e: c["stage"] for e, c in db.corrections(record_id).items()}
    db.set_review(record_id, review.state(detail["epochs"], corr, signed,
                                          detail["model"]["night_review_fraction"]))
    db.log_action(record_id, user["name"], body.action)
    return _review_payload(db.get(record_id))


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
_FRONT = Path(os.environ.get("SOMNOAI_FRONTEND_DIR", config.BASE_DIR.parent / "frontend"))
if _FRONT.is_dir():
    app.mount("/", StaticFiles(directory=_FRONT, html=True), name="frontend")
