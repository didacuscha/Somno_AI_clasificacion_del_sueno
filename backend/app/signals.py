"""Almacén de la señal de la ventana analizada, un .npy por canal.

Se guarda como int16 con resolución de 0,1 µV (µV × 10). El visor nunca recibe la
señal cruda completa: pide la envolvente mín-máx de la ventana visible
(GET /records/{id}/signal), calculada aquí sobre un memmap. La evidencia espectral
lee de aquí las épocas del EEG y guarda su potencia por bandas para no recalcularla.
"""
import json
import shutil
from pathlib import Path

import numpy as np

SCALE = 10.0  # int16 = µV * 10


def save(record_dir: Path, series: dict[str, np.ndarray], sfreq: float):
    record_dir.mkdir(parents=True, exist_ok=True)
    for slot, x_uv in series.items():
        q = np.clip(np.round(x_uv * SCALE), -32767, 32767).astype(np.int16)
        np.save(record_dir / f"{slot}.npy", q)
    (record_dir / "meta.json").write_text(json.dumps({"sfreq": sfreq, "channels": list(series)}))


def meta(record_dir: Path) -> dict:
    return json.loads((record_dir / "meta.json").read_text())


def envelope(record_dir: Path, slot: str, start_s: float, duration_s: float, points: int):
    """Mínimo y máximo de la señal en `points` cubetas entre start_s y start_s + duration_s."""
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
    return np.round(mins, 1).tolist(), np.round(maxs, 1).tolist()


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
