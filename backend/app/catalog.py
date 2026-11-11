"""Catálogo de noches (US-06): las noches de prueba guardadas en S3 o en una carpeta.

SOMNOAI_CATALOG apunta a una carpeta local (por defecto data/demo) o a una ubicación
de S3 (s3://bucket/prefijo/). Se listan todos los PSG (.edf que no son hipnogramas),
cada uno con el hipnograma de su misma carpeta y noche (SC4ssN… en Sleep-EDFx), y lo
que cuelga de `subsets/` son las noches con un subconjunto de canales (US-08).

Para mostrar los canales de cada noche solo se lee su encabezado (los primeros KB,
por rango en S3) y se guarda en la base: listar el catálogo no descarga ninguna
noche. El PSG se descarga al analizarlo y queda en data/store/cache, con un tope.
"""
import hashlib
import logging
import os
import re
import shutil
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path, PurePosixPath
from typing import Callable

from . import channels, config, dataset, db
from .pipeline import edf_io

log = logging.getLogger("somnoai.catalog")
MB = 1048576


class CatalogError(Exception):
    """El catálogo no se pudo leer o la noche no existe; el mensaje se muestra tal cual."""


class NightNotFound(CatalogError):
    pass


@dataclass
class Obj:
    key: str          # ruta relativa a la raíz del catálogo, con «/»
    size: int
    etag: str


def is_hypnogram(name: str) -> bool:
    return "hypno" in name.lower()


def night_key(name: str) -> str:
    """Clave que comparten un PSG y su hipnograma: SC4001E0-PSG / SC4001EC-Hypnogram → SC4001."""
    m = re.match(r"(S[CT]\d{4})", name, re.I)
    if m:
        return m.group(1).upper()
    return re.sub(r"[-_ .]*(psg|hypnogram|hypno)$", "", PurePosixPath(name).stem, flags=re.I).lower()


# ── almacenes ─────────────────────────────────────────────────────────
class LocalStore:
    kind = "local"

    def __init__(self, root: Path):
        self.root = Path(root)
        self.location = str(self.root)

    def list(self) -> list[Obj]:
        if not self.root.is_dir():
            raise CatalogError(f"La carpeta del catálogo no existe: {self.root}.")
        out = []
        for p in self.root.rglob("*"):
            if p.suffix.lower() == ".edf" and p.is_file() and not p.name.startswith("._"):
                st = p.stat()
                out.append(Obj(p.relative_to(self.root).as_posix(), st.st_size, f"{st.st_mtime_ns}-{st.st_size}"))
        return out

    def read_head(self, key: str, n: int) -> bytes:
        with open(self.root / key, "rb") as fh:
            return fh.read(n)

    def fetch(self, key: str, etag: str, on_progress: Callable[[int, int], None] | None = None) -> Path:
        path = self.root / key
        if not path.exists():
            raise NightNotFound(f"La noche {key} ya no está en el catálogo.")
        return path


class S3Store:
    kind = "s3"

    def __init__(self, bucket: str, prefix: str, client=None):
        self.bucket = bucket
        self.prefix = prefix if not prefix or prefix.endswith("/") else prefix + "/"
        self.location = f"s3://{bucket}/{self.prefix}"
        self._client = client

    @property
    def client(self):
        if self._client is None:
            import boto3
            from botocore import UNSIGNED
            from botocore.config import Config

            session = boto3.Session()
            anonymous = config.S3_ANONYMOUS == "1" or (config.S3_ANONYMOUS == "auto" and session.get_credentials() is None)
            cfg = Config(signature_version=UNSIGNED, retries={"max_attempts": 3}) if anonymous else Config(retries={"max_attempts": 3})
            self._client = session.client("s3", region_name=config.AWS_REGION, config=cfg)
            log.info("Catálogo en %s (%s)", self.location, "sin firmar" if anonymous else "con credenciales")
        return self._client

    def _wrap(self, e: Exception, what: str) -> CatalogError:
        code = getattr(e, "response", {}).get("Error", {}).get("Code", type(e).__name__)
        hint = {"NoSuchBucket": "el bucket no existe", "AccessDenied": "sin permiso de lectura",
                "InvalidAccessKeyId": "credenciales de AWS inválidas", "ExpiredToken": "las credenciales de AWS expiraron",
                "NoCredentialsError": "no hay credenciales de AWS"}.get(code, str(e))
        return CatalogError(f"No se pudo {what} en {self.location}: {hint}.")

    def list(self) -> list[Obj]:
        try:
            out = []
            for page in self.client.get_paginator("list_objects_v2").paginate(Bucket=self.bucket, Prefix=self.prefix):
                for o in page.get("Contents", []):
                    rel = o["Key"][len(self.prefix):]
                    name = rel.rsplit("/", 1)[-1]
                    if rel.lower().endswith(".edf") and not name.startswith("._"):
                        out.append(Obj(rel, int(o["Size"]), o["ETag"].strip('"')))
            return out
        except CatalogError:
            raise
        except Exception as e:
            raise self._wrap(e, "listar el catálogo") from e

    def read_head(self, key: str, n: int) -> bytes:
        try:
            r = self.client.get_object(Bucket=self.bucket, Key=self.prefix + key, Range=f"bytes=0-{n - 1}")
            return r["Body"].read()
        except Exception as e:
            raise self._wrap(e, f"leer {key}") from e

    def fetch(self, key: str, etag: str, on_progress: Callable[[int, int], None] | None = None) -> Path:
        """Descarga el objeto a la cache local (o reutiliza la copia si no cambió)."""
        folder = config.CACHE_DIR / hashlib.sha1(f"{self.location}{key}".encode()).hexdigest()[:16]
        path = folder / key.rsplit("/", 1)[-1]
        stamp = folder / ".etag"
        if path.exists() and stamp.exists() and stamp.read_text() == etag:
            os.utime(folder)
            return path
        folder.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".part")
        try:
            size = self.client.head_object(Bucket=self.bucket, Key=self.prefix + key)["ContentLength"]
            got = [0]

            def cb(n):
                got[0] += n
                if on_progress:
                    on_progress(got[0], size)
            self.client.download_file(self.bucket, self.prefix + key, str(tmp), Callback=cb)
        except Exception as e:
            tmp.unlink(missing_ok=True)
            raise self._wrap(e, f"descargar {key}") from e
        tmp.replace(path)
        stamp.write_text(etag)
        _evict(keep=folder)
        return path


def _evict(keep: Path):
    """Borra las noches descargadas menos usadas si la cache supera el tope."""
    dirs = sorted((d for d in config.CACHE_DIR.iterdir() if d.is_dir()), key=lambda d: d.stat().st_mtime)
    size = {d: sum(f.stat().st_size for f in d.iterdir() if f.is_file()) for d in dirs}
    total = sum(size.values())
    for d in dirs:
        if total <= config.CACHE_MAX_MB * MB:
            break
        if d != keep:
            shutil.rmtree(d, ignore_errors=True)
            total -= size[d]


def make_store(location: str, client=None):
    if location.startswith("s3://"):
        bucket, _, prefix = location[5:].partition("/")
        if not bucket:
            raise CatalogError("SOMNOAI_CATALOG debe tener la forma s3://bucket/prefijo/.")
        return S3Store(bucket, prefix, client)
    return LocalStore(Path(location))


# ── catálogo ──────────────────────────────────────────────────────────
class Catalog:
    def __init__(self, store):
        self.store = store
        self._lock = threading.Lock()
        self._nights: list[dict] | None = None
        self._at = 0.0

    @property
    def source(self) -> dict:
        return {"kind": self.store.kind, "location": self.store.location}

    def nights(self, refresh: bool = False) -> list[dict]:
        with self._lock:
            if refresh or self._nights is None or time.time() - self._at > config.CATALOG_TTL_S:
                self._nights = self._scan()
                self._at = time.time()
            return self._nights

    def get(self, night_id: str) -> dict:
        for n in self.nights():
            if n["id"] == night_id:
                return n
        for n in self.nights(refresh=True):          # recién subida al bucket
            if n["id"] == night_id:
                return n
        raise NightNotFound(f"La noche «{night_id}» no está en el catálogo.")

    def fetch_psg(self, night: dict, on_progress=None) -> Path:
        return self.store.fetch(night["id"], night["_etag"], on_progress)

    def fetch_hypnogram(self, night: dict) -> Path | None:
        if not night.get("_hyp_key"):
            return None
        return self.store.fetch(night["_hyp_key"], night["_hyp_etag"])

    def _headers(self, objs: list[Obj]) -> dict[str, dict]:
        cached = db.cached_headers(self.store.location)
        todo = [o for o in objs if o.key not in cached or cached[o.key]["etag"] != o.etag]

        def read(o: Obj):
            try:
                raw = self.store.read_head(o.key, edf_io.HEADER_PROBE)
                need = edf_io.header_size(raw[:256])
                if need > len(raw):
                    raw = self.store.read_head(o.key, need)
                return o, edf_io.parse_header(raw, o.size)
            except (edf_io.InvalidFile, CatalogError) as e:
                log.warning("Se omite %s del catálogo: %s", o.key, e)
                return o, None
        with ThreadPoolExecutor(max_workers=16) as pool:
            fresh = list(pool.map(read, todo))
        db.cache_headers(self.store.location, [(o.key, o.etag, o.size, h) for o, h in fresh if h])
        out = {k: v["header"] for k, v in cached.items()}
        out.update({o.key: h for o, h in fresh if h})
        return out

    def _scan(self) -> list[dict]:
        objs = self.store.list()
        psgs = [o for o in objs if not is_hypnogram(o.key.rsplit("/", 1)[-1])]
        hyps = {}
        for o in objs:
            if is_hypnogram(o.key.rsplit("/", 1)[-1]):
                folder, name = (o.key.rsplit("/", 1) if "/" in o.key else ("", o.key))
                hyps[(folder, night_key(name))] = o
        headers = self._headers(psgs)
        out = []
        for o in psgs:
            h = headers.get(o.key)
            if not h or h["annotations_only"]:
                continue
            folder, name = (o.key.rsplit("/", 1) if "/" in o.key else ("", o.key))
            hyp = hyps.get((folder, night_key(name)))
            ds = dataset.lookup(name)
            insp = channels.inspect(h["labels"], h["fs"])
            out.append({
                "id": o.key,
                "label": ds["id"] if ds else PurePosixPath(name).stem,
                "psg": name,
                "hypnogram": hyp.key.rsplit("/", 1)[-1] if hyp else None,
                "folder": folder,
                "subset": o.key.startswith(config.SUBSET_PREFIX),
                "size_mb": round(o.size / MB, 1),
                "subject": ds["subject"] if ds else None,
                "night": ds["night"] if ds else None,
                "age": (ds or {}).get("age") or h["patient"]["age"],
                "sex": (ds or {}).get("sex") or h["patient"]["sex"],
                "lights_off": ds["lights_off"] if ds else None,
                "split": ds["split"] if ds else None,
                "featured": bool(ds and ds["id"] in config.FEATURED_DEMOS and not o.key.startswith(config.SUBSET_PREFIX)),
                "has_hypnogram": hyp is not None,
                "header": {**{k: h[k] for k in ("labels", "fs", "duration_s", "start", "start_clock_s", "n_channels",
                                                "patient", "annotations_only")}, "units": h.get("units", {})},
                "channels": insp,
                "available": channels.ordered(insp["matched"]),
                "_etag": o.etag,
                "_hyp_key": hyp.key if hyp else None,
                "_hyp_etag": hyp.etag if hyp else None,
            })
        out.sort(key=lambda n: (not n["featured"], n["subset"], n["split"] != "test",
                                n["subject"] if n["subject"] is not None else 999, n["night"] or 0, n["id"]))
        return out


def public(night: dict) -> dict:
    return {k: v for k, v in night.items() if not k.startswith("_")}


@lru_cache(maxsize=1)
def get_catalog() -> Catalog:
    return Catalog(make_store(config.CATALOG))
