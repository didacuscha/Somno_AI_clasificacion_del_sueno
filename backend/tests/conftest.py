"""Entorno de pruebas: datos en un directorio temporal, modelo simulado sin demora y
una noche sintética con el nombre de una noche real (SC4001E0) como demo."""
import os
import tempfile
import time
from datetime import datetime
from pathlib import Path

import pytest

_TMP = Path(tempfile.mkdtemp(prefix="somnoai_test_"))
os.environ.update({
    "SOMNOAI_DATA_DIR": str(_TMP / "data"),
    "SOMNOAI_DEMO_DIR": str(_TMP / "demo"),
    "SOMNOAI_MODEL": "mock",
    "SOMNOAI_MOCK_DELAY": "0",
    "SOMNOAI_SEED_DEMOS": "0",
    "SOMNOAI_SECRET": "secreto-de-pruebas",
})

from edf_utils import HYPNOGRAM, synthetic_night, write_hypnogram, write_psg  # noqa: E402

START = datetime(1989, 4, 24, 0, 0, 0)     # la noche sintética va de 00:00 a 02:00


@pytest.fixture(scope="session")
def files() -> dict[str, Path]:
    demo = _TMP / "demo"
    demo.mkdir(parents=True, exist_ok=True)
    psg, hyp = demo / "SC4001E0-PSG.edf", demo / "SC4001EC-Hypnogram.edf"
    write_psg(psg, synthetic_night(2.0), START)
    write_hypnogram(hyp, HYPNOGRAM, START)
    return {"psg": psg, "hyp": hyp, "dir": _TMP}


@pytest.fixture(scope="session")
def client(files):
    from fastapi.testclient import TestClient

    from app.main import app
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="session")
def headers(client) -> dict:
    r = client.post("/api/v1/auth/login", json={"username": "superusuario", "password": "somnoai2026"})
    assert r.status_code == 200, r.text
    return {"Authorization": "Bearer " + r.json()["token"]}


def wait_done(client, headers, record_id: str, timeout: float = 30) -> dict:
    t0 = time.time()
    while time.time() - t0 < timeout:
        r = client.get(f"/api/v1/records/{record_id}", headers=headers)
        assert r.status_code == 200, r.text
        d = r.json()
        if d["status"] in ("done", "failed"):
            return d
        time.sleep(0.1)
    raise AssertionError(f"El análisis {record_id} no terminó en {timeout} s")
