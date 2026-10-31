"""Índice de las 153 noches de Sleep-EDFx (Sleep Cassette).

`data/sleep_edfx_index.csv` sale del índice SC-subjects de PhysioNet (edad, sexo,
hora de apagado de luces) y de la partición del proyecto de grado
(particiones.json): `split` = test para los 16 sujetos reservados, dev para los
62 con que se entrenó y validó el modelo.

Sirve para tres cosas: completar la hora de apagado de luces, decir si una noche
cargada la vio el modelo al entrenar (el resultado sería optimista) y armar la
lista de noches demo.
"""
import csv
from functools import lru_cache

from . import config


@lru_cache(maxsize=1)
def _rows() -> list[dict]:
    with open(config.INDEX_PATH, newline="") as fh:
        rows = list(csv.DictReader(fh))
    for r in rows:
        r["subject"], r["night"], r["age"] = int(r["subject"]), int(r["night"]), int(r["age"])
        r["id"] = r["psg"][:8]                       # SC4001E0
    return rows


def lookup(file_name: str | None) -> dict | None:
    """Noche del índice que corresponde a un nombre de archivo (SC4ssN…), o None."""
    if not file_name:
        return None
    key = file_name.split("/")[-1][:6].upper()       # SC4ssN: ss = sujeto, N = noche
    for r in _rows():
        if r["psg"][:6].upper() == key:
            return {k: r[k] for k in ("id", "subject", "night", "age", "sex", "lights_off",
                                      "psg", "hypnogram", "split")}
    return None


def demos() -> list[dict]:
    """Noches del índice cuyos archivos están en DEMO_DIR (las destacadas primero)."""
    out = []
    for r in _rows():
        psg, hyp = config.DEMO_DIR / r["psg"], config.DEMO_DIR / r["hypnogram"]
        if not psg.exists():
            continue
        out.append({**lookup(r["psg"]), "featured": r["id"] in config.FEATURED_DEMOS,
                    "has_hypnogram": hyp.exists()})
    out.sort(key=lambda d: (not d["featured"], d["split"] != "test", d["id"]))
    return out


def demo(demo_id: str) -> dict | None:
    return next((d for d in demos() if d["id"] == demo_id), None)
