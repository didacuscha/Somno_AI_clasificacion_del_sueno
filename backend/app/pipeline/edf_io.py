"""Lectura de archivos PSG (.edf) y paquetes .zip (PSG + hipnograma opcional).

- `parse_header` lee el encabezado desde bytes: sirve igual para un archivo local
  que para los primeros KB de un objeto de S3 (lectura por rango).
- `read_window` entrega la señal de la ventana de cada canal a su frecuencia nativa
  (lo que recibe el modelo); `to_common_rate` la lleva a una sola frecuencia (visor).
- `subset_edf` copia un EDF con solo algunos canales, byte a byte (sin recuantizar).
- `relabel_edf` copia un EDF cambiando solo el nombre de algunos canales.
"""
import re
import shutil
import zipfile
from datetime import datetime
from pathlib import Path

import numpy as np

HEADER_PROBE = 256 * 33          # encabezado completo de un EDF con hasta 32 canales


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


def header_size(head: bytes) -> int:
    """Bytes del encabezado completo a partir de los primeros 256 (o 0 si no es EDF)."""
    try:
        if len(head) < 256 or _field(head[0:8]) != "0":
            return 0
        ns = int(_field(head[252:256]))
    except ValueError:
        return 0
    return 256 + ns * 256 if 0 < ns < 1000 else 0


def parse_header(raw: bytes, file_size: int | None = None) -> dict:
    """Encabezado EDF/EDF+ sin la señal: canales, frecuencias, inicio y duración."""
    size = header_size(raw[:256])
    if not size:
        raise InvalidFile("El archivo no es un EDF válido (encabezado ilegible).")
    if len(raw) < size:
        raise InvalidFile("El archivo EDF está incompleto o no declara canales.")
    head, ns = raw[:256], (size - 256) // 256
    sig = raw[256:size]
    try:
        n_records = int(_field(head[236:244]))
        rec_dur = float(_field(head[244:252]) or 0)
    except ValueError as e:
        raise InvalidFile("El archivo no es un EDF válido (encabezado ilegible).") from e

    col = lambda off, width: [_field(sig[off + i * width: off + (i + 1) * width]) for i in range(ns)]  # noqa: E731
    labels = col(0, 16)
    units = col(ns * 96, 8)
    try:
        spr = [int(float(v or 0)) for v in col(ns * 216, 8)]      # muestras por registro de datos
    except ValueError as e:
        raise InvalidFile("El archivo no es un EDF válido (encabezado ilegible).") from e
    if n_records < 0 and file_size:                                 # desconocido: se deduce del tamaño
        n_records = max(0, (file_size - size) // (2 * max(sum(spr), 1)))
    duration_s = max(n_records, 0) * rec_dur

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


def read_header(path: str) -> dict:
    try:
        with open(path, "rb") as fh:
            raw = fh.read(HEADER_PROBE)
            size = header_size(raw[:256])
            if size > len(raw):
                raw += fh.read(size - len(raw))
    except OSError as e:
        raise InvalidFile("No se pudo leer el archivo.") from e
    return parse_header(raw, Path(path).stat().st_size)


def read_window(path: str, labels: list[str], start_s: float, end_s: float) -> dict[str, tuple[np.ndarray, float]]:
    """Señal en µV de cada canal pedido entre start_s y end_s (segundos desde el inicio),
    a su frecuencia nativa → {etiqueta: (señal, frecuencia)}.

    Los canales se leen agrupados por frecuencia: MNE avisa de artefactos en los bordes
    si mezcla frecuencias sin precargar el archivo completo (22 h).
    """
    import mne  # import diferido: el arranque de la API no lo necesita

    fs = read_header(path)["fs"]
    groups: dict[float, list[str]] = {}
    for lab in dict.fromkeys(labels):
        groups.setdefault(fs.get(lab, 0.0), []).append(lab)
    out: dict[str, tuple[np.ndarray, float]] = {}
    for rate, group in groups.items():
        if rate <= 0:
            raise InvalidFile(f"El canal «{group[0]}» no declara su frecuencia de muestreo.")
        try:
            raw = mne.io.read_raw_edf(path, include=group, preload=False, verbose="ERROR")
        except Exception as e:
            raise InvalidFile(f"No se pudo leer el EDF: {e}") from e
        sfreq = float(raw.info["sfreq"])
        stop = min(end_s, raw.n_times / sfreq)
        if stop <= start_s:
            raise InvalidFile("La ventana de análisis queda fuera de la señal del archivo.")
        raw.crop(tmin=start_s, tmax=stop - 1.0 / sfreq, include_tmax=True)
        data = raw.get_data(picks=group, units="uV")
        for i, lab in enumerate(group):
            out[lab] = (data[i].astype(np.float32), sfreq)
    return out


def resample(x: np.ndarray, fs: float, target: float) -> np.ndarray:
    """Lleva una señal a otra frecuencia (repetición si el factor es entero, si no interpolación)."""
    if fs == target:
        return x
    factor = target / fs
    if factor.is_integer():
        return np.repeat(x, int(factor))
    n = int(round(len(x) * factor))
    return np.interp(np.arange(n) / factor, np.arange(len(x)), x).astype(np.float32)


def to_common_rate(series: dict[str, tuple[np.ndarray, float]]) -> tuple[dict[str, np.ndarray], float]:
    """Todos los canales a la frecuencia del más rápido y con la misma longitud (visor).
    Los lentos (el EMG de 1 Hz de Sleep-EDFx) se repiten, como hace MNE al precargar."""
    top = max(fs for _, fs in series.values())
    out = {lab: resample(x, fs, top) for lab, (x, fs) in series.items()}
    n = min(len(v) for v in out.values())
    return {lab: v[:n] for lab, v in out.items()}, top


def subset_edf(src: str, dst: str, keep: list[str]):
    """Copia `src` en `dst` con solo los canales `keep` (en el orden del archivo).
    Es una copia exacta de las muestras: se reescribe el encabezado y, en cada
    registro de datos, se copian los bloques de los canales que se quedan."""
    with open(src, "rb") as fh:
        raw = fh.read(HEADER_PROBE)
        size = header_size(raw[:256])
        if not size:
            raise InvalidFile(f"{src} no es un EDF válido.")
        if size > len(raw):
            raw += fh.read(size - len(raw))
        head, ns = bytearray(raw[:256]), (size - 256) // 256
        sig = raw[256:size]
        labels = [_field(sig[i * 16:(i + 1) * 16]) for i in range(ns)]
        idx = [i for i, lab in enumerate(labels) if lab in set(keep)]
        missing = set(keep) - {labels[i] for i in idx}
        if missing:
            raise InvalidFile(f"{src} no tiene los canales {', '.join(sorted(missing))}.")
        widths = (16, 80, 8, 8, 8, 8, 8, 80, 8, 32)       # campos del encabezado de cada señal
        new_sig, off = b"", 0
        for w in widths:
            block = sig[off:off + ns * w]
            new_sig += b"".join(block[i * w:(i + 1) * w] for i in idx)
            off += ns * w
        spr = [int(float(_field(sig[sum(widths[:8]) * ns + i * 8: sum(widths[:8]) * ns + (i + 1) * 8]) or 0))
               for i in range(ns)]
        n_new = len(idx)
        head[184:192] = str(256 + n_new * 256).encode().ljust(8)
        head[252:256] = str(n_new).encode().ljust(4)
        record_bytes = 2 * sum(spr)
        starts = np.concatenate([[0], np.cumsum(spr)[:-1]]) * 2
        with open(dst, "wb") as out:
            out.write(bytes(head) + new_sig)
            fh.seek(size)
            while True:
                rec = fh.read(record_bytes)
                if len(rec) < record_bytes:
                    break
                out.write(b"".join(rec[starts[i]:starts[i] + 2 * spr[i]] for i in idx))


def relabel_edf(src: str, dst: str, renames: dict[str, str]):
    """Copia `src` en `dst` cambiando el nombre de los canales de `renames` (viejo → nuevo).
    Solo se reescriben los campos de etiqueta del encabezado (16 caracteres ASCII);
    las muestras quedan idénticas."""
    head = read_header(src)
    labels = head["labels"]
    missing = set(renames) - set(labels)
    if missing:
        raise InvalidFile(f"{src} no tiene los canales {', '.join(sorted(missing))}.")
    new = [renames.get(lab, lab) for lab in labels]
    if len(set(new)) != len(new):
        raise InvalidFile("Al renombrar los canales quedarían dos con el mismo nombre.")
    for name in renames.values():
        if len(name) > 16 or not name.isascii():
            raise InvalidFile(f"«{name}» no cabe como etiqueta de canal EDF (16 caracteres ASCII).")
    shutil.copyfile(src, dst)
    with open(dst, "r+b") as fh:
        fh.seek(256)
        fh.write(b"".join(lab.encode("ascii").ljust(16) for lab in new))
