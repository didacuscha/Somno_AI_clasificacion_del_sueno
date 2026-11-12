"""Escritura de EDF/EDF+ sintéticos para las pruebas, con la misma estructura de
Sleep-EDFx (registros de 30 s, EEG/EOG a 100 Hz, EMG a 1 Hz; hipnograma EDF+ con
un único registro de duración 0 lleno de TAL)."""
from datetime import datetime

import numpy as np


def _pad(value, width: int) -> bytes:
    return str(value).encode("ascii")[:width].ljust(width)


# rango físico de cada unidad: ±500 µV expresados en esa unidad
_PHYS = {"uV": 500, "mV": 0.5, "V": 0.0005}


def write_psg(path, channels: dict[str, tuple[np.ndarray, float]], start: datetime,
              patient: str = "X F X Female_33yr", record_s: int = 30, units: dict[str, str] | None = None):
    """channels: etiqueta → (señal en µV, frecuencia). Todas cubren la misma duración.
    units: unidad del encabezado de algunos canales («mV», «V»); la señal se escribe en esa
    unidad (el resto, en «uV»)."""
    units = {lab: (units or {}).get(lab, "uV") for lab in channels}
    channels = {lab: (x * _PHYS[units[lab]] / 500, fs) for lab, (x, fs) in channels.items()}
    labels = list(channels)
    spr = [int(fs * record_s) for _, fs in channels.values()]
    n_records = len(next(iter(channels.values()))[0]) // spr[0]
    ns = len(labels)
    head = (_pad("0", 8) + _pad(patient, 80) + _pad(f"Startdate {start:%d-%b-%Y}".upper(), 80)
            + _pad(f"{start:%d.%m.%y}", 8) + _pad(f"{start:%H.%M.%S}", 8) + _pad(256 + ns * 256, 8)
            + _pad("", 44) + _pad(n_records, 8) + _pad(record_s, 8) + _pad(ns, 4))
    dmin, dmax = -32768, 32767
    pmax = {lab: _PHYS[units[lab]] for lab in labels}
    fields = [(16, labels), (80, [""] * ns), (8, [units[lab] for lab in labels]),
              (8, [-pmax[lab] for lab in labels]), (8, [pmax[lab] for lab in labels]),
              (8, [dmin] * ns), (8, [dmax] * ns), (80, [""] * ns), (8, spr), (32, [""] * ns)]
    sig_head = b"".join(_pad(v, w) for w, values in fields for v in values)
    digital = {lab: np.clip(np.round((x + pmax[lab]) * (dmax - dmin) / (2 * pmax[lab]) + dmin), dmin, dmax).astype("<i2")
               for lab, (x, _) in channels.items()}
    with open(path, "wb") as fh:
        fh.write(head + sig_head)
        for r in range(n_records):
            for lab, n in zip(labels, spr):
                fh.write(digital[lab][r * n:(r + 1) * n].tobytes())


def write_hypnogram(path, stages: list[tuple[str, int]], start: datetime,
                    patient: str = "X F X Female_33yr"):
    """stages: [(descripción, número de épocas de 30 s)] en orden desde el inicio."""
    tals, onset = [b"+0\x14\x14\x00"], 0
    for desc, n in stages:
        tals.append(f"+{onset}\x15{n * 30}\x14{desc}\x14\x00".encode())
        onset += n * 30
    body = b"".join(tals)
    spr = (len(body) + 1) // 2 + 1
    body = body.ljust(spr * 2, b"\x00")
    head = (_pad("0", 8) + _pad(patient, 80) + _pad(f"Startdate {start:%d-%b-%Y}".upper(), 80)
            + _pad(f"{start:%d.%m.%y}", 8) + _pad(f"{start:%H.%M.%S}", 8) + _pad(512, 8)
            + _pad("EDF+C", 44) + _pad(1, 8) + _pad(0, 8) + _pad(1, 4))
    fields = [(16, "EDF Annotations"), (80, ""), (8, ""), (8, 0), (8, 1), (8, -32768), (8, 32767),
              (80, ""), (8, spr), (32, "")]
    with open(path, "wb") as fh:
        fh.write(head + b"".join(_pad(v, w) for w, v in fields) + body)


def synthetic_night(hours: float = 2.0, seed: int = 0) -> dict[str, tuple[np.ndarray, float]]:
    """Canales con los nombres de Sleep-EDFx (y uno que el modelo no usa)."""
    rng = np.random.default_rng(seed)
    n100, n1 = int(hours * 3600 * 100), int(hours * 3600)
    t = np.arange(n100) / 100
    return {
        "EEG Fpz-Cz": (40 * np.sin(2 * np.pi * 2 * t) + 10 * rng.standard_normal(n100), 100.0),
        "EEG Pz-Oz": (30 * np.sin(2 * np.pi * 10 * t) + 10 * rng.standard_normal(n100), 100.0),
        "EOG horizontal": (60 * np.sin(2 * np.pi * 0.5 * t) + 15 * rng.standard_normal(n100), 100.0),
        "Resp oro-nasal": (100 * np.sin(2 * np.pi * 0.25 * np.arange(n1)), 1.0),
        "EMG submental": (3 + rng.random(n1), 1.0),
    }


# Noche de prueba (2 h): 40 min de vigilia, 80 min de sueño y 40 min de vigilia.
# Sueño de la época 80 a la 159 → ventana del hipnograma [20, 220).
HYPNOGRAM = [("Sleep stage W", 80), ("Sleep stage 1", 6), ("Sleep stage 2", 30), ("Sleep stage 3", 10),
             ("Sleep stage 4", 6), ("Sleep stage 2", 10), ("Sleep stage R", 14), ("Movement time", 2),
             ("Sleep stage 2", 2), ("Sleep stage W", 80)]
