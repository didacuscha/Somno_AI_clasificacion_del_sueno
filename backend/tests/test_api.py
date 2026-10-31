"""La API de punta a punta con el modelo simulado: sesión, análisis asíncrono,
señal, revisión del especialista y exportación."""
import io
import json
import zipfile

from conftest import wait_done

API = "/api/v1"


def test_salud_y_sesion(client):
    assert client.get(f"{API}/health").json()["model"]["kind"] == "mock"
    r = client.post(f"{API}/auth/login", json={"username": "superusuario", "password": "mala"})
    assert r.status_code == 401 and r.json()["error"]["code"] == "invalid_credentials"
    assert client.get(f"{API}/records").status_code == 401
    assert client.get(f"{API}/records", headers={"Authorization": "Bearer basura"}).status_code == 401


def test_configuracion_y_demos(client, headers):
    cfg = client.get(f"{API}/config", headers=headers).json()
    assert cfg["confidence_threshold"] == 0.65 and len(cfg["expected"]) == 12
    demos = client.get(f"{API}/demos", headers=headers).json()["demos"]
    assert [d["id"] for d in demos] == ["SC4001E0"]
    assert demos[0]["split"] == "test" and demos[0]["has_hypnogram"]
    assert set(demos[0]["detected"]) == {"fpz", "pz", "eog", "emg"}


def _demo(client, headers, **body):
    r = client.post(f"{API}/analyses/demo", headers=headers, json={"demo_id": "SC4001E0", **body})
    assert r.status_code == 202, r.text
    assert r.json()["status"] == "queued"
    return wait_done(client, headers, r.json()["id"])


def test_analisis_demo_completo(client, headers):
    d = _demo(client, headers, channels=["fpz", "eog"])
    assert d["status"] == "done", d.get("error")
    assert d["combination"] == "fpz_eog" and d["channels"]["mask"] == [True, False, True, False]
    assert d["night"]["window"]["mode"] == "reference"       # con hipnograma, la ventana de sueño
    n = d["night"]["n_epochs"]
    assert n == 200 and len(d["epochs"]["probs"]) == n and len(d["epochs"]["reference"]) == n
    assert d["night"]["lights_off_clock"] == "00:38"         # del índice de Sleep-EDFx
    assert d["night"]["lights_off_source"] == "dataset-index"
    assert d["dataset"]["split"] == "test"
    assert d["model"]["expected"]["test_mf1"] == 0.782
    assert d["agreement"]["predicted"]["accuracy"] > 0.5
    assert d["review"]["flagged"] == sum(d["epochs"]["review"])
    assert d["epochs"]["final"] == d["epochs"]["stage"]
    # el visor recibe todas las modalidades del archivo, no solo las del modelo
    sig = client.get(f"{API}/records/{d['id']}/signal", headers=headers,
                     params={"start_s": 0, "duration_s": 30, "points": 100, "channels": "fpz,emg,pz"}).json()
    assert set(sig["traces"]) == {"fpz", "emg", "pz"} and len(sig["traces"]["fpz"]["min"]) == 100


def test_combinacion_debil_y_rango_horario(client, headers):
    d = _demo(client, headers, channels=["pz"], window_mode="range", start_clock="00:30",
              end_clock="01:45", lights_off="none")
    assert d["status"] == "done"
    assert d["model"]["expected"]["below_goal"]               # Pz-Oz solo queda bajo MF1 0,75
    assert d["night"]["n_epochs"] == 150 and d["night"]["lights_off_clock"] is None


def test_errores_de_entrada(client, headers):
    r = client.post(f"{API}/analyses/demo", headers=headers, json={"demo_id": "SC4001E0", "channels": ["eog"]})
    assert r.status_code == 422 and "al menos un EEG" in r.json()["error"]["message"]
    r = client.post(f"{API}/analyses/demo", headers=headers,
                    json={"demo_id": "SC4001E0", "channels": ["fpz"], "lights_off": "05:00"})
    assert r.status_code == 422 and "apagado de luces" in r.json()["error"]["message"]
    r = client.post(f"{API}/analyses/demo", headers=headers, json={"demo_id": "SC9999E0", "channels": ["fpz"]})
    assert r.status_code == 404


def test_revision_del_especialista(client, headers):
    d = _demo(client, headers, channels=["fpz", "pz", "eog", "emg"])
    rid, pred = d["id"], d["epochs"]["stage"]
    flagged = [i for i, f in enumerate(d["epochs"]["review"]) if f]
    assert flagged, "el simulado debería marcar algunas épocas"
    a, b = flagged[0], flagged[1]
    new_b = (pred[b] + 1) % 5
    r = client.patch(f"{API}/records/{rid}/epochs", headers=headers,
                     json={"changes": [{"epoch": a, "stage": pred[a]}, {"epoch": b, "stage": new_b}]})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["review"]["resolved"] == 2 and out["review"]["confirmed"] == 1
    assert out["review"]["corrected"] == 1 and out["review"]["status"] == "in_progress"
    assert out["final"][b] == new_b and out["corrections"][0]["author"] == "Superusuario"
    assert out["history"][0]["action"] == "set"

    # volver a la predicción del modelo
    out = client.patch(f"{API}/records/{rid}/epochs", headers=headers,
                       json={"changes": [{"epoch": b, "stage": None}]}).json()
    assert out["final"][b] == pred[b] and out["review"]["resolved"] == 1

    bad = client.patch(f"{API}/records/{rid}/epochs", headers=headers, json={"changes": [{"epoch": 9999, "stage": 1}]})
    assert bad.status_code == 422

    # finalizar bloquea los cambios; reabrir los permite de nuevo
    signed = client.post(f"{API}/records/{rid}/review", headers=headers, json={"action": "sign_off"}).json()
    assert signed["review"]["status"] == "signed_off" and signed["review"]["signed_off_by"] == "Superusuario"
    locked = client.patch(f"{API}/records/{rid}/epochs", headers=headers, json={"changes": [{"epoch": a, "stage": 0}]})
    assert locked.status_code == 409
    listed = next(r for r in client.get(f"{API}/records", headers=headers).json()["records"] if r["id"] == rid)
    assert listed["review"]["status"] == "signed_off"
    reopened = client.post(f"{API}/records/{rid}/review", headers=headers, json={"action": "reopen"}).json()
    assert reopened["review"]["status"] == "in_progress"

    # exportaciones
    csv_rec = client.get(f"{API}/records/{rid}/export.csv", headers=headers).text.splitlines()
    assert csv_rec[0].startswith("epoca,hora,inicio_s,prediccion") and len(csv_rec) == 1 + d["night"]["n_epochs"]
    assert "confirmada" in csv_rec[1 + a]
    corr = client.get(f"{API}/corrections/export.csv", headers=headers).text.splitlines()
    assert any(line.startswith(rid) for line in corr[1:])


def test_carga_de_zip_con_hipnograma(client, headers, files):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.write(files["psg"], "SC4001E0-PSG.edf")
        z.write(files["hyp"], "SC4001EC-Hypnogram.edf")
    r = client.post(f"{API}/analyses", headers=headers,
                    files={"file": ("noche.zip", buf.getvalue(), "application/zip")},
                    data={"channels": "fpz,emg", "lights_off": "00:38"})
    assert r.status_code == 202, r.text
    d = wait_done(client, headers, r.json()["id"])
    assert d["status"] == "done" and d["source"] == "upload" and d["has_reference"]
    # 00:38 es la hora del índice para SC4001E0: llega prellenada, no escrita a mano
    assert d["night"]["lights_off_source"] == "dataset-index"
    assert d["quality"]["file"]["size_mb"] > 0


def test_apagado_de_luces_escrito_a_mano(client, headers, files):
    r = client.post(f"{API}/analyses", headers=headers,
                    files={"file": ("SC4001E0-PSG.edf", files["psg"].read_bytes())},
                    data={"channels": "fpz", "window_mode": "full", "lights_off": "00:20"})
    d = wait_done(client, headers, r.json()["id"])
    assert d["night"]["lights_off_clock"] == "00:20" and d["night"]["lights_off_source"] == "manual"
    assert d["night"]["lights_off_epoch"] == 40


def test_carga_de_edf_con_hipnograma_aparte_y_mapeo_manual(client, headers, files):
    r = client.post(f"{API}/analyses", headers=headers,
                    files={"file": ("mi_registro.edf", files["psg"].read_bytes()),
                           "hypnogram": ("ref.edf", files["hyp"].read_bytes())},
                    data={"channels": "fpz", "channel_map": json.dumps({"fpz": "EEG Pz-Oz"}),
                          "window_mode": "full", "lights_off": "none"})
    assert r.status_code == 202, r.text
    d = wait_done(client, headers, r.json()["id"])
    assert d["status"] == "done"
    assert d["channels"]["map"] == {"fpz": "EEG Pz-Oz"} and d["night"]["n_epochs"] == 240
    assert d["dataset"] is None


def test_cargas_invalidas(client, headers, files):
    r = client.post(f"{API}/analyses", headers=headers, files={"file": ("x.txt", b"hola")}, data={"channels": "fpz"})
    assert r.status_code == 422
    r = client.post(f"{API}/analyses", headers=headers,
                    files={"file": ("SC4001EC-Hypnogram.edf", files["hyp"].read_bytes())}, data={"channels": "fpz"})
    assert r.status_code == 422 and "solo un hipnograma" in r.json()["error"]["message"]
    r = client.post(f"{API}/analyses", headers=headers,
                    files={"file": ("a.edf", files["psg"].read_bytes())}, data={"channels": "fpz", "window_mode": "reference"})
    assert r.status_code == 422 and "necesita el hipnograma" in r.json()["error"]["message"]


def test_borrado(client, headers):
    d = _demo(client, headers, channels=["fpz"])
    assert client.delete(f"{API}/records/{d['id']}", headers=headers).json() == {"deleted": d["id"]}
    assert client.get(f"{API}/records/{d['id']}", headers=headers).status_code == 404
    assert client.delete(f"{API}/records/{d['id']}", headers=headers).status_code == 404
