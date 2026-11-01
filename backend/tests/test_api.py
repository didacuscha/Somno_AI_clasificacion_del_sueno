"""La API de punta a punta con el modelo simulado: sesión, catálogo, cargas, análisis
con pasos, revisión del especialista, notas, evidencia, persistencia y exportación."""
import io
import json
import sqlite3
import zipfile
from pathlib import Path

import numpy as np

from app import config
from app.model import adapter as model
from conftest import API, START, SpyAdapter, low_confidence, wait_done
from edf_utils import write_psg

NIGHT = "SC4001E0-PSG.edf"          # id de la noche sintética en el catálogo local


def _analyze(client, headers, source=None, **body):
    r = client.post(f"{API}/analyses", headers=headers,
                    json={"source": source or {"type": "catalog", "id": NIGHT}, **body})
    assert r.status_code == 202, r.text
    assert r.json()["status"] == "queued"
    return wait_done(client, headers, r.json()["id"])


def test_salud_y_sesion(client):
    h = client.get(f"{API}/health").json()
    assert h["model"]["kind"] == "mock" and h["model"]["version"]
    r = client.post(f"{API}/auth/login", json={"username": "superusuario", "password": "mala"})
    assert r.status_code == 401 and r.json()["error"]["code"] == "invalid_credentials"
    assert client.get(f"{API}/records").status_code == 401
    assert client.get(f"{API}/records", headers={"Authorization": "Bearer basura"}).status_code == 401


def test_configuracion_viene_del_adaptador(client, headers):
    cfg = client.get(f"{API}/config", headers=headers).json()
    assert cfg["confidence_threshold"] == 0.65 and cfg["night_review_fraction"] == 0.273
    assert cfg["model"]["version"] == "simulado-2.0" and cfg["model"]["name"]
    assert len(cfg["expected"]) == 12 and cfg["expected_source"]
    assert [s["key"] for s in cfg["steps"]] == ["load", "preprocess", "predict", "flag", "save"]
    assert [b["key"] for b in cfg["bands"]] == ["delta", "theta", "alpha", "sigma", "beta"]
    assert cfg["catalog"]["kind"] == "local"


# ── catálogo (US-06) y canales (US-09) ────────────────────────────────
def test_catalogo_lista_las_noches_con_sus_canales(client, headers):
    out = client.get(f"{API}/catalog", headers=headers).json()
    nights = [n for n in out["nights"] if not n["subset"]]
    assert [n["id"] for n in nights] == [NIGHT]
    n = nights[0]
    assert n["subject"] == 0 and n["night"] == 1 and n["split"] == "test" and n["has_hypnogram"]
    assert n["available"] == ["fpz", "pz", "eog", "emg"]
    assert n["channels"]["total"] == 5 and n["channels"]["usable"] == 4
    assert n["channels"]["unused"] == ["Resp oro-nasal"]
    assert not any(k.startswith("_") for k in n)


# ── pipeline (US-01, US-02, US-04, US-20) ─────────────────────────────
def test_analisis_completo_por_pasos_y_solo_con_los_canales_elegidos(client, headers):
    spy = SpyAdapter()
    with model.override(spy):
        d = _analyze(client, headers, channels=["fpz", "eog"])
    assert d["status"] == "done", d.get("error")
    # el pipeline le pasó al adaptador solo las entradas elegidas, ya en épocas de 30 s
    req = spy.requests[-1]
    assert req.slots == ["fpz", "eog"] and req.epochs["fpz"].shape == (200, 3000)
    assert req.labels == {"fpz": "EEG Fpz-Cz", "eog": "EOG horizontal"} and req.start_epoch == 20
    assert [s["status"] for s in d["progress"]["steps"]] == ["done"] * 5
    assert d["combination"] == "fpz_eog" and d["channels"]["mask"] == [True, False, True, False]
    assert d["channels"]["unused"] == ["Resp oro-nasal"]
    assert d["night"]["window"]["mode"] == "reference"       # con hipnograma, la ventana de sueño
    n = d["night"]["n_epochs"]
    assert n == 200 and len(d["epochs"]["probs"]) == n and len(d["epochs"]["reference"]) == n
    assert all(abs(sum(p) - 1) < 0.01 for p in d["epochs"]["probs"])
    assert d["night"]["lights_off_clock"] == "00:38" and d["night"]["lights_off_source"] == "dataset-index"
    # versión y umbral los reporta el adaptador y quedan con la noche (US-04)
    assert d["model_version"] == "espia-1.0" and d["model"]["threshold"] == 0.65
    assert d["review"]["status"] in ("to_review", "full_review_suggested")
    assert d["review"]["flagged"] == sum(d["epochs"]["review"])
    assert d["epochs"]["final"] == d["epochs"]["stage"]
    assert d["source_info"]["type"] == "catalog" and d["agreement"]["predicted"]["n_epochs"] > 0
    # el visor recibe todas las entradas del archivo, no solo las del modelo
    sig = client.get(f"{API}/records/{d['id']}/signal", headers=headers,
                     params={"start_s": 0, "duration_s": 30, "points": 100, "channels": "fpz,emg,pz"}).json()
    assert set(sig["traces"]) == {"fpz", "emg", "pz"} and len(sig["traces"]["fpz"]["min"]) == 100


def test_revision_completa_sugerida(client, headers):
    with model.override(SpyAdapter(transform=low_confidence(0.30))):
        d = _analyze(client, headers, channels=["fpz"])
    assert d["review"]["flagged_fraction"] > 0.273 and d["review"]["whole_night_recommended"]
    assert d["review"]["status"] == "full_review_suggested"


def test_las_noches_viejas_conservan_su_version(client, headers):
    with model.override(SpyAdapter(version="v-vieja")):
        old = _analyze(client, headers, channels=["fpz"])
    with model.override(SpyAdapter(version="v-nueva")):
        new = _analyze(client, headers, channels=["fpz"])
        assert client.get(f"{API}/config", headers=headers).json()["model"]["version"] == "v-nueva"
        again = client.get(f"{API}/records/{old['id']}", headers=headers).json()
    assert again["model_version"] == "v-vieja" and again["model"]["version"] == "v-vieja"
    assert new["model"]["version"] == "v-nueva"


def test_salida_invalida_del_modelo_falla_sin_guardar_y_se_puede_reintentar(client, headers):
    def drop_last(res, req):
        res.probs, res.stages = np.asarray(res.probs)[:-1], np.asarray(res.stages)[:-1]
        return res
    with model.override(SpyAdapter(transform=drop_last)):
        d = _analyze(client, headers, channels=["fpz"])
    assert d["status"] == "failed" and "faltan 1" in d["error"]
    steps = {s["key"]: s for s in d["progress"]["steps"]}
    assert steps["load"]["status"] == steps["preprocess"]["status"] == "done"
    assert steps["predict"]["status"] == "failed" and "faltan 1" in steps["predict"]["message"]
    assert steps["flag"]["status"] == steps["save"]["status"] == "pending"
    assert d.get("epochs") is None and d["review"] is None                  # sin resultados parciales
    assert not (config.SIGNAL_DIR / d["id"]).exists() and not (config.SIGNAL_DIR / f"{d['id']}.part").exists()
    assert client.get(f"{API}/records/{d['id']}/signal", headers=headers,
                      params={"start_s": 0, "duration_s": 30}).status_code == 409
    # reintento: el mismo registro vuelve a la cola y ahora termina
    r = client.post(f"{API}/records/{d['id']}/retry", headers=headers)
    assert r.status_code == 202, r.text
    d2 = wait_done(client, headers, d["id"])
    assert d2["status"] == "done" and d2["attempts"] == 2 and d2["history"][0]["action"] == "retry"
    assert client.post(f"{API}/records/{d['id']}/retry", headers=headers).status_code == 409


def test_combinacion_debil_y_rango_horario(client, headers):
    d = _analyze(client, headers, channels=["pz"], window_mode="range", start_clock="00:30",
                 end_clock="01:45", lights_off="none")
    assert d["status"] == "done"
    assert d["model"]["expected"]["below_goal"]               # Pz-Oz solo queda bajo MF1 0,75
    assert d["night"]["n_epochs"] == 150 and d["night"]["lights_off_clock"] is None


def test_errores_de_entrada(client, headers):
    def post(**body):
        return client.post(f"{API}/analyses", headers=headers,
                           json={"source": {"type": "catalog", "id": NIGHT}, **body})
    r = post(channels=[])
    assert r.status_code == 422 and "al menos un canal" in r.json()["error"]["message"]
    r = post(channels=["eog"])
    assert r.status_code == 422 and "al menos un EEG" in r.json()["error"]["message"]
    # US-10: un canal en dos entradas y un canal que no es del modelo
    r = post(channels=["fpz", "pz"], channel_map={"fpz": "EEG Pz-Oz"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_channels"
    r = post(channels=["fpz", "emg"], channel_map={"emg": "Resp oro-nasal"})
    assert r.status_code == 422 and "no lo usa" in r.json()["error"]["message"]
    r = post(channels=["fpz"], lights_off="05:00")
    assert r.status_code == 422 and "apagado de luces" in r.json()["error"]["message"]
    r = client.post(f"{API}/analyses", headers=headers, json={"source": {"type": "catalog", "id": "nada.edf"},
                                                              "channels": ["fpz"]})
    assert r.status_code == 404


# ── cargas propias (US-07) ────────────────────────────────────────────
def test_carga_valida_lista_los_canales_y_se_analiza(client, headers, files):
    r = client.post(f"{API}/uploads", headers=headers, files={"file": ("mi_noche.edf", files["psg"].read_bytes())})
    assert r.status_code == 201, r.text
    up = r.json()
    assert up["channels"]["matched"]["fpz"] == "EEG Fpz-Cz" and up["channels"]["unused"] == ["Resp oro-nasal"]
    assert up["hypnogram"] is None and up["dataset"] is None
    # hipnograma opcional, como referencia
    r = client.post(f"{API}/uploads/{up['id']}/hypnogram", headers=headers,
                    files={"file": ("ref.edf", files["hyp"].read_bytes())})
    assert r.status_code == 200 and r.json()["hypnogram"]["name"] == "ref.edf"
    d = _analyze(client, headers, source={"type": "upload", "id": up["id"]}, channels=["fpz"],
                 channel_map={"fpz": "EEG Pz-Oz"}, window_mode="full", lights_off="none")
    assert d["status"] == "done" and d["source"] == "upload" and d["has_reference"]
    assert d["channels"]["map"] == {"fpz": "EEG Pz-Oz"} and d["night"]["n_epochs"] == 240
    # tras un análisis exitoso la carga se borra (la señal de la ventana queda guardada)
    assert client.get(f"{API}/uploads/{up['id']}", headers=headers).status_code == 404


def test_carga_de_zip_con_hipnograma(client, headers, files):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.write(files["psg"], "SC4001E0-PSG.edf")
        z.write(files["hyp"], "SC4001EC-Hypnogram.edf")
    up = client.post(f"{API}/uploads", headers=headers, files={"file": ("noche.zip", buf.getvalue())}).json()
    assert up["file_name"] == NIGHT and up["hypnogram"]["name"] == "SC4001EC-Hypnogram.edf"
    assert up["dataset"]["split"] == "test"
    d = _analyze(client, headers, source={"type": "upload", "id": up["id"]}, channels=["fpz", "emg"],
                 lights_off="00:38")
    assert d["status"] == "done" and d["night"]["lights_off_source"] == "dataset-index"
    assert d["quality"]["file"]["size_mb"] > 0


def test_cargas_invalidas_explican_que_esta_mal(client, headers, files, tmp_path):
    def up(name, data):
        return client.post(f"{API}/uploads", headers=headers, files={"file": (name, data)})
    r = up("x.txt", b"hola")
    assert r.status_code == 422 and "Formato no aceptado" in r.json()["error"]["message"]
    r = up("roto.edf", b"esto no es un EDF" * 40)
    assert r.status_code == 422 and "no es un EDF legible" in r.json()["error"]["message"]
    r = up("SC4001EC-Hypnogram.edf", files["hyp"].read_bytes())
    assert r.status_code == 422 and "solo un hipnograma" in r.json()["error"]["message"]
    p = tmp_path / "sin-modelo.edf"
    write_psg(p, {"Resp oro-nasal": (np.zeros(3600), 1.0), "Temp rectal": (np.zeros(3600), 1.0)}, START)
    r = up("sin-modelo.edf", p.read_bytes())
    assert r.status_code == 422 and "ninguno de los canales" in r.json()["error"]["message"]
    good = up("ok.edf", files["psg"].read_bytes()).json()
    r = client.post(f"{API}/uploads/{good['id']}/hypnogram", headers=headers,
                    files={"file": ("psg.edf", files["psg"].read_bytes())})
    assert r.status_code == 422 and "no parece un hipnograma" in r.json()["error"]["message"]
    # la ventana del hipnograma sin hipnograma no arranca
    r = client.post(f"{API}/analyses", headers=headers, json={
        "source": {"type": "upload", "id": good["id"]}, "channels": ["fpz"], "window_mode": "reference"})
    assert r.status_code == 422 and "necesita el hipnograma" in r.json()["error"]["message"]
    assert client.delete(f"{API}/uploads/{good['id']}", headers=headers).status_code == 200
    assert not list(config.UPLOAD_DIR.glob(f"{good['id']}*"))


# ── revisión del especialista (US-03, US-05, US-13, US-14) ────────────
def test_revision_del_especialista(client, headers):
    d = _analyze(client, headers, channels=["fpz", "pz", "eog", "emg"])
    rid, pred = d["id"], d["epochs"]["stage"]
    flagged = [i for i, f in enumerate(d["epochs"]["review"]) if f]
    assert len(flagged) >= 3, "el simulado debería marcar algunas épocas"
    a, b, c = flagged[:3]
    second_b = d["epochs"]["second"][b]
    r = client.patch(f"{API}/records/{rid}/epochs", headers=headers,
                     json={"changes": [{"epoch": a, "stage": pred[a]}, {"epoch": b, "stage": second_b}]})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["review"]["resolved"] == 2 and out["review"]["confirmed"] == 1
    assert out["review"]["corrected"] == 1 and out["review"]["status"] == "in_review"
    assert out["final"][b] == second_b and out["corrections"][0]["author"] == "Superusuario"
    # bitácora: usuario, fecha, acción, valor anterior y nuevo
    h = out["history"][0]
    assert h["action"] == "set" and h["epoch"] == b and h["author"] == "Superusuario" and h["at"]
    assert h["old"] == config.STAGES[pred[b]] and h["new"] == config.STAGES[second_b]
    # las métricas se recalculan con el hipnograma final (cuentan desde el apagado de luces)
    lo = d["night"]["lights_off_epoch"] or 0
    many = [i for i, s in enumerate(pred) if s != 3 and i >= lo and i not in (a, b)][:40]
    out = client.patch(f"{API}/records/{rid}/epochs", headers=headers,
                       json={"changes": [{"epoch": i, "stage": 3} for i in many]}).json()
    assert out["metrics_final"]["stages"]["N3"]["min"] > d["metrics"]["predicted"]["stages"]["N3"]["min"]
    out = client.patch(f"{API}/records/{rid}/epochs", headers=headers,
                       json={"changes": [{"epoch": i, "stage": None} for i in many if i not in (a, b)]}).json()
    assert out["history"][0]["action"] == "clear"

    # resumen antes de finalizar y deshacer un cambio desde ahí
    s = client.get(f"{API}/records/{rid}/changes", headers=headers).json()
    assert s["confirmed"] >= 1 and s["corrected"] >= 1
    chg = next(x for x in s["changes"] if x["epoch"] == b)
    assert chg["model_stage"] == pred[b] and chg["reviewer_stage"] == second_b
    out = client.patch(f"{API}/records/{rid}/epochs", headers=headers,
                       json={"changes": [{"epoch": b, "stage": None}]}).json()
    assert out["final"][b] == pred[b] and out["history"][0]["old"] == config.STAGES[second_b]
    client.patch(f"{API}/records/{rid}/epochs", headers=headers, json={"changes": [{"epoch": c, "stage": (pred[c] + 1) % 5}]})
    s = client.get(f"{API}/records/{rid}/changes", headers=headers).json()

    bad = client.patch(f"{API}/records/{rid}/epochs", headers=headers, json={"changes": [{"epoch": 9999, "stage": 1}]})
    assert bad.status_code == 422
    # finalizar con un resumen desactualizado se rechaza
    stale = client.post(f"{API}/records/{rid}/review", headers=headers,
                        json={"action": "finalize", "expected_corrected": s["corrected"] + 1})
    assert stale.status_code == 409 and stale.json()["error"]["code"] == "stale_summary"
    fin = client.post(f"{API}/records/{rid}/review", headers=headers,
                      json={"action": "finalize", "expected_corrected": s["corrected"]}).json()
    assert fin["review"]["status"] == "finalized" and fin["review"]["finalized_by"] == "Superusuario"
    assert fin["history"][0]["action"] == "finalize" and fin["history"][0]["old"] == "in_review"
    assert fin["history"][0]["new"] == "finalized"
    locked = client.patch(f"{API}/records/{rid}/epochs", headers=headers, json={"changes": [{"epoch": a, "stage": 0}]})
    assert locked.status_code == 409
    listed = next(r for r in client.get(f"{API}/records", headers=headers).json()["records"] if r["id"] == rid)
    assert listed["review"]["status"] == "finalized"
    reopened = client.post(f"{API}/records/{rid}/review", headers=headers, json={"action": "reopen"}).json()
    assert reopened["review"]["status"] == "in_review"
    assert reopened["history"][0]["action"] == "reopen" and reopened["history"][0]["old"] == "finalized"

    # exportaciones
    csv_rec = client.get(f"{API}/records/{rid}/export.csv", headers=headers).text.splitlines()
    assert csv_rec[0].startswith("epoca,hora,inicio_s,prediccion") and len(csv_rec) == 1 + d["night"]["n_epochs"]
    assert "confirmada" in csv_rec[1 + a]
    corr = client.get(f"{API}/corrections/export.csv", headers=headers).text.splitlines()
    assert any(line.startswith(rid) for line in corr[1:])


def test_notas_del_tecnico(client, headers):
    d = _analyze(client, headers, channels=["fpz"])
    r = client.post(f"{API}/records/{d['id']}/notes", headers=headers, json={"text": "  Artefacto de movimiento a las 01:10.  "})
    assert r.status_code == 201
    out = r.json()
    assert out["notes"][0]["text"] == "Artefacto de movimiento a las 01:10." and out["notes"][0]["author"] == "Superusuario"
    assert out["notes"][0]["at"] and out["history"][0]["action"] == "note"
    assert client.post(f"{API}/records/{d['id']}/notes", headers=headers, json={"text": "  "}).status_code == 422
    assert client.get(f"{API}/records/{d['id']}", headers=headers).json()["notes"][0]["id"] == out["notes"][0]["id"]


def test_evidencia_espectral_de_una_epoca(client, headers):
    d = _analyze(client, headers, channels=["fpz", "pz"])
    i = d["epochs"]["review"].index(1)
    r = client.get(f"{API}/records/{d['id']}/epochs/{i}/evidence", headers=headers)
    assert r.status_code == 200, r.text
    ev = r.json()
    assert ev["channel"] == "fpz" and ev["channels"] == ["fpz", "pz"]
    assert [b["key"] for b in ev["bands"]] == ["delta", "theta", "alpha", "sigma", "beta"]
    assert abs(sum(b["value"] for b in ev["bands"]) - 1) < 0.05
    # la señal sintética de Fpz-Cz es una onda de 2 Hz: domina delta
    assert max(ev["bands"], key=lambda b: b["value"])["key"] == "delta"
    assert ev["candidates"] == [d["epochs"]["stage"][i], d["epochs"]["second"][i]]
    assert ev["typical"]
    pz = client.get(f"{API}/records/{d['id']}/epochs/0/evidence", headers=headers, params={"channel": "pz"}).json()
    assert max(pz["bands"], key=lambda b: b["value"])["key"] == "alpha"     # Pz-Oz sintético: 10 Hz
    assert client.get(f"{API}/records/{d['id']}/epochs/0/evidence", headers=headers,
                      params={"channel": "eog"}).status_code == 422
    assert client.get(f"{API}/records/{d['id']}/epochs/99999/evidence", headers=headers).status_code == 422


# ── persistencia (US-03) ──────────────────────────────────────────────
def test_los_datos_sobreviven_un_reinicio(client, headers):
    from fastapi.testclient import TestClient

    from app import db
    from app.main import app

    d = _analyze(client, headers, channels=["fpz"])
    i = d["epochs"]["review"].index(1)
    client.patch(f"{API}/records/{d['id']}/epochs", headers=headers, json={"changes": [{"epoch": i, "stage": 4}]})
    client.post(f"{API}/records/{d['id']}/notes", headers=headers, json={"text": "nota antes del reinicio"})
    before = client.get(f"{API}/records/{d['id']}", headers=headers).json()
    # un análisis que quedó a medias cuando se cayó el servidor
    db.insert("interrumpido", {**d, "id": "interrumpido"}, {"source": {"type": "catalog", "id": NIGHT},
                                                             "channels": ["fpz"]}, {"steps": []})
    db.set_progress("interrumpido", {"current": "predict", "steps": [
        {"key": "predict", "label": "Predecir", "status": "running", "message": None, "seconds": None}]})
    with TestClient(app) as again:                       # arranque nuevo sobre la misma base
        after = again.get(f"{API}/records/{d['id']}", headers=headers).json()
        broken = again.get(f"{API}/records/interrumpido", headers=headers).json()
    for k in ("epochs", "corrections", "review", "notes", "model"):
        assert after[k] == before[k], k
    assert after["epochs"]["final"][i] == 4
    assert after["history"] == before["history"]
    assert broken["status"] == "failed" and "reinició" in broken["error"]
    assert broken["progress"]["steps"][0]["status"] == "failed"
    # está en el disco, no en memoria
    con = sqlite3.connect(config.DB_PATH)
    assert con.execute("SELECT stage FROM corrections WHERE record_id=? AND epoch=?", (d["id"], i)).fetchone() == (4,)
    client.delete(f"{API}/records/interrumpido", headers=headers)


def test_migra_una_base_de_la_version_anterior(tmp_path, monkeypatch):
    from app import db
    from app.pipeline import review as rv

    path = tmp_path / "vieja.db"
    con = sqlite3.connect(path)
    con.executescript("""
        CREATE TABLE records(id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL,
            summary TEXT NOT NULL, detail TEXT, review TEXT, progress TEXT, error TEXT, signal_dir TEXT);
        CREATE TABLE corrections(record_id TEXT NOT NULL, epoch INTEGER NOT NULL, stage INTEGER NOT NULL,
            author TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(record_id, epoch));
        CREATE TABLE history(id INTEGER PRIMARY KEY AUTOINCREMENT, record_id TEXT NOT NULL, at TEXT NOT NULL,
            author TEXT NOT NULL, action TEXT NOT NULL, epoch INTEGER, stage INTEGER, previous INTEGER);""")
    ep = {"stage": [0, 1, 2], "review": [0, 1, 0], "second": [1, 0, 1], "confidence": [0.9, 0.5, 0.8]}
    detail = {"epochs": ep, "model": {"night_review_fraction": 0.273}}
    con.execute("INSERT INTO records VALUES ('r1','2026-10-27T10:00:00','done','{}',?,?,NULL,NULL,NULL)",
                (json.dumps(detail), json.dumps({"status": "signed_off", "signed_off_by": "Dra. X", "signed_off_at": "t"})))
    con.execute("INSERT INTO corrections VALUES ('r1', 1, 2, 'Dra. X', 't')")
    con.executemany("INSERT INTO history(record_id, at, author, action, epoch, stage, previous) VALUES (?,?,?,?,?,?,?)",
                    [("r1", "t", "Dra. X", "set", 1, 2, 1), ("r1", "t", "Dra. X", "sign_off", None, None, None)])
    con.commit()
    con.close()
    monkeypatch.setattr(config, "DB_PATH", path)
    db.init()
    db.init()                                             # idempotente
    assert db.get("r1")["review"] == rv.state(ep, {1: 2}, {"by": "Dra. X", "at": "t"}, 0.273)
    assert db.get("r1")["review"]["status"] == "finalized"
    hist = db.history("r1")
    assert [h["action"] for h in hist] == ["finalize", "set"] and (hist[1]["old"], hist[1]["new"]) == ("N1", "N2")
    assert db.notes("r1") == []


def test_borrado(client, headers):
    d = _analyze(client, headers, channels=["fpz"])
    assert client.delete(f"{API}/records/{d['id']}", headers=headers).json() == {"deleted": d["id"]}
    assert client.get(f"{API}/records/{d['id']}", headers=headers).status_code == 404
    assert client.delete(f"{API}/records/{d['id']}", headers=headers).status_code == 404
    assert not Path(config.SIGNAL_DIR / d["id"]).exists()
