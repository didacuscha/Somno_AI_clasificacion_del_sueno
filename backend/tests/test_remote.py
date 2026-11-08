"""El adaptador del modelo del proyecto por su API pública (SOMNOAI_MODEL=api).

Sin red: un cliente falso para la lógica del adaptador y, para el cliente HTTP de
verdad, un servidor local que imita la API del repositorio del modelo
(despliegue/api/lambda_function.py): token Bearer, /subir con URL firmada para un PUT,
/analizar y /resultado/<id>.
"""
import json
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import pytest

from app import config
from app.model import adapter as model
from app.model.remote import ApiClient, ApiError, RemoteAdapter, clock, renames_for
from app.pipeline import edf_io
from conftest import API, START, wait_done
from edf_utils import synthetic_night, write_psg

NIGHT = "SC4001E0-PSG.edf"              # noche sintética del catálogo local (nombre de una noche de test)
SECRET = "token-secreto-de-prueba-9f3a"
NIGHTS = "s3://bucket-del-modelo/sistema-sueno/noches/"


# ── respuestas de la API ──────────────────────────────────────────────
def make_result(request: dict, drop: int = 0) -> dict:
    """Lo que devuelve sueno.sistema.analizar(): una fila de 5 probabilidades por época."""
    ini, fin = request["epoca_inicio"], request["epoca_fin"]
    epochs = list(range(ini, fin + 1 - drop))
    probs = []
    for i in epochs:
        row = [0.05] * 5
        row[(i // 20) % 5] = 0.8
        probs.append([0.3, 0.25, 0.2, 0.15, 0.1] if i % 10 == 0 else row)   # algunas con poca confianza
    stages = ["W", "N1", "N2", "N3", "REM"]
    return {"noche": "SC4001", "canales": request["canales"], "epoca": epochs,
            "estadio": [stages[int(np.argmax(p))] for p in probs], "probabilidades": probs,
            "segundos_proceso": 1.5}


class FakeClient:
    """Cliente sin red: guarda lo que recibe y responde según lo que se le pida."""
    configured = True

    def __init__(self, pending=0, fail=(), respond=None):
        self.uploads, self.requests = [], []
        self.pending, self.fail = pending, list(fail)
        self.respond = respond or (lambda req: {"estado": "listo", "resultado": make_result(req)})

    def upload(self, path, name, on_progress=None):
        data = Path(path).read_bytes()
        self.uploads.append((name, data))
        if on_progress:
            on_progress(len(data), len(data))
        return f"s3://bucket-del-modelo/sistema-sueno/api/subidas/{name}"

    def submit(self, request):
        self.requests.append(request)
        return "a" * 32

    def result(self, request_id):
        if self.fail:
            raise self.fail.pop(0)
        if self.pending:
            self.pending -= 1
            return {"estado": "pendiente"}
        return self.respond(self.requests[-1])


def adapter_with(client, nights=NIGHTS, **kw) -> RemoteAdapter:
    return RemoteAdapter(client=client, nights=nights, poll_s=0, sleep=lambda s: None, **kw)


def request_for(psg: Path, labels: dict[str, str], start=20, n=200, lights_off_s=None, messages=None):
    epochs = {slot: np.zeros((n, 3000 if slot != "emg" else 30), dtype=np.float32) for slot in labels}
    fs = {slot: 100.0 if slot != "emg" else 1.0 for slot in labels}
    return model.StagingRequest(record_id="r1", epochs=epochs, fs=fs, labels=labels, start_epoch=start,
                                lights_off_s=lights_off_s, source=str(psg),
                                progress=messages.append if messages is not None else None)


@pytest.fixture()
def night_file(tmp_path) -> Path:
    path = tmp_path / NIGHT
    write_psg(path, synthetic_night(2.0), START)
    return path


# ── lógica del adaptador ──────────────────────────────────────────────
def test_una_noche_de_test_se_pide_sin_subirla(night_file):
    client = FakeClient()
    req = request_for(night_file, {"fpz": "EEG Fpz-Cz", "eog": "EOG horizontal"}, lights_off_s=2280)
    res = adapter_with(client).predict(req)
    stages, probs = model.validate(res, req)
    assert client.uploads == []                                   # ya está en el bucket del modelo
    assert client.requests == [{"s3_uri": NIGHTS + NIGHT, "canales": ["fpz", "eog"], "epoca_inicio": 20,
                                "epoca_fin": 219, "hora_apagado": "00:38:00"}]
    assert probs.shape == (200, 5) and (stages == probs.argmax(axis=1)).all()
    assert res.timings["process_s"] == 1.5


def test_sin_carpeta_de_noches_la_sube(night_file):
    client = FakeClient()
    adapter_with(client, nights="").predict(request_for(night_file, {"fpz": "EEG Fpz-Cz"}))
    assert [name for name, _ in client.uploads] == [NIGHT]
    assert client.uploads[0][1] == night_file.read_bytes()       # tal cual: los nombres ya son los de Sleep-EDF
    assert client.requests[0]["s3_uri"].endswith("/api/subidas/" + NIGHT)


def test_un_psg_subido_siempre_se_envia_aunque_se_llame_como_una_noche_de_test():
    path = config.UPLOAD_DIR / "u-prueba" / NIGHT
    path.parent.mkdir(parents=True, exist_ok=True)
    write_psg(path, synthetic_night(1.0), START)
    client = FakeClient()
    adapter_with(client).predict(request_for(path, {"fpz": "EEG Fpz-Cz"}, n=100))
    assert len(client.uploads) == 1


def test_canales_con_otro_nombre_se_envian_con_el_de_sleep_edf(tmp_path):
    chans = synthetic_night(1.0)
    renamed = {"Fpz-Cz": chans["EEG Fpz-Cz"], "EOG": chans["EOG horizontal"], "Resp": chans["Resp oro-nasal"]}
    path = tmp_path / "mi_noche.edf"
    write_psg(path, renamed, START)
    client = FakeClient()
    adapter_with(client).predict(request_for(path, {"fpz": "Fpz-Cz", "eog": "EOG"}, start=0, n=100))
    name, data = client.uploads[0]
    sent = tmp_path / "enviada.edf"
    sent.write_bytes(data)
    assert name == "mi_noche.edf"
    assert edf_io.read_header(str(sent))["labels"] == ["EEG Fpz-Cz", "EOG horizontal", "Resp"]
    size = edf_io.header_size(data[:256])
    assert data[size:] == path.read_bytes()[size:]                # las muestras no cambian
    assert edf_io.read_header(str(path))["labels"] == ["Fpz-Cz", "EOG", "Resp"]   # el original tampoco


def test_ningun_otro_canal_se_queda_con_el_nombre_de_una_entrada():
    assert renames_for({"fpz": "C4-A1"}, ["C4-A1", "EEG Fpz-Cz", "EOG horizontal"]) == {
        "C4-A1": "EEG Fpz-Cz", "EEG Fpz-Cz": "x EEG Fpz-Cz"}
    assert renames_for({"fpz": "EEG Fpz-Cz", "emg": "EMG submental"}, ["EEG Fpz-Cz", "EMG submental"]) == {}


def test_renombrar_rechaza_nombres_repetidos(night_file, tmp_path):
    with pytest.raises(edf_io.InvalidFile, match="mismo nombre"):
        edf_io.relabel_edf(str(night_file), str(tmp_path / "x.edf"), {"EEG Pz-Oz": "EEG Fpz-Cz"})


def test_hora_de_apagado_como_reloj():
    assert clock(0 + 2280) == "00:38:00" and clock(23 * 3600 + 3000) == "23:50:00"
    assert clock(22 * 3600 + 3 * 3600) == "01:00:00"                # pasa la medianoche


def test_espera_mientras_el_modelo_enciende_y_lo_dice(night_file):
    messages = []
    client = FakeClient(pending=3)
    res = adapter_with(client).predict(request_for(night_file, {"fpz": "EEG Fpz-Cz"}, messages=messages))
    assert len(res.probs) == 200
    assert any(m.startswith("Esperando al modelo del proyecto") for m in messages)


def test_tolera_tropiezos_de_red_mientras_espera(night_file):
    client = FakeClient(fail=[ApiError("caída", 502), ApiError("sin conexión")])
    res = adapter_with(client).predict(request_for(night_file, {"fpz": "EEG Fpz-Cz"}))
    assert len(res.probs) == 200
    client = FakeClient(fail=[ApiError("caída", 502)] * 4)
    with pytest.raises(model.ModelError, match="caída"):
        adapter_with(client).predict(request_for(night_file, {"fpz": "EEG Fpz-Cz"}))


@pytest.mark.parametrize("respond, message", [
    (lambda req: {"estado": "error", "error": "el EDF no tiene EEG Fpz-Cz"}, "no pudo analizar esta noche: el EDF"),
    (lambda req: {"estado": "listo", "resultado": make_result(req, drop=1)}, "analizó las épocas 20–218"),
    (lambda req: {"estado": "listo", "resultado": {**make_result(req), "canales": ["pz"]}}, "usó los canales pz"),
    (lambda req: {"estado": "listo", "resultado": {"epoca": []}}, "no trae las probabilidades"),
    (lambda req: {"estado": "raro"}, "estado desconocido"),
])
def test_respuestas_malas_fallan_con_un_mensaje_claro(night_file, respond, message):
    with pytest.raises(model.ModelError, match=message):
        adapter_with(FakeClient(respond=respond)).predict(request_for(night_file, {"fpz": "EEG Fpz-Cz"}))


def test_se_rinde_si_el_modelo_no_responde_a_tiempo(night_file):
    client = FakeClient(pending=10_000)
    with pytest.raises(model.ModelError, match="no respondió en 0 min"):
        adapter_with(client, timeout_min=0).predict(request_for(night_file, {"fpz": "EEG Fpz-Cz"}))


def test_sin_configuracion_falla_diciendo_que_falta(night_file):
    adapter = RemoteAdapter(client=ApiClient(base="", token=""))
    with pytest.raises(model.ModelError, match="SOMNOAI_MODEL_API y SOMNOAI_MODEL_TOKEN"):
        adapter.predict(request_for(night_file, {"fpz": "EEG Fpz-Cz"}))


def test_se_registra_como_api(monkeypatch):
    monkeypatch.setattr(config, "MODEL_BACKEND", "api")
    a = model._configured.__wrapped__()
    assert isinstance(a, RemoteAdapter) and a.info().kind == "proyecto"
    assert a.info().night_review_fraction == 0.2765


# ── el cliente HTTP contra una imitación local de la API ──────────────
class StubApi(BaseHTTPRequestHandler):
    """Imita despliegue/api/lambda_function.py del repositorio del modelo."""
    state: dict = {}

    def log_message(self, *args):
        pass

    def _send(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authorized(self) -> bool:
        if self.state.get("down"):
            self._send(502, {"Type": "User", "message": "The server encountered an error"})
            return False
        if self.headers.get("Authorization") != f"Bearer {SECRET}":
            self._send(401, {"error": "falta un token válido en Authorization: Bearer <token>"})
            return False
        return True

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n)

    def do_PUT(self):                       # la «URL firmada de S3»
        data = self._body()
        self.state["puts"].append({"path": self.path, "auth": self.headers.get("Authorization"), "size": len(data)})
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        body = json.loads(self._body() or b"{}")
        if not self._authorized():
            return
        if self.path == "/subir":
            key = f"{uuid.uuid4().hex[:12]}/{body['archivo']}"
            port = self.server.server_address[1]
            return self._send(200, {"subir_a": f"http://127.0.0.1:{port}/s3/{key}",
                                    "s3_uri": f"s3://bucket-del-modelo/sistema-sueno/api/subidas/{key}"})
        if self.path == "/analizar":
            if not str(body.get("s3_uri", "")).startswith("s3://bucket-del-modelo/sistema-sueno/"):
                return self._send(400, {"error": "s3_uri debe estar en s3://bucket-del-modelo/sistema-sueno/"})
            rid = uuid.uuid4().hex
            self.state["requests"][rid] = {"body": body, "polls": self.state.get("pending", 0)}
            return self._send(202, {"id": rid})
        self._send(404, {"error": "rutas: POST /subir, POST /analizar, GET /resultado/<id>"})

    def do_GET(self):
        if not self._authorized():
            return
        rid = self.path.removeprefix("/resultado/")
        entry = self.state["requests"].get(rid)
        if entry is None:
            return self._send(404, {"error": "id desconocido"})
        if entry["polls"] > 0:
            entry["polls"] -= 1
            return self._send(200, {"estado": "pendiente"})
        self._send(200, {"estado": "listo", "resultado": make_result(entry["body"])})


@pytest.fixture()
def stub():
    StubApi.state = {"puts": [], "requests": {}, "pending": 2}
    server = ThreadingHTTPServer(("127.0.0.1", 0), StubApi)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}", StubApi.state
    server.shutdown()


def test_cliente_http_de_punta_a_punta(stub, night_file):
    url, state = stub
    adapter = adapter_with(ApiClient(base=url, token=SECRET), nights="")
    res = adapter.predict(request_for(night_file, {"fpz": "EEG Fpz-Cz", "eog": "EOG horizontal"}))
    assert len(res.probs) == 200
    # el EDF fue por la URL firmada, completo y sin el token (S3 rechaza dos autenticaciones)
    assert state["puts"] == [{"path": state["puts"][0]["path"], "auth": None, "size": night_file.stat().st_size}]
    (body,) = [r["body"] for r in state["requests"].values()]
    assert body["canales"] == ["fpz", "eog"] and body["s3_uri"].startswith("s3://bucket-del-modelo/")


def test_token_rechazado_sin_revelarlo(stub, night_file):
    url, _ = stub
    client = ApiClient(base=url, token="otro-token-que-no-sirve-77")
    with pytest.raises(model.ModelError) as e:
        adapter_with(client).predict(request_for(night_file, {"fpz": "EEG Fpz-Cz"}))
    assert "SOMNOAI_MODEL_TOKEN" in str(e.value) and "otro-token-que-no-sirve-77" not in str(e.value)


def test_api_caida(stub, night_file):
    url, state = stub
    state["down"] = True
    with pytest.raises(model.ModelError, match=r"no está disponible \(HTTP 502\)"):
        adapter_with(ApiClient(base=url, token=SECRET)).predict(request_for(night_file, {"fpz": "EEG Fpz-Cz"}))


def test_sin_conexion():
    client = ApiClient(base="http://127.0.0.1:9", token=SECRET, timeout_s=2)
    with pytest.raises(ApiError, match="No se pudo conectar") as e:
        client.submit({"s3_uri": "s3://x"})
    assert e.value.transient


# ── el pipeline completo con el modelo del proyecto ───────────────────
def _analyze(client, headers, **body):
    r = client.post(f"{API}/analyses", headers=headers, json={"source": {"type": "catalog", "id": NIGHT}, **body})
    assert r.status_code == 202, r.text
    return wait_done(client, headers, r.json()["id"])


def test_pipeline_con_el_modelo_del_proyecto(stub, client, headers):
    url, state = stub
    with model.override(adapter_with(ApiClient(base=url, token=SECRET))):
        d = _analyze(client, headers, channels=["fpz", "eog"])
        cfg = client.get(f"{API}/config", headers=headers)
        health = client.get(f"{API}/health")
    assert d["status"] == "done", d.get("error")
    (body,) = [r["body"] for r in state["requests"].values()]
    assert body == {"s3_uri": NIGHTS + NIGHT, "canales": ["fpz", "eog"], "epoca_inicio": 20, "epoca_fin": 219,
                    "hora_apagado": "00:38:00"}
    assert state["puts"] == []                                   # noche de test: no se subió
    assert d["model"]["kind"] == "proyecto" and d["model_version"] == config.MODEL_VERSION
    assert d["model"]["night_review_fraction"] == 0.2765
    assert len(d["epochs"]["stage"]) == 200 and d["review"]["flagged"] == 20      # i % 10 == 0 → poca confianza
    timings = d["quality"]["timings"]
    assert timings["model_process_s"] == 1.5 and "model_wait_s" in timings
    steps = {s["key"]: s for s in d["progress"]["steps"]}
    assert steps["predict"]["status"] == "done" and steps["predict"]["message"] == config.MODEL_VERSION
    # ni el token ni la URL de la API salen del servidor
    for text in (cfg.text, health.text, json.dumps(d)):
        assert SECRET not in text and url not in text


def test_pipeline_si_la_api_esta_caida(stub, client, headers):
    url, state = stub
    state["down"] = True
    with model.override(adapter_with(ApiClient(base=url, token=SECRET))):
        d = _analyze(client, headers, channels=["fpz"])
    assert d["status"] == "failed" and "no está disponible (HTTP 502)" in d["error"]
    steps = {s["key"]: s for s in d["progress"]["steps"]}
    assert steps["predict"]["status"] == "failed" and steps["load"]["status"] == "done"
    assert SECRET not in json.dumps(d)
