"""Hipnograma de referencia (EDF+ de anotaciones, p. ej. *-Hypnogram.edf de Sleep-EDFx).

Codificación: 0=W, 1=N1, 2=N2, 3=N3, 4=REM y -1 para épocas sin estadio
(«Sleep stage ?», «Movement time»). Las etapas 3 y 4 de R&K se unen en N3,
como en el entrenamiento del modelo.
"""
from datetime import datetime

import numpy as np

from .. import config
from .edf_io import InvalidFile

_CODES = {"w": 0, "wake": 0, "1": 1, "n1": 1, "2": 2, "n2": 2,
          "3": 3, "4": 3, "n3": 3, "n4": 3, "r": 4, "rem": 4}


def stage_code(description: str) -> int:
    d = description.strip().lower().removeprefix("sleep stage").strip()
    return _CODES.get(d, -1)


def read_reference(hyp_path: str, n_epochs: int, psg_start_iso: str | None = None) -> np.ndarray:
    """Estadio de cada época de 30 s, contando desde el inicio del PSG."""
    import mne

    try:
        ann = mne.read_annotations(hyp_path)
    except Exception as e:
        raise InvalidFile(f"No se pudo leer el hipnograma: {e}") from e
    # Si el hipnograma no empieza a la misma hora que el PSG, se corre su origen.
    offset = 0.0
    if psg_start_iso and ann.orig_time is not None:
        delta = (ann.orig_time.replace(tzinfo=None) - datetime.fromisoformat(psg_start_iso)).total_seconds()
        offset = delta if abs(delta) < 86400 else 0.0
    labels = np.full(n_epochs, -1, dtype=np.int16)
    for onset, duration, desc in zip(ann.onset, ann.duration, ann.description):
        e0 = int(round((onset + offset) / config.EPOCH_S))
        e1 = e0 + int(round(duration / config.EPOCH_S))
        labels[max(0, e0):min(n_epochs, e1)] = stage_code(desc)
    if not (labels >= 0).any():
        raise InvalidFile("El hipnograma no trae estadios reconocibles (W, N1–N3 o S1–S4, REM).")
    return labels


def sleep_window(labels: np.ndarray, margin: int = config.WINDOW_MARGIN_EPOCHS) -> tuple[int, int]:
    """[inicio, fin) de la ventana de sueño: 30 min antes del primer estadio de sueño
    hasta 30 min después del último (el recorte con que se entrenó y evaluó el modelo)."""
    sleep = np.where((labels >= 1) & (labels <= 4))[0]
    if len(sleep) == 0:
        raise InvalidFile("El hipnograma de referencia no tiene ninguna época de sueño: "
                          "use un rango horario o el registro completo.")
    return max(int(sleep[0]) - margin, 0), min(int(sleep[-1]) + margin, len(labels) - 1) + 1
