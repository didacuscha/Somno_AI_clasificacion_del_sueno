"""Lectura de archivos PSG (.edf) y paquetes .zip (PSG + hipnograma opcional)."""
import re
import zipfile
from datetime import datetime
from pathlib import Path

import numpy as np


class InvalidFile(Exception):
    """Archivo inutilizable; el mensaje se muestra al usuario tal cual."""


def extract_zip(zip_path: str, dest: str) -> tuple[str, str | None, str]:
    """Extrae el par PSG + hipnograma → (ruta_psg, ruta_hipnograma|None, nombre_psg)."""
    try:
        with zipfile.ZipFile(zip_path) as z:
            # ignorar lo que mete el Finder de macOS (__MACOSX/, ._archivo)
            names = [n for n in z.namelist()
                     if n.lower().endswith(".edf")
                     and "__macosx" not in n.lower()
                     and not Path(n).name.startswith("._")]
            psg = [n for n in names if "hypno" not in Path(n).name.lower()]
            hyp = [n for n in names if "hypno" in Path(n).name.lower()]
            if not psg:
                raise InvalidFile("El .zip no contiene ningún .edf de PSG (la señal del registro).")
            psg_path = z.extract(psg[0], dest)
            hyp_path = z.extract(hyp[0], dest) if hyp else None
            return psg_path, hyp_path, Path(psg[0]).name
    except zipfile.BadZipFile as e:
        raise InvalidFile("El archivo .zip está dañado o no es un zip válido.") from e


def _field(raw: bytes) -> str:
    return raw.decode("ascii", errors="ignore").strip()


def _parse_patient(patient: str) -> dict:
    """Sexo y edad del campo de paciente. Sleep-EDFx lo escribe «X F X Female_33yr»."""
    age = sex = None
    parts = patient.split()
    if len(parts) >= 2 and parts[1] in ("F", "M"):
        sex = parts[1]
    m = re.search(r"(\d{1,3})\s*yr", patient, re.I)
    if m and 1 <= int(m.group(1)) <= 120:
        age = int(m.group(1))
    return {"age": age, "sex": sex}


def read_header(path: str) -> dict:
    """Encabezado EDF/EDF+ sin cargar la señal: canales, frecuencias, inicio y duración."""
    try:
        with open(path, "rb") as fh:
            head = fh.read(256)
            if len(head) < 256 or _field(head[0:8]) != "0":
                raise InvalidFile("El archivo no es un EDF válido (encabezado ilegible).")
            ns = int(_field(head[252:256]))
            sig = fh.read(ns * 256)
        n_records = int(_field(head[236:244]))
        rec_dur = float(_field(head[244:252]) or 0)
    except (ValueError, OSError) as e:
        raise InvalidFile("El archivo no es un EDF válido (encabezado ilegible).") from e
    if ns <= 0 or len(sig) < ns * 256:
        raise InvalidFile("El archivo EDF está incompleto o no declara canales.")

    col = lambda off, width: [_field(sig[off + i * width: off + (i + 1) * width]) for i in range(ns)]  # noqa: E731
    labels = col(0, 16)
    units = col(ns * 96, 8)
    spr = [int(float(v or 0)) for v in col(ns * 216, 8)]          # muestras por registro de datos
    if n_records < 0:                                               # desconocido: se deduce del tamaño
        header_bytes = 256 + ns * 256
        n_records = max(0, (Path(path).stat().st_size - header_bytes) // (2 * max(sum(spr), 1)))
    duration_s = n_records * rec_dur

    start = start_clock_s = None
    try:
        d, mo, y = (int(v) for v in _field(head[168:176]).split("."))
        h, mi, s = (int(v) for v in _field(head[176:184]).split("."))
        start = datetime(1900 + y if y >= 85 else 2000 + y, mo, d, h, mi, s)
        start_clock_s = h * 3600 + mi * 60 + s
    except ValueError:
        pass

    return {
        "labels": labels,
        "fs": {lab: (n / rec_dur if rec_dur else 0.0) for lab, n in zip(labels, spr)},
        "units": dict(zip(labels, units)),
        "n_channels": ns,
        "duration_s": duration_s,
        "start": start.isoformat() if start else None,
        "start_clock_s": start_clock_s,
        "patient": _parse_patient(_field(head[8:88])),
        "edf_plus": _field(head[192:236]).startswith("EDF+"),
        "annotations_only": all(lab == "EDF Annotations" for lab in labels),
    }


def load_signals(path: str, labels: list[str], start_s: float, end_s: float) -> tuple[dict[str, np.ndarray], float]:
    """Señal en µV de los canales pedidos entre start_s y end_s (segundos desde el inicio),
    toda a la frecuencia del canal más rápido.

    Los canales se leen agrupados por frecuencia: MNE avisa de artefactos en los bordes
    si mezcla frecuencias sin precargar el archivo completo (22 h). Los lentos (el EMG de
    1 Hz de Sleep-EDFx) se repiten hasta la frecuencia mayor, como hace MNE al precargar.
    """
    import mne  # import diferido: el arranque de la API no lo necesita

    fs = read_header(path)["fs"]
    groups: dict[float, list[str]] = {}
    for lab in dict.fromkeys(labels):
        groups.setdefault(fs.get(lab, 0.0), []).append(lab)
    top = max(groups)
    out: dict[str, np.ndarray] = {}
    for rate, group in groups.items():
        try:
            raw = mne.io.read_raw_edf(path, include=group, preload=False, verbose="ERROR")
        except Exception as e:
            raise InvalidFile(f"No se pudo leer el EDF: {e}") from e
        sfreq = float(raw.info["sfreq"])
        stop = min(end_s, raw.n_times / sfreq)
        raw.crop(tmin=start_s, tmax=stop - 1.0 / sfreq, include_tmax=True)
        data = raw.get_data(picks=group, units="uV")
        for i, lab in enumerate(group):
            x = data[i]
            if rate != top:
                factor = top / sfreq
                x = (np.repeat(x, int(factor)) if factor.is_integer()
                     else np.interp(np.arange(int(len(x) * factor)) / factor, np.arange(len(x)), x))
            out[lab] = x.astype(np.float32)
    n = min(len(v) for v in out.values())
    return {lab: v[:n] for lab, v in out.items()}, top
