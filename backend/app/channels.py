"""Entradas del modelo: reconocer los canales de un EDF y validar la asignación.

El modelo tiene cuatro entradas (Fpz-Cz, Pz-Oz, EOG, EMG) y acepta las 12
combinaciones de Fpz-Cz, Pz-Oz o ambos, con EOG y EMG opcionales: siempre tiene
que haber al menos un EEG.

Cada canal del archivo se clasifica por tipo de señal. Un canal cuyo nombre
coincide con una entrada se le asigna solo; uno del mismo tipo con otro nombre
(p. ej. «C4-M1» para un EEG) se puede asignar a mano; el resto (respiración,
temperatura, marcadores…) está «en el archivo, no lo usa el modelo» y no se
puede asignar a ninguna entrada.
"""
import re

from . import config


class InvalidSelection(ValueError):
    """Selección de canales inutilizable; el mensaje se muestra al usuario tal cual."""


ANNOTATIONS = "EDF Annotations"


def normalize(label: str) -> str:
    s = label.strip().lower()
    s = re.sub(r"[–—]", "-", s)
    return re.sub(r"[\s_.]+", "", s)


_ALIASES = {slot: [re.compile(p) for p in pats] for slot, pats in config.CHANNEL_ALIASES.items()}
_KINDS = {kind: [re.compile(p) for p in pats] for kind, pats in config.CHANNEL_KINDS.items()}


def match_slot(label: str) -> str | None:
    """Entrada del modelo cuyo nombre reconoce la etiqueta, o None."""
    n = normalize(label)
    return next((slot for slot, pats in _ALIASES.items() if any(p.match(n) for p in pats)), None)


def kind_of(label: str) -> str | None:
    """Tipo de señal (eeg, eog, emg) de un canal, o None si el modelo no usa ese tipo."""
    slot = match_slot(label)
    if slot:
        return config.CHANNELS[slot]["kind"]
    n = normalize(label)
    return next((kind for kind, pats in _KINDS.items() if any(p.search(n) for p in pats)), None)


def signal_labels(labels: list[str]) -> list[str]:
    """Las etiquetas con señal (sin el canal de anotaciones de un EDF+)."""
    return [lab for lab in labels if lab != ANNOTATIONS]


def detect(labels: list[str]) -> dict[str, str]:
    """Entrada → etiqueta del archivo, para las que se reconocen por su nombre."""
    found: dict[str, str] = {}
    for label in signal_labels(labels):
        slot = match_slot(label)
        if slot and slot not in found:
            found[slot] = label
    return found


def candidates(slot: str, labels: list[str]) -> list[str]:
    """Canales del archivo que se pueden asignar a una entrada: los de su mismo tipo."""
    kind = config.CHANNELS[slot]["kind"]
    return [lab for lab in signal_labels(labels) if kind_of(lab) == kind]


def inspect(labels: list[str], fs: dict[str, float] | None = None) -> dict:
    """Qué canales del archivo puede usar el modelo y cuáles no (paso de canales)."""
    fs = fs or {}
    sig = signal_labels(labels)
    matched = detect(sig)
    by_label = {lab: slot for slot, lab in matched.items()}
    rows = [{"label": lab, "fs": fs.get(lab), "kind": kind_of(lab), "match": by_label.get(lab),
             "usable": kind_of(lab) is not None} for lab in sig]
    return {
        "channels": rows,
        "matched": matched,
        "candidates": {slot: candidates(slot, sig) for slot in config.SLOTS},
        "total": len(sig),
        "usable": sum(r["usable"] for r in rows),
        "unused": [r["label"] for r in rows if not r["usable"]],
        "has_eeg": any(r["kind"] == "eeg" for r in rows),
    }


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
    """Valida la selección y devuelve entrada → etiqueta del archivo.

    `channel_map` asigna a mano una etiqueta del archivo a una entrada (montajes con
    nombres distintos); lo que no venga ahí se reconoce por nombre. Se rechaza un
    canal que no sea del tipo de la entrada y un mismo canal en dos entradas.
    """
    selected = [s.strip() for s in selected if s and s.strip()]
    unknown = [s for s in selected if s not in config.CHANNELS]
    if unknown:
        raise InvalidSelection(f"Canal desconocido: {', '.join(unknown)}. "
                               f"Las entradas del modelo son {', '.join(config.SLOTS)}.")
    if not selected:
        raise InvalidSelection("Seleccione al menos un canal.")
    if not ({"fpz", "pz"} & set(selected)):
        raise InvalidSelection("El modelo necesita al menos un EEG: seleccione Fpz-Cz o Pz-Oz. "
                               "El EOG y el EMG solo complementan al EEG.")

    channel_map = {k: v for k, v in (channel_map or {}).items() if v}
    bad = [k for k in channel_map if k not in config.CHANNELS]
    if bad:
        raise InvalidSelection(f"Asignación a una entrada desconocida: {', '.join(bad)}.")
    labels = signal_labels(file_labels)
    for slot, label in channel_map.items():
        if label not in labels:
            raise InvalidSelection(f"El canal «{label}» no está en el archivo.")
        if kind_of(label) != config.CHANNELS[slot]["kind"]:
            kind = config.CHANNELS[slot]["kind"].upper()
            raise InvalidSelection(
                f"El canal «{label}» no se puede asignar a {config.CHANNELS[slot]['label']}: esa entrada "
                f"solo acepta un canal de {kind}. «{label}» está en el archivo, pero el modelo no lo usa.")

    detected = detect(labels)
    out: dict[str, str] = {}
    for slot in ordered(selected):
        label = channel_map.get(slot) or detected.get(slot)
        if not label:
            raise InvalidSelection(
                f"El archivo no tiene un canal reconocible como {config.CHANNELS[slot]['label']}. "
                f"Canales presentes: {', '.join(labels)}. Desmárquelo o asígnele un canal a mano.")
        out[slot] = label
    seen: dict[str, str] = {}
    for slot, label in out.items():
        if label in seen:
            raise InvalidSelection(
                f"Un mismo canal del archivo («{label}») no puede ocupar dos entradas del modelo "
                f"({config.CHANNELS[seen[label]]['name']} y {config.CHANNELS[slot]['name']}).")
        seen[label] = slot
    return out
