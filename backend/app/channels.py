"""Modalidades del modelo: reconocer los canales de un EDF y validar la selección.

El modelo acepta las 12 combinaciones de Fpz-Cz, Pz-Oz o ambos, con EOG y EMG
opcionales. Siempre tiene que haber al menos un EEG.
"""
import re

from . import config


class InvalidSelection(ValueError):
    """Selección de canales inutilizable; el mensaje se muestra al usuario tal cual."""


def normalize(label: str) -> str:
    s = label.strip().lower()
    s = re.sub(r"[–—]", "-", s)
    return re.sub(r"[\s_.]+", "", s)


_PATTERNS = {slot: [re.compile(p) for p in pats] for slot, pats in config.CHANNEL_ALIASES.items()}


def detect(labels: list[str]) -> dict[str, str]:
    """Modalidad → etiqueta del archivo, para las que se reconocen por su nombre."""
    found: dict[str, str] = {}
    for label in labels:
        n = normalize(label)
        for slot, patterns in _PATTERNS.items():
            if slot not in found and any(p.match(n) for p in patterns):
                found[slot] = label
                break
    return found


def ordered(slots) -> list[str]:
    return [s for s in config.SLOTS if s in set(slots)]


def combination_key(slots) -> str:
    """Nombre de la combinación con la convención del proyecto: fpz, pz, eeg2, fpz_eog, …"""
    s = set(slots)
    eeg = "eeg2" if {"fpz", "pz"} <= s else ("fpz" if "fpz" in s else "pz")
    return eeg + ("_eog" if "eog" in s else "") + ("_emg" if "emg" in s else "")


def combination_name(slots) -> str:
    return " + ".join(config.CHANNELS[s]["name"] for s in ordered(slots))


def mask(slots) -> list[bool]:
    """Máscara de cuatro canales (fpz, pz, eog, emg) que recibe el meta-modelo."""
    return [s in set(slots) for s in config.SLOTS]


def resolve(selected: list[str], channel_map: dict[str, str] | None, file_labels: list[str]) -> dict[str, str]:
    """Valida la selección y devuelve modalidad → etiqueta del archivo.

    `channel_map` permite asignar a mano una etiqueta del archivo a una modalidad
    (montajes con nombres distintos); lo que no venga ahí se reconoce por nombre.
    """
    selected = [s.strip() for s in selected if s and s.strip()]
    unknown = [s for s in selected if s not in config.CHANNELS]
    if unknown:
        raise InvalidSelection(f"Canal desconocido: {', '.join(unknown)}. "
                               f"Las modalidades son {', '.join(config.SLOTS)}.")
    if not selected:
        raise InvalidSelection("Seleccione al menos un canal de EEG (Fpz-Cz o Pz-Oz).")
    if not ({"fpz", "pz"} & set(selected)):
        raise InvalidSelection("El modelo necesita al menos un EEG: seleccione Fpz-Cz o Pz-Oz. "
                               "El EOG y el EMG solo complementan al EEG.")

    channel_map = {k: v for k, v in (channel_map or {}).items() if v}
    bad = [k for k in channel_map if k not in config.CHANNELS]
    if bad:
        raise InvalidSelection(f"Asignación de canal desconocida: {', '.join(bad)}.")
    detected = detect(file_labels)
    out: dict[str, str] = {}
    for slot in ordered(selected):
        label = channel_map.get(slot) or detected.get(slot)
        if not label:
            raise InvalidSelection(
                f"El archivo no tiene un canal reconocible como {config.CHANNELS[slot]['label']}. "
                f"Canales presentes: {', '.join(file_labels)}. Desmárquelo o asígnele un canal a mano.")
        if label not in file_labels:
            raise InvalidSelection(f"El canal «{label}» no está en el archivo.")
        out[slot] = label
    labels = list(out.values())
    if len(set(labels)) < len(labels):
        raise InvalidSelection("Un mismo canal del archivo no puede ocupar dos modalidades.")
    return out
