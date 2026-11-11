"""Almacén de la señal de la ventana analizada, un .npy por canal.

Se guarda como int16 con resolución de 0,1 µV (µV × 10). El visor nunca recibe la
señal cruda completa: pide la envolvente mín-máx de la ventana visible
(GET /records/{id}/signal), calculada aquí sobre un memmap. La evidencia espectral
lee de aquí las épocas del EEG y guarda su potencia por bandas para no recalcularla.

Unidades: MNE entrega la señal en voltios y edf_io.read_window la pide en µV (× 10⁶).
El visor la muestra en la unidad que declara el encabezado EDF de cada canal (Sleep-EDF:
«uV»), así que meta.json guarda esa unidad y `display_unit` deshace la escala de MNE.
"""
import json
import shutil
from pathlib import Path

import numpy as np

SCALE = 10.0  # int16 = µV * 10
DEFAULT_UNIT = "uV"     # registros guardados antes de anotar la unidad: siempre se guardaron en µV
_MNE_MICRO = ("uV", "µV", "μV", "\x83\xcaV")   # lo que MNE reconoce como µV (ver mne.io.edf)


def display_unit(raw: str | None) -> tuple[str, float]:
    """Unidad del encabezado EDF → (etiqueta para mostrar, factor desde los µV guardados).

    MNE escala a voltios con 10⁻⁶ si la unidad es µV, 10⁻³ si es mV y 1 en cualquier otro
    caso (V, vacía, «%»…); el factor deshace exactamente eso, así que el valor mostrado es el
    valor físico en la unidad del encabezado."""
    u = (raw if raw is not None else DEFAULT_UNIT).strip()
    to_volts = 1e-6 if u in _MNE_MICRO else 1e-3 if u == "mV" else 1.0
    low = u.lower()
    label = ("µV" if low in ("uv", "µv", "μv") or u == _MNE_MICRO[3] else "mV" if low == "mv"
             else "V" if low == "v" else "nV" if low == "nv" else u)
    return label, 1e-6 / to_volts


def save(record_dir: Path, series: dict[str, np.ndarray], sfreq: float, units: dict[str, str] | None = None):
    """`units`: la unidad del encabezado EDF de cada canal, tal cual (p. ej. «uV»)."""
    record_dir.mkdir(parents=True, exist_ok=True)
    for slot, x_uv in series.items():
        q = np.clip(np.round(x_uv * SCALE), -32767, 32767).astype(np.int16)
        np.save(record_dir / f"{slot}.npy", q)
    units = {slot: (units or {}).get(slot, DEFAULT_UNIT) for slot in series}
    (record_dir / "meta.json").write_text(json.dumps({"sfreq": sfreq, "channels": list(series), "units": units}))


def unit_of(record_dir: Path, slot: str) -> str:
    """Unidad del encabezado EDF de un canal guardado (la de antes de anotarla: µV)."""
    return (meta(record_dir).get("units") or {}).get(slot, DEFAULT_UNIT)


def meta(record_dir: Path) -> dict:
    return json.loads((record_dir / "meta.json").read_text())


def envelope(record_dir: Path, slot: str, start_s: float, duration_s: float, points: int,
             factor: float = 1.0):
    """Mínimo y máximo de la señal en `points` cubetas entre start_s y start_s + duration_s,
    en µV × `factor` (la unidad del encabezado, ver `display_unit`)."""
    sfreq = meta(record_dir)["sfreq"]
    x = np.load(record_dir / f"{slot}.npy", mmap_mode="r")
    i0 = max(0, int(round(start_s * sfreq)))
    i1 = min(len(x), int(round((start_s + duration_s) * sfreq)))
    if i1 <= i0:
        return [0.0] * points, [0.0] * points
    seg = np.asarray(x[i0:i1], dtype=np.float32) / SCALE
    # reparto de n muestras en `points` cubetas; con menos muestras que cubetas se repiten
    edges = np.minimum(np.linspace(0, len(seg), points + 1).astype(int)[:-1], len(seg) - 1)
    mins, maxs = np.minimum.reduceat(seg, edges), np.maximum.reduceat(seg, edges)
    # la resolución guardada (0,1 µV) en la unidad pedida: 1 decimal en µV, 4 en mV, 7 en V
    nd = max(0, 1 + int(round(-np.log10(factor)))) if factor > 0 else 1
    return (np.round(mins.astype(np.float64) * factor, nd).tolist(),
            np.round(maxs.astype(np.float64) * factor, nd).tolist())


def epochs(record_dir: Path, slot: str, n_epochs: int, epoch_s: int) -> tuple[np.ndarray, float]:
    """Señal de un canal en µV como matriz (n_epochs, muestras por época)."""
    sfreq = meta(record_dir)["sfreq"]
    x = np.load(record_dir / f"{slot}.npy", mmap_mode="r")
    spe = int(round(sfreq * epoch_s))
    n = min(n_epochs, len(x) // spe)
    return np.asarray(x[:n * spe], dtype=np.float32).reshape(n, spe) / SCALE, sfreq


def cached(record_dir: Path, name: str, compute):
    """Arreglo derivado de la señal, guardado junto a ella la primera vez que se pide."""
    path = record_dir / f"{name}.npy"
    if path.exists():
        return np.load(path)
    arr = compute()
    np.save(path, arr)
    return arr


def remove(record_dir: str | Path | None):
    if record_dir:
        shutil.rmtree(record_dir, ignore_errors=True)
