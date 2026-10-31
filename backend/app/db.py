"""Persistencia: SQLite (stdlib) + JSON.

- records:      un análisis por fila. `detail` es la salida del modelo (no cambia una
                vez terminado); `review` resume el estado de la revisión y se actualiza
                con cada corrección. La señal vive aparte (signals.py).
- corrections:  la decisión vigente del especialista para cada época que tocó.
- history:      bitácora de todo cambio (quién, qué y cuándo); nunca se borra una entrada
                mientras exista el registro.
"""
import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime

from . import config

_lock = threading.Lock()

_SCHEMA = """
CREATE TABLE IF NOT EXISTS records(
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL,            -- queued | running | done | failed
    summary TEXT NOT NULL,
    detail TEXT,
    review TEXT,
    progress TEXT,
    error TEXT,
    signal_dir TEXT);
CREATE TABLE IF NOT EXISTS corrections(
    record_id TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    stage INTEGER NOT NULL,
    author TEXT NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY(record_id, epoch));
CREATE TABLE IF NOT EXISTS history(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    record_id TEXT NOT NULL,
    at TEXT NOT NULL,
    author TEXT NOT NULL,
    action TEXT NOT NULL,            -- set | clear | sign_off | reopen
    epoch INTEGER,
    stage INTEGER,
    previous INTEGER);
"""


def now() -> str:
    return datetime.now().strftime("%Y-%m-%dT%H:%M:%S")


@contextmanager
def _conn():
    with _lock:
        c = sqlite3.connect(config.DB_PATH, timeout=30)
        c.row_factory = sqlite3.Row
        try:
            with c:
                yield c
        finally:
            c.close()


def init():
    with _conn() as c:
        c.executescript(_SCHEMA)


def _row(r: sqlite3.Row | None) -> dict | None:
    if r is None:
        return None
    out = dict(r)
    for k in ("summary", "detail", "review", "progress"):
        if k in out:
            out[k] = json.loads(out[k]) if out[k] else None
    return out


# ── registros ─────────────────────────────────────────────────────────
def insert(record_id: str, summary: dict, progress: dict):
    with _conn() as c:
        c.execute("INSERT INTO records(id, created_at, status, summary, progress) VALUES (?,?,?,?,?)",
                  (record_id, summary["created_at"], "queued", json.dumps(summary), json.dumps(progress)))


def set_progress(record_id: str, progress: dict, status: str = "running"):
    with _conn() as c:
        c.execute("UPDATE records SET status=?, progress=? WHERE id=?",
                  (status, json.dumps(progress), record_id))


def finish(record_id: str, summary: dict, detail: dict, review: dict, signal_dir: str):
    with _conn() as c:
        c.execute("UPDATE records SET status='done', summary=?, detail=?, review=?, progress=NULL, "
                  "signal_dir=? WHERE id=?",
                  (json.dumps(summary), json.dumps(detail), json.dumps(review), signal_dir, record_id))


def fail(record_id: str, message: str):
    with _conn() as c:
        c.execute("UPDATE records SET status='failed', error=?, progress=NULL WHERE id=?", (message, record_id))


def mark_interrupted() -> int:
    """Al arrancar: los análisis que quedaron a medias murieron con el proceso anterior."""
    with _conn() as c:
        return c.execute("UPDATE records SET status='failed', progress=NULL, error=? "
                         "WHERE status IN ('queued','running')",
                         ("El análisis se interrumpió porque el servidor se reinició. Láncelo de nuevo.",)).rowcount


def get(record_id: str) -> dict | None:
    with _conn() as c:
        return _row(c.execute("SELECT * FROM records WHERE id=?", (record_id,)).fetchone())


def list_all() -> list[dict]:
    with _conn() as c:
        rows = c.execute("SELECT id, status, summary, review, progress, error FROM records "
                         "ORDER BY created_at DESC, rowid DESC").fetchall()
    return [_row(r) for r in rows]


def count() -> int:
    with _conn() as c:
        return c.execute("SELECT COUNT(*) FROM records").fetchone()[0]


def delete(record_id: str) -> dict | None:
    with _conn() as c:
        row = c.execute("SELECT status, signal_dir FROM records WHERE id=?", (record_id,)).fetchone()
        if row:
            for table, key in (("records", "id"), ("corrections", "record_id"), ("history", "record_id")):
                c.execute(f"DELETE FROM {table} WHERE {key}=?", (record_id,))
        return dict(row) if row else None


# ── revisión ──────────────────────────────────────────────────────────
def corrections(record_id: str) -> dict[int, dict]:
    with _conn() as c:
        rows = c.execute("SELECT epoch, stage, author, at FROM corrections WHERE record_id=? ORDER BY epoch",
                         (record_id,)).fetchall()
    return {r["epoch"]: dict(r) for r in rows}


def apply_changes(record_id: str, changes: list[tuple[int, int | None, int]], author: str):
    """changes: (época, estadio nuevo o None para volver a la predicción, estadio anterior)."""
    at = now()
    with _conn() as c:
        for epoch, stage, previous in changes:
            if stage is None:
                c.execute("DELETE FROM corrections WHERE record_id=? AND epoch=?", (record_id, epoch))
            else:
                c.execute("INSERT INTO corrections VALUES (?,?,?,?,?) ON CONFLICT(record_id, epoch) "
                          "DO UPDATE SET stage=excluded.stage, author=excluded.author, at=excluded.at",
                          (record_id, epoch, stage, author, at))
            c.execute("INSERT INTO history(record_id, at, author, action, epoch, stage, previous) "
                      "VALUES (?,?,?,?,?,?,?)",
                      (record_id, at, author, "clear" if stage is None else "set", epoch, stage, previous))


def log_action(record_id: str, author: str, action: str):
    with _conn() as c:
        c.execute("INSERT INTO history(record_id, at, author, action) VALUES (?,?,?,?)",
                  (record_id, now(), author, action))


def set_review(record_id: str, review: dict):
    with _conn() as c:
        c.execute("UPDATE records SET review=? WHERE id=?", (json.dumps(review), record_id))


def history(record_id: str, limit: int = 200) -> list[dict]:
    with _conn() as c:
        rows = c.execute("SELECT at, author, action, epoch, stage, previous FROM history "
                         "WHERE record_id=? ORDER BY id DESC LIMIT ?", (record_id, limit)).fetchall()
    return [dict(r) for r in rows]


def all_corrections() -> list[dict]:
    """Todas las correcciones vigentes, ordenadas por registro y época (exportación)."""
    with _conn() as c:
        rows = c.execute("SELECT c.record_id, c.epoch, c.stage, c.author, c.at "
                         "FROM corrections c JOIN records r ON r.id = c.record_id "
                         "ORDER BY r.created_at, c.record_id, c.epoch").fetchall()
    return [dict(r) for r in rows]
