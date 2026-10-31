"""Ventana de análisis: qué épocas del registro se envían al modelo.

Los registros Sleep Cassette duran ~22 h y casi todo es vigilia diurna. El modelo
se entrenó y evaluó sobre la ventana de sueño (±30 min), así que hay tres modos:

- reference: la ventana de sueño del hipnograma de referencia (el protocolo del modelo);
- range:     un rango horario indicado por el usuario (sin hipnograma);
- full:      el registro completo.
"""
import re

import numpy as np

from .. import config
from .edf_io import InvalidFile
from .hypnogram import sleep_window

MODES = ("reference", "range", "full")


def _fmt(clock_s: float) -> str:
    clock_s = int(clock_s) % 86400
    return f"{clock_s // 3600:02d}:{clock_s // 60 % 60:02d}"


def clock_offset(clock: str, start_clock_s: int) -> float:
    """'HH:MM' → segundos desde el inicio del registro (la primera vez que el reloj
    marca esa hora después del inicio)."""
    m = re.fullmatch(r"(\d{1,2}):(\d{2})(?::(\d{2}))?", (clock or "").strip())
    if not m or int(m[1]) > 23 or int(m[2]) > 59:
        raise InvalidFile(f"Hora no válida: «{clock}». Use el formato HH:MM.")
    seconds = int(m[1]) * 3600 + int(m[2]) * 60 + int(m[3] or 0)
    return float((seconds - start_clock_s) % 86400)


def resolve(mode: str, header: dict, reference: np.ndarray | None,
            start_clock: str | None = None, end_clock: str | None = None) -> dict:
    """→ {mode, start_epoch, end_epoch} con épocas contadas desde el inicio del registro."""
    total = int(header["duration_s"] // config.EPOCH_S)
    span = (f"el registro va de {_fmt(header['start_clock_s'])} a "
            f"{_fmt(header['start_clock_s'] + header['duration_s'])}") if header.get("start_clock_s") is not None else ""
    if mode == "reference":
        if reference is None:
            raise InvalidFile("La ventana del hipnograma necesita el hipnograma de referencia: "
                              "cárguelo junto al PSG o elija un rango horario.")
        a, b = sleep_window(reference[:total])
    elif mode == "range":
        if header.get("start_clock_s") is None:
            raise InvalidFile("El encabezado del EDF no trae la hora de inicio: analice el registro completo.")
        if not start_clock or not end_clock:
            raise InvalidFile("Indique la hora de inicio y la de fin del análisis.")
        s0 = clock_offset(start_clock, header["start_clock_s"])
        s1 = clock_offset(end_clock, header["start_clock_s"])
        if s1 <= s0:
            s1 += 86400
        if s0 >= header["duration_s"]:
            raise InvalidFile(f"La hora de inicio {start_clock} queda fuera del registro ({span}).")
        a, b = int(s0 // config.EPOCH_S), min(int(s1 // config.EPOCH_S), total)
    elif mode == "full":
        a, b = 0, total
    else:
        raise InvalidFile(f"Modo de ventana desconocido: «{mode}».")
    if b - a < config.MIN_WINDOW_EPOCHS:
        raise InvalidFile("La ventana de análisis es demasiado corta: el mínimo son 10 minutos.")
    return {"mode": mode, "start_epoch": a, "end_epoch": b}


def lights_off(clock: str | None, header: dict) -> float | None:
    """Hora de apagado de luces → segundos desde el inicio del registro (None si no hay)."""
    if not clock or header.get("start_clock_s") is None:
        return None
    return clock_offset(clock, header["start_clock_s"])
