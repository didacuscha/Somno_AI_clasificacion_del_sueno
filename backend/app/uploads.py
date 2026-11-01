"""PSG propios subidos por el usuario (US-07): opción secundaria al catálogo.

POST /uploads guarda el archivo, lo valida y responde con los canales que encontró,
antes del paso de canales. Un PSG .edf ya trae todos los canales; el hipnograma .edf
es opcional y solo sirve de referencia (se puede adjuntar después). También se acepta
un .zip con el par PSG + hipnograma.

Cada carga vive en data/store/uploads/<id>/ con un meta.json. Se borra cuando su
análisis termina bien (la señal de la ventana queda guardada aparte); si el análisis
falla se conserva para poder reintentarlo. Las que nadie usó se borran al arrancar
pasadas UPLOAD_TTL_H horas.
"""
import json
import re
import secrets
import shutil
import time
from pathlib import Path
from typing import BinaryIO

from . import channels, config, dataset, db
from .pipeline import edf_io, hypnogram

MB = 1048576


class UploadNotFound(Exception):
    pass


def _dir(upload_id: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{16}", upload_id or ""):
        raise UploadNotFound(upload_id)
    return config.UPLOAD_DIR / upload_id


def _save(stream: BinaryIO, dest: Path) -> int:
    size, limit = 0, config.MAX_UPLOAD_MB * MB
    with open(dest, "wb") as out:
        while chunk := stream.read(MB):
            size += len(chunk)
            if size > limit:
                raise edf_io.InvalidFile(f"El archivo supera el límite de {config.MAX_UPLOAD_MB} MB.")
            out.write(chunk)
    return size


def _check_psg(path: str, name: str) -> dict:
    """Encabezado del PSG, o InvalidFile con lo que está mal."""
    try:
        header = edf_io.read_header(path)
    except edf_io.InvalidFile:
        raise edf_io.InvalidFile(f"«{name}» no es un EDF legible: el encabezado no tiene el formato EDF/EDF+.")
    if header["annotations_only"]:
        raise edf_io.InvalidFile(f"«{name}» es solo un hipnograma (anotaciones, sin señal). Suba el PSG "
                                 "y adjunte el hipnograma como referencia.")
    if header["duration_s"] <= 0:
        raise edf_io.InvalidFile(f"«{name}» no trae señal (0 registros de datos).")
    insp = channels.inspect(header["labels"], header["fs"])
    if not insp["usable"]:
        raise edf_io.InvalidFile(
            f"«{name}» no tiene ninguno de los canales que usa el modelo (EEG Fpz-Cz, EEG Pz-Oz, EOG, EMG "
            f"u otros de esos tipos). Canales del archivo: {', '.join(channels.signal_labels(header['labels']))}.")
    if not insp["has_eeg"]:
        raise edf_io.InvalidFile(f"«{name}» no tiene ningún canal de EEG y el modelo necesita al menos uno "
                                 f"(Fpz-Cz o Pz-Oz). Canales del archivo: {', '.join(channels.signal_labels(header['labels']))}.")
    return header


def _check_hypnogram(path: str, name: str, header: dict):
    try:
        h = edf_io.read_header(path)
    except edf_io.InvalidFile:
        raise edf_io.InvalidFile(f"«{name}» no es un EDF legible.")
    if not h["annotations_only"]:
        raise edf_io.InvalidFile(f"«{name}» no parece un hipnograma: debe ser un EDF+ que solo trae anotaciones "
                                 "de estadios (p. ej. *-Hypnogram.edf de Sleep-EDFx).")
    hypnogram.read_reference(path, int(header["duration_s"] // config.EPOCH_S), header["start"])


def _meta(d: Path) -> dict:
    try:
        return json.loads((d / "meta.json").read_text())
    except (OSError, ValueError):
        raise UploadNotFound(d.name)


def _write_meta(d: Path, meta: dict):
    (d / "meta.json").write_text(json.dumps(meta))


def create(file: BinaryIO, file_name: str, hyp: BinaryIO | None, hyp_name: str | None, created_by: str) -> dict:
    name = Path(file_name or "registro.edf").name
    if not re.search(r"\.(edf|zip)$", name, re.I):
        raise edf_io.InvalidFile("Formato no aceptado: suba un PSG .edf (o un .zip con el PSG y su hipnograma).")
    if hyp is not None and not re.search(r"\.edf$", hyp_name or "", re.I):
        raise edf_io.InvalidFile("El hipnograma debe ser un archivo .edf (EDF+ con anotaciones).")
    uid = secrets.token_hex(8)
    d = config.UPLOAD_DIR / uid
    d.mkdir(parents=True)
    try:
        size = _save(file, d / name)
        if name.lower().endswith(".zip"):
            psg_path, hyp_path, psg_name = edf_io.extract_zip(str(d / name), str(d / "zip"))
            (d / name).unlink()
        else:
            psg_path, hyp_path, psg_name = str(d / name), None, name
        header = _check_psg(psg_path, psg_name)
        hyp_file = None
        if hyp is not None:
            hyp_path = str(d / ("ref-" + Path(hyp_name).name))
            _save(hyp, Path(hyp_path))
        if hyp_path:
            _check_hypnogram(hyp_path, Path(hyp_path).name.removeprefix("ref-"), header)
            hyp_file = Path(hyp_path).relative_to(d).as_posix()
        meta = {"id": uid, "file_name": psg_name, "psg": Path(psg_path).relative_to(d).as_posix(),
                "hypnogram": hyp_file, "size_mb": round(size / MB, 1), "created_at": db.now(),
                "created_by": created_by, "uploaded_at": time.time()}
        _write_meta(d, meta)
        return describe(uid)
    except BaseException:
        shutil.rmtree(d, ignore_errors=True)
        raise


def get(upload_id: str) -> dict:
    """meta.json de la carga, con rutas absolutas."""
    d = _dir(upload_id)
    meta = _meta(d)
    return {**meta, "psg_path": str(d / meta["psg"]),
            "hyp_path": str(d / meta["hypnogram"]) if meta.get("hypnogram") else None}


def describe(upload_id: str) -> dict:
    m = get(upload_id)
    h = edf_io.read_header(m["psg_path"])
    return {
        "id": m["id"], "file_name": m["file_name"], "size_mb": m["size_mb"],
        "header": {k: h[k] for k in ("labels", "fs", "duration_s", "start_clock_s", "n_channels", "patient")},
        "channels": channels.inspect(h["labels"], h["fs"]),
        "hypnogram": {"name": Path(m["hyp_path"]).name.removeprefix("ref-")} if m["hyp_path"] else None,
        "dataset": dataset.lookup(m["file_name"]),
    }


def attach_hypnogram(upload_id: str, stream: BinaryIO, name: str) -> dict:
    d, m = _dir(upload_id), get(upload_id)
    if not re.search(r"\.edf$", name or "", re.I):
        raise edf_io.InvalidFile("El hipnograma debe ser un archivo .edf (EDF+ con anotaciones).")
    dest = d / ("ref-" + Path(name).name)
    tmp = dest.with_name(dest.stem + ".part.edf")      # MNE elige el lector por la extensión
    try:
        _save(stream, tmp)
        _check_hypnogram(str(tmp), Path(name).name, edf_io.read_header(m["psg_path"]))
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    if m["hyp_path"] and Path(m["hyp_path"]) != dest:
        Path(m["hyp_path"]).unlink(missing_ok=True)
    tmp.replace(dest)
    meta = _meta(d)
    meta["hypnogram"] = dest.name
    _write_meta(d, meta)
    return describe(upload_id)


def remove_hypnogram(upload_id: str) -> dict:
    d, m = _dir(upload_id), get(upload_id)
    if m["hyp_path"]:
        Path(m["hyp_path"]).unlink(missing_ok=True)
    meta = _meta(d)
    meta["hypnogram"] = None
    _write_meta(d, meta)
    return describe(upload_id)


def delete(upload_id: str):
    try:
        shutil.rmtree(_dir(upload_id), ignore_errors=True)
    except UploadNotFound:
        pass


def purge_stale() -> int:
    """Cargas viejas que ningún análisis usa (el usuario subió y no analizó)."""
    n, limit = 0, time.time() - config.UPLOAD_TTL_H * 3600
    for d in config.UPLOAD_DIR.iterdir():
        if not d.is_dir():
            continue
        try:
            stamp = _meta(d).get("uploaded_at", 0)
        except UploadNotFound:
            stamp = d.stat().st_mtime
        if stamp < limit and not db.upload_in_use(d.name):
            shutil.rmtree(d, ignore_errors=True)
            n += 1
    return n
