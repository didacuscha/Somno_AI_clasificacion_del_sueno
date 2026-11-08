"""Modelo del proyecto (stacking) por su API pública (SOMNOAI_MODEL=api).

El sistema del proyecto de grado (XGBoost + CNN/Transformer + meta-modelo) corre en un
endpoint asíncrono de SageMaker (`sistema-sueno`). Una función Lambda con URL pública lo
expone con token (repositorio del modelo, `despliegue/api/`):

    POST /subir           {"archivo": nombre}  → {"subir_a": URL firmada para un PUT, "s3_uri"}
    POST /analizar        {"s3_uri", "canales", "hora_apagado", "epoca_inicio", "epoca_fin"} → {"id"}
    GET  /resultado/<id>  → {"estado": "pendiente"} | {"estado": "listo", "resultado"} | {"estado": "error"}

Por cada noche este adaptador:
1. deja el EDF donde el endpoint lo puede leer: las noches de test de Sleep-EDFx ya están
   en el bucket del modelo (SOMNOAI_MODEL_NIGHTS); cualquier otra se sube con /subir. El
   endpoint busca los canales por su nombre de Sleep-EDF («EEG Fpz-Cz»…): si el archivo
   los llama distinto, se sube una copia con esas etiquetas cambiadas (mismas muestras);
2. pide la misma ventana, los mismos canales y el mismo apagado de luces del análisis;
3. espera la respuesta. Si el endpoint estaba apagado tarda ~8 min en prender, y el
   paso «Predecir» lo dice mientras tanto;
4. devuelve las 5 probabilidades de cada época: la app deriva todo lo demás.

Seguridad: el token (SOMNOAI_MODEL_TOKEN) solo vive en el servidor. No se registra en los
logs, no va en los mensajes de error y no llega al tablero. Las URL firmadas de /subir
tampoco se registran: llevan credenciales temporales de AWS.

El transporte (`ApiClient`) está separado del adaptador: un cliente que hable directo con
SageMaker (mismas peticiones y respuestas) se conecta sin tocar el resto.
"""
import json
import logging
import os
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable, Protocol

import numpy as np

from .. import config, dataset
from ..pipeline import edf_io
from .adapter import ModelError, ModelInfo, StagingRequest, StagingResult

log = logging.getLogger("somnoai.model.api")

# Nombres con que el endpoint busca cada entrada (sueno.config.CANALES del repositorio del modelo)
STANDARD = {"fpz": "EEG Fpz-Cz", "pz": "EEG Pz-Oz", "eog": "EOG horizontal", "emg": "EMG submental"}
STAGES = list(config.STAGES)                    # el endpoint usa el mismo orden: W, N1, N2, N3, REM
NIGHT_REVIEW_FRACTION = 0.2765                  # modelos/sistema.json del modelo v7 (aviso_noche_fraccion_revisar)
SLOW_WAIT_S = 45                                # pasado esto, el endpoint seguramente estaba apagado


class ApiError(ModelError):
    """Falla de la API del modelo; `status` es el código HTTP (None = no hubo conexión)."""

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status

    @property
    def transient(self) -> bool:
        return self.status is None or self.status >= 500 or self.status == 429


class ModelClient(Protocol):
    configured: bool

    def upload(self, path: str, name: str, on_progress: Callable[[int, int], None] | None = None) -> str: ...

    def submit(self, request: dict) -> str: ...

    def result(self, request_id: str) -> dict: ...


class _Reader:
    """Archivo que avisa cuánto se ha enviado (urllib lo lee por bloques)."""

    def __init__(self, fh, total: int, on_progress):
        self.fh, self.total, self.sent, self.on_progress = fh, total, 0, on_progress

    def read(self, n: int = -1) -> bytes:
        chunk = self.fh.read(n)
        self.sent += len(chunk)
        if self.on_progress and chunk:
            self.on_progress(self.sent, self.total)
        return chunk


class ApiClient:
    """La API pública del modelo: URL base + token Bearer."""

    def __init__(self, base: str | None = None, token: str | None = None, timeout_s: float = 60):
        self.base = (config.MODEL_API if base is None else base).rstrip("/")
        self.token = config.MODEL_TOKEN if token is None else token
        self.timeout_s = timeout_s

    @property
    def configured(self) -> bool:
        return bool(self.base and self.token)

    def _call(self, method: str, path: str, body: dict | None = None) -> dict:
        req = urllib.request.Request(
            self.base + path, method=method, data=json.dumps(body).encode() if body is not None else None,
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_s) as r:
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            raise _http_error(e.code, e.read()) from None
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            why = getattr(e, "reason", e)
            raise ApiError(f"No se pudo conectar con el servicio del modelo del proyecto ({why}).") from None
        except json.JSONDecodeError:
            raise ApiError("El servicio del modelo del proyecto respondió algo que no es JSON.", 502) from None

    def upload(self, path: str, name: str, on_progress=None) -> str:
        r = self._call("POST", "/subir", {"archivo": name})
        if "subir_a" not in r or "s3_uri" not in r:
            raise ApiError("El servicio del modelo no entregó dónde subir la noche.", 502)
        size = os.path.getsize(path)
        with open(path, "rb") as fh:
            # URL firmada de S3: va sin el token (S3 rechaza dos autenticaciones) y nunca al log
            put = urllib.request.Request(r["subir_a"], data=_Reader(fh, size, on_progress), method="PUT",
                                         headers={"Content-Length": str(size)})
            try:
                with urllib.request.urlopen(put, timeout=max(self.timeout_s, 600)):
                    pass
            except urllib.error.HTTPError as e:
                raise ApiError(f"No se pudo enviar la noche al modelo del proyecto (HTTP {e.code}).",
                               e.code) from None
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                raise ApiError(f"Se cortó el envío de la noche al modelo del proyecto "
                               f"({getattr(e, 'reason', e)}).") from None
        return r["s3_uri"]

    def submit(self, request: dict) -> str:
        r = self._call("POST", "/analizar", request)
        if not r.get("id"):
            raise ApiError("El servicio del modelo no devolvió el identificador de la petición.", 502)
        return str(r["id"])

    def result(self, request_id: str) -> dict:
        return self._call("GET", f"/resultado/{request_id}")


def _http_error(status: int, body: bytes) -> ApiError:
    try:
        detail = str(json.loads(body).get("error") or "")[:300]
    except (ValueError, AttributeError):
        detail = ""
    if status in (401, 403):
        return ApiError("El servicio del modelo del proyecto rechazó la credencial del servidor "
                        "(SOMNOAI_MODEL_TOKEN): hay que pedir un token nuevo.", status)
    if status >= 500 or status == 429:
        return ApiError(f"El servicio del modelo del proyecto no está disponible (HTTP {status}). "
                        "Puede estar apagado: reintente más tarde.", status)
    return ApiError(f"El servicio del modelo del proyecto rechazó la petición (HTTP {status})"
                    + (f": {detail}" if detail else "."), status)


def renames_for(selected: dict[str, str], labels: list[str]) -> dict[str, str]:
    """Etiquetas que hay que cambiar para que el endpoint encuentre cada entrada por su
    nombre de Sleep-EDF (y para que ningún otro canal se quede con ese nombre)."""
    out = {lab: STANDARD[slot] for slot, lab in selected.items() if lab != STANDARD[slot]}
    taken = set(out.values())
    for lab in labels:
        if lab in taken and lab not in out:
            out[lab] = f"x {lab}"[:16]
    return out


def clock(seconds: float) -> str:
    s = int(round(seconds)) % 86400
    return f"{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}"


def _mmss(seconds: float) -> str:
    return f"{int(seconds) // 60} min {int(seconds) % 60:02d} s"


class RemoteAdapter:
    def __init__(self, client: ModelClient | None = None, nights: str | None = None,
                 timeout_min: float | None = None, poll_s: float | None = None, sleep=time.sleep):
        self.client = client or ApiClient()
        self.nights = config.MODEL_NIGHTS if nights is None else nights
        self.timeout_s = 60 * (config.MODEL_TIMEOUT_MIN if timeout_min is None else timeout_min)
        self.poll_s = config.MODEL_POLL_S if poll_s is None else poll_s
        self._sleep = sleep
        self._info = ModelInfo(
            kind="proyecto", name="Modelo del proyecto (stacking)", version=config.MODEL_VERSION,
            threshold=config.CONFIDENCE_THRESHOLD, night_review_fraction=NIGHT_REVIEW_FRACTION,
            expected_source="Modelo del proyecto, Tabla IV del informe (v1, test de 16 sujetos); "
                            "la versión desplegada empata con la v1 (ΔMF1 −0,001)")
        if not self.client.configured:
            log.warning("SOMNOAI_MODEL=api sin SOMNOAI_MODEL_API o SOMNOAI_MODEL_TOKEN: los análisis fallarán "
                        "hasta configurarlos.")

    def info(self) -> ModelInfo:
        return self._info

    # ── dónde lee el endpoint la noche ────────────────────────────────
    def _known_night(self, source: Path) -> bool:
        """¿Es una noche de test de Sleep-EDFx sin tocar (la API ya la tiene)? Un PSG subido
        por el usuario nunca cuenta, aunque se llame igual."""
        if not self.nights or source.resolve().is_relative_to(config.UPLOAD_DIR.resolve()):
            return False
        ds = dataset.lookup(source.name)
        return bool(ds and ds["psg"] == source.name and ds["split"] == "test")

    def _stage_input(self, req: StagingRequest, header: dict, say) -> tuple[str, float]:
        source = Path(req.source)
        renames = renames_for(req.labels, header["labels"])
        if not renames and self._known_night(source):
            return self.nights + source.name, 0.0
        t0 = time.perf_counter()
        progress = lambda got, size: say(  # noqa: E731
            f"Enviando la noche al modelo del proyecto: {got / 1048576:.0f} de {size / 1048576:.0f} MB")
        say("Enviando la noche al modelo del proyecto")
        if not renames:
            uri = self.client.upload(str(source), source.name, progress)
        else:
            with tempfile.TemporaryDirectory(dir=config.STORE_DIR) as tmp:
                copy = Path(tmp) / source.name
                edf_io.relabel_edf(str(source), str(copy), renames)
                uri = self.client.upload(str(copy), source.name, progress)
        return uri, round(time.perf_counter() - t0, 2)

    # ── espera de la respuesta ────────────────────────────────────────
    def _wait(self, request_id: str, say) -> tuple[dict, float]:
        t0 = time.monotonic()
        failures = 0
        while True:
            elapsed = time.monotonic() - t0
            try:
                r = self.client.result(request_id)
                failures = 0
            except ApiError as e:
                failures += 1                       # un tropiezo de red no tumba una espera larga
                if not e.transient or failures >= 4:
                    raise
                r = {"estado": "pendiente"}
            state = r.get("estado")
            if state == "listo":
                if not isinstance(r.get("resultado"), dict):
                    raise ModelError("La respuesta del modelo del proyecto llegó sin resultado.")
                return r["resultado"], elapsed
            if state == "error":
                detail = str(r.get("error") or "sin detalle").strip()[:300]
                raise ModelError(f"El modelo del proyecto no pudo analizar esta noche: {detail}")
            if state != "pendiente":
                raise ModelError(f"El servicio del modelo respondió un estado desconocido ({state!r}).")
            if elapsed > self.timeout_s:
                raise ModelError(f"El modelo del proyecto no respondió en {self.timeout_s / 60:.0f} min. "
                                 "Puede estar apagado o con mucha carga: reintente más tarde.")
            say(f"Esperando al modelo del proyecto · {_mmss(elapsed)}"
                + (" · si estaba apagado tarda ~8 min en encender" if elapsed >= SLOW_WAIT_S else ""))
            self._sleep(self.poll_s)

    def predict(self, req: StagingRequest) -> StagingResult:
        if not self.client.configured:
            raise ModelError("El modelo del proyecto no está configurado en el servidor: faltan "
                             "SOMNOAI_MODEL_API y SOMNOAI_MODEL_TOKEN.")
        if not req.source:
            raise ModelError("El modelo del proyecto necesita el archivo EDF original y el análisis no lo tiene.")
        say = req.progress or (lambda message: None)
        t0 = time.perf_counter()
        header = edf_io.read_header(req.source)
        uri, upload_s = self._stage_input(req, header, say)

        first, last = req.start_epoch, req.start_epoch + req.n_epochs - 1
        request = {"s3_uri": uri, "canales": req.slots, "epoca_inicio": first, "epoca_fin": last}
        if req.lights_off_s is not None and header.get("start_clock_s") is not None:
            request["hora_apagado"] = clock(header["start_clock_s"] + req.lights_off_s)
        say("Pidiendo el análisis al modelo del proyecto")
        request_id = self.client.submit(request)
        log.info("Análisis %s enviado al modelo del proyecto (petición %s, %s, épocas %d–%d)",
                 req.record_id, request_id, "+".join(req.slots), first, last)
        res, waited = self._wait(request_id, say)

        if "probabilidades" not in res:
            raise ModelError("La respuesta del modelo del proyecto no trae las probabilidades por época.")
        probs = np.asarray(res["probabilidades"], dtype=float)
        got = res.get("epoca")
        if got is not None and len(got) and (len(got) != req.n_epochs or got[0] != first or got[-1] != last):
            raise ModelError(f"El modelo del proyecto analizó las épocas {got[0]}–{got[-1]} ({len(got)}) "
                             f"y la ventana es {first}–{last} ({req.n_epochs}).")
        if res.get("canales") is not None and list(res["canales"]) != req.slots:
            raise ModelError(f"El modelo del proyecto usó los canales {', '.join(res['canales'])} "
                             f"y se pidieron {', '.join(req.slots)}.")
        notes = []
        if waited >= 120:
            notes.append(f"El modelo del proyecto estaba apagado: tardó {_mmss(waited)} en encender y responder.")
        # el pipeline guarda cada una como model_<clave>; process_s = lo que tardó el modelo en su servidor
        timings = {"process_s": round(float(res.get("segundos_proceso") or 0), 2), "wait_s": round(waited, 1),
                   "upload_s": upload_s, "total_s": round(time.perf_counter() - t0, 1)}
        return StagingResult(stages=probs.argmax(axis=1) if probs.ndim == 2 else probs, probs=probs,
                             notes=notes, timings=timings)
