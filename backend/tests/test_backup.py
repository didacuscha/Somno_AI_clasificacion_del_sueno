"""Copia de seguridad de la base en S3 (sin red: cliente de S3 falso)."""
import sqlite3
from datetime import datetime, timezone

import pytest

from app import backup, config


class FakeS3:
    def __init__(self):
        self.calls = []

    def upload_file(self, path, bucket, key, ExtraArgs=None):
        with sqlite3.connect(path) as con:                     # lo que se sube es una base legible
            tables = {r[0] for r in con.execute("select name from sqlite_master where type='table'")}
        self.calls.append({"bucket": bucket, "key": key, "extra": ExtraArgs, "tables": tables})


def test_copia_consistente_y_subida(tmp_path, client):           # client: la API ya creó la base
    s3 = FakeS3()
    when = datetime(2026, 11, 8, 3, 15, 0, tzinfo=timezone.utc)
    where = backup.upload(backup.snapshot(tmp_path / "copia.db"), "s3://mi-bucket/backups/", s3, when)
    assert where == "s3://mi-bucket/backups/somnoai-20261108-031500.db"
    (call,) = s3.calls
    assert call["bucket"] == "mi-bucket" and call["key"] == "backups/somnoai-20261108-031500.db"
    assert call["extra"] == {"ServerSideEncryption": "AES256"}
    with sqlite3.connect(config.DB_PATH) as con:
        original = {r[0] for r in con.execute("select name from sqlite_master where type='table'")}
    assert call["tables"] == original and original


def test_destino_invalido(tmp_path):
    with pytest.raises(ValueError, match="s3://"):
        backup.upload(tmp_path / "x.db", "mi-bucket/backups", FakeS3())


def test_sin_destino_no_hace_nada(monkeypatch, capsys):
    monkeypatch.delenv("SOMNOAI_BACKUP_S3", raising=False)
    assert backup.main() == 1 and "no está definida" in capsys.readouterr().err
