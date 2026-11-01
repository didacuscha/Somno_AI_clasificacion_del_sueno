"""Noches con un subconjunto de canales (US-08): el script las crea, el catálogo las
muestra con sus canales y el análisis solo le manda al modelo los que tienen."""
import json

from app import config
from app.model import adapter as model
from conftest import API, SpyAdapter, wait_done


def test_el_script_crea_noches_con_subconjuntos_validos(client, headers, files):
    import make_subset_nights as script

    # plan sobre el catálogo de pruebas (1 noche de test → hasta 11 combinaciones incompletas)
    entries = script.main(["--count", "5", "--seed", "1"])
    assert len(entries) == 5 and len({e["combination"] for e in entries}) == 5
    for e in entries:
        assert {"fpz", "pz"} & set(e["channels"]) and len(e["channels"]) < 4   # siempre con EEG, nunca completa
    manifest = json.loads((files["dir"] / "demo" / "subsets" / "manifest.json").read_text())
    assert [n["folder"] for n in manifest["nights"]] == [e["folder"] for e in entries]

    nights = client.get(f"{API}/catalog", headers=headers, params={"refresh": True}).json()["nights"]
    subsets = {n["folder"].split("/")[-1]: n for n in nights if n["subset"]}
    assert set(subsets) == {e["folder"] for e in entries}
    for e in entries:
        n = subsets[e["folder"]]
        assert n["available"] == e["channels"] and n["has_hypnogram"]
        assert "Resp oro-nasal" in n["channels"]["unused"]                  # conserva lo que el modelo no usa

    # el análisis respeta el subconjunto: solo esos canales llegan al modelo
    e = entries[0]
    spy = SpyAdapter()
    with model.override(spy):
        r = client.post(f"{API}/analyses", headers=headers,
                        json={"source": {"type": "catalog", "id": subsets[e["folder"]]["id"]},
                              "channels": e["channels"]})
        assert r.status_code == 202, r.text
        d = wait_done(client, headers, r.json()["id"])
    assert d["status"] == "done" and d["subset"] and spy.requests[-1].slots == e["channels"]
    missing = next(s for s in config.SLOTS if s not in e["channels"] and s in ("fpz", "pz", "eog", "emg"))
    r = client.post(f"{API}/analyses", headers=headers,
                    json={"source": {"type": "catalog", "id": subsets[e["folder"]]["id"]},
                          "channels": e["channels"] + [missing]})
    assert r.status_code == 422                               # el canal que falta no se puede pedir

    # volver a correrlo no rehace lo que ya existe
    again = script.main(["--count", "5", "--seed", "1"])
    assert [x["folder"] for x in again] == [x["folder"] for x in entries]
