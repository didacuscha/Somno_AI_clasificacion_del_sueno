"""División de la señal de la ventana en épocas de 30 s (lo que recibe el modelo)."""
import numpy as np

from .edf_io import InvalidFile


def samples_per_epoch(fs: float, epoch_s: int) -> int:
    return int(round(fs * epoch_s))


def split(x: np.ndarray, fs: float, n_epochs: int, epoch_s: int) -> np.ndarray:
    """Señal 1D → matriz (n_epochs, muestras por época). La ventana ya viene en épocas
    completas; si la señal es más corta (archivo truncado) se informa en vez de rellenar."""
    spe = samples_per_epoch(fs, epoch_s)
    need = n_epochs * spe
    if spe <= 0:
        raise InvalidFile(f"Frecuencia de muestreo inválida ({fs} Hz).")
    if len(x) < need:
        raise InvalidFile(f"La señal alcanza para {len(x) // spe} épocas de {epoch_s} s y la ventana "
                          f"pide {n_epochs}: el archivo parece truncado.")
    return np.asarray(x[:need], dtype=np.float32).reshape(n_epochs, spe)
