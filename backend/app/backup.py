"""Copia de seguridad de la base (SQLite) en S3.

    python -m app.backup          (en el servidor: cron diario, ver deploy/aws/user-data.sh)

Usa la API de copia de SQLite, que es segura con la API funcionando, y sube el archivo a
SOMNOAI_BACKUP_S3 (s3://bucket/prefijo/) con las credenciales del rol del servidor. Las
señales derivadas no se copian: se pueden regenerar reanalizando la noche.
"""
import os
import sqlite3
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from . import config


def snapshot(dest: Path) -> Path:
    """Copia consistente de la base en `dest`."""
    src = sqlite3.connect(config.DB_PATH)
    dst = sqlite3.connect(dest)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    return dest


def upload(path: Path, target: str, client=None, now: datetime | None = None) -> str:
    """Sube la copia a s3://bucket/prefijo/somnoai-AAAAMMDD-HHMMSS.db y devuelve su ubicación."""
    if not target.startswith("s3://"):
        raise ValueError(f"SOMNOAI_BACKUP_S3 debe ser s3://bucket/prefijo/ (es {target!r})")
    bucket, _, prefix = target.removeprefix("s3://").partition("/")
    stamp = (now or datetime.now(timezone.utc)).strftime("%Y%m%d-%H%M%S")
    key = f"{prefix.strip('/')}/somnoai-{stamp}.db".lstrip("/")
    if client is None:
        import boto3
        client = boto3.client("s3", region_name=config.AWS_REGION)
    client.upload_file(str(path), bucket, key, ExtraArgs={"ServerSideEncryption": "AES256"})
    return f"s3://{bucket}/{key}"


def main() -> int:
    target = os.environ.get("SOMNOAI_BACKUP_S3", "").strip()
    if not target:
        print("SOMNOAI_BACKUP_S3 no está definida: no se hizo la copia.", file=sys.stderr)
        return 1
    with tempfile.TemporaryDirectory() as tmp:
        where = upload(snapshot(Path(tmp) / "somnoai.db"), target)
    print(f"{datetime.now(timezone.utc):%Y-%m-%d %H:%M:%S} UTC · copia de la base en {where}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
