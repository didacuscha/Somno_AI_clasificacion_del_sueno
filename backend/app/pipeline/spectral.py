"""Evidencia espectral de una época: potencia relativa del EEG por bandas de frecuencia.

Función reutilizable (US-11): recibe épocas y frecuencia de muestreo y devuelve, por
época, la fracción de la potencia entre la banda más baja y la más alta que cae en
cada banda (delta, theta, alfa, sigma, beta; ver config.SPECTRAL_BANDS). Se estima
con Welch (ventanas de 4 s con 50 % de solapamiento), como es habitual en EEG de sueño.
"""
import numpy as np
from scipy.signal import welch

from .. import config


def band_powers(epochs: np.ndarray, fs: float, bands: list[dict] | None = None) -> np.ndarray:
    """(n_epochs, muestras) o (muestras,) → (n_epochs, n_bandas) de potencia relativa.
    Una banda por encima de la frecuencia de Nyquist queda en NaN."""
    bands = bands or config.SPECTRAL_BANDS
    x = np.atleast_2d(np.asarray(epochs, dtype=np.float64))
    nper = min(x.shape[1], int(round(4 * fs)))
    f, pxx = welch(x, fs=fs, nperseg=nper, noverlap=nper // 2, axis=-1, detrend="constant")
    lo, hi = min(b["lo"] for b in bands), min(max(b["hi"] for b in bands), fs / 2)
    df = f[1] - f[0] if len(f) > 1 else 1.0
    in_total = (f >= lo) & (f < hi)
    total = pxx[:, in_total].sum(axis=1) * df
    out = np.full((x.shape[0], len(bands)), np.nan)
    for j, b in enumerate(bands):
        if b["lo"] >= fs / 2:
            continue
        sel = (f >= b["lo"]) & (f < min(b["hi"], fs / 2))
        out[:, j] = pxx[:, sel].sum(axis=1) * df
    with np.errstate(invalid="ignore", divide="ignore"):
        out = out / total[:, None]
    out[~np.isfinite(out)] = np.nan
    return out


def closest(values, typical: dict[int, dict], candidates: list[int]) -> int | None:
    """Cuál de los estadios candidatos tiene el perfil típico más parecido al de la época.
    Se compara en escala logarítmica para que delta (casi siempre la mayor) no tape al
    resto de bandas. None si falta el perfil típico de alguno de los candidatos."""
    v = np.asarray(values, dtype=float)
    if not np.isfinite(v).all() or any(c not in typical for c in candidates):
        return None
    lv = np.log(np.clip(v, 1e-4, None))
    dist = {c: float(np.linalg.norm(lv - np.log(np.clip(typical[c]["values"], 1e-4, None)))) for c in candidates}
    return min(dist, key=dist.get)


def typical_profiles(powers: np.ndarray, stages: list[int], trusted: list[bool],
                     min_epochs: int = config.SPECTRAL_MIN_TYPICAL) -> dict[int, dict]:
    """Perfil típico de cada estadio en esta misma noche: la mediana de las épocas
    confiables (sobre el umbral o decididas por un revisor). Sirve de comparación."""
    st, ok = np.asarray(stages), np.asarray(trusted, dtype=bool)
    out = {}
    for code in range(len(config.STAGES)):
        rows = powers[(st == code) & ok]
        rows = rows[np.isfinite(rows).all(axis=1)]
        if len(rows) >= min_epochs:
            out[code] = {"n": int(len(rows)), "values": np.round(np.median(rows, axis=0), 4).tolist()}
    return out
