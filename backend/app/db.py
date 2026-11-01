"""Persistencia: SQLite (stdlib) + JSON. Todo vive en data/store/somnoai.db y lo
comparten todos los usuarios de la aplicación; sobrevive a reinicios.

- records:       una noche analizada por fila. `spec` es lo que se pidió (fuente,
                 canales, ventana: sirve para reintentar); `progress` los pasos del
                 análisis; `detail` la salida del modelo por época (no cambia una vez
                 terminado); `review` resume el estado de la revisión.
- corrections:   la decisión vigente del especialista para cada época que tocó.
- history:       bitácora de todo cambio (usuario, fecha, acción, valor anterior y
                 nuevo); nunca se borra una entrada mientras exista el registro.
- notes:         observaciones del técnico por noche.
- catalog_cache: encabezados EDF de las noches del catálogo (para no releerlos de S3).
La señal de la ventana vive aparte (signals.py).
"""
import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime

from . import config

_lock = threading.Lock()
SCHEMA_VERSION = 1

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
    signal_dir TEXT,
    spec TEXT,
    attempts INTEGER NOT NULL DEFAULT 1);
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
    action TEXT NOT NULL,            -- set | clear | finalize | reopen | note | retry
    epoch INTEGER,
    stage INTEGER,
    previous INTEGER,
    old_value TEXT,
    new_value TEXT);
CREATE TABLE IF NOT EXISTS notes(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    record_id TEXT NOT NULL,
    at TEXT NOT NULL,
    author TEXT NOT NULL,
    text TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS catalog_cache(
    location TEXT NOT NULL,
    key TEXT NOT NULL,
    etag TEXT NOT NULL,
    size INTEGER NOT NULL,
    header TEXT NOT NULL,
    PRIMARY KEY(location, key));
CREATE INDEX IF NOT EXISTS history_record ON history(record_id, id);
CREATE INDEX IF NOT EXISTS notes_record ON notes(record_id, id);
"""
# columnas que no existían en la primera versión de la base
_ADDED = {"records": [("spec", "TEXT"), ("attempts", "INTEGER NOT NULL DEFAULT 1")],
          "history": [("old_value", "TEXT"), ("new_value", "TEXT")]}


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


def _stage(code) -> str | None:
    return config.STAGES[code] if code is not None and 0 <= code < len(config.STAGES) else None


def init():
    with _conn() as c:
        for table, cols in _ADDED.items():
            have = {r["name"] for r in c.execute(f"PRAGMA table_info({table})")}
            if have:                                  # tabla de la versión anterior
                for name, decl in cols:
                    if name not in have:
                        c.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")
        c.executescript(_SCHEMA)
        if c.execute("PRAGMA user_version").fetchone()[0] < SCHEMA_VERSION:
            _migrate_v1(c)
            c.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")


def _migrate_v1(c: sqlite3.Connection):
    """Base de la primera versión → v1: «sign_off» pasa a «finalize», la bitácora gana
    valor anterior y nuevo, y el estado de la revisión usa los nombres nuevos."""
    from .pipeline import review

    c.execute("UPDATE history SET action='finalize' WHERE action='sign_off'")
    for r in c.execute("SELECT id, detail, review FROM records WHERE status='done' AND detail IS NOT NULL").fetchall():
        detail, old = json.loads(r["detail"]), json.loads(r["review"] or "{}")
        pred = detail["epochs"]["stage"]
        for h in c.execute("SELECT id, action, epoch, stage, previous FROM history WHERE record_id=? "
                           "AND old_value IS NULL AND new_value IS NULL", (r["id"],)).fetchall():
            if h["action"] == "set":
                vals = (_stage(h["previous"]), _stage(h["stage"]))
            elif h["action"] == "clear":
                vals = (_stage(h["previous"]), _stage(pred[h["epoch"]]))
            else:
                continue
            c.execute("UPDATE history SET old_value=?, new_value=? WHERE id=?", (*vals, h["id"]))
        corr = {row["epoch"]: row["stage"] for row in
                c.execute("SELECT epoch, stage FROM corrections WHERE record_id=?", (r["id"],))}
        finalized = {"by": old.get("signed_off_by") or old.get("finalized_by"),
                     "at": old.get("signed_off_at") or old.get("finalized_at")}
        rev = review.state(detail["epochs"], corr, finalized if finalized["by"] else {},
                           detail["model"]["night_review_fraction"])
        c.execute("UPDATE records SET review=? WHERE id=?", (json.dumps(rev), r["id"]))


def _row(r: sqlite3.Row | None) -> dict | None:
    if r is None:
        return None
    out = dict(r)
    for k in ("summary", "detail", "review", "progress", "spec"):
        if k in out:
            out[k] = json.loads(out[k]) if out[k] else None
    return out


# ── registros ─────────────────────────────────────────────────────────
def insert(record_id: str, summary: dict, spec: dict, progress: dict):
    with _conn() as c:
        c.execute("INSERT INTO records(id, created_at, status, summary, progress, spec) VALUES (?,?,?,?,?,?)",
                  (record_id, summary["created_at"], "queued", json.dumps(summary), json.dumps(progress),
                   json.dumps(spec)))


def set_progress(record_id: str, progress: dict, status: str = "running"):
    with _conn() as c:
        c.execute("UPDATE records SET status=?, progress=? WHERE id=?",
                  (status, json.dumps(progress), record_id))


def finish(record_id: str, summary: dict, detail: dict, review: dict, signal_dir: str, progress: dict):
    """Guarda el resultado completo de una vez (una sola transacción)."""
    with _conn() as c:
        c.execute("UPDATE records SET status='done', summary=?, detail=?, review=?, progress=?, error=NULL, "
                  "signal_dir=? WHERE id=?",
                  (json.dumps(summary), json.dumps(detail), json.dumps(review), json.dumps(progress),
                   signal_dir, record_id))


def fail(record_id: str, message: str, progress: dict | None = None):
    """Análisis fallido: sin resultados de ningún tipo para esa noche."""
    with _conn() as c:
        c.execute("UPDATE records SET status='failed', error=?, progress=COALESCE(?, progress), detail=NULL, "
                  "review=NULL, signal_dir=NULL WHERE id=?",
                  (message, json.dumps(progress) if progress else None, record_id))


def requeue(record_id: str, summary: dict, progress: dict):
    """Reintento de un análisis fallido: el mismo registro vuelve a la cola."""
    with _conn() as c:
        c.execute("UPDATE records SET status='queued', summary=?, progress=?, error=NULL, detail=NULL, "
                  "review=NULL, signal_dir=NULL, attempts=attempts+1 WHERE id=?",
                  (json.dumps(summary), json.dumps(progress), record_id))


def interrupted() -> list[dict]:
    """Al arrancar: los análisis que quedaron a medias murieron con el proceso anterior."""
    with _conn() as c:
        rows = c.execute("SELECT id, progress FROM records WHERE status IN ('queued','running')").fetchall()
    return [_row(r) for r in rows]


def get(record_id: str) -> dict | None:
    with _conn() as c:
        return _row(c.execute("SELECT * FROM records WHERE id=?", (record_id,)).fetchone())


def list_all() -> list[dict]:
    with _conn() as c:
        rows = c.execute("SELECT id, status, summary, review, progress, error, attempts FROM records "
                         "ORDER BY created_at DESC, rowid DESC").fetchall()
    return [_row(r) for r in rows]


def count() -> int:
    with _conn() as c:
        return c.execute("SELECT COUNT(*) FROM records").fetchone()[0]


def delete(record_id: str) -> dict | None:
    with _conn() as c:
        row = c.execute("SELECT status, signal_dir, spec FROM records WHERE id=?", (record_id,)).fetchone()
        if row:
            for table, key in (("records", "id"), ("corrections", "record_id"), ("history", "record_id"),
                               ("notes", "record_id")):
                c.execute(f"DELETE FROM {table} WHERE {key}=?", (record_id,))
        return _row(row) if row else None


def upload_in_use(upload_id: str) -> bool:
    with _conn() as c:
        return c.execute("SELECT 1 FROM records WHERE json_extract(spec, '$.source.type')='upload' "
                         "AND json_extract(spec, '$.source.id')=? LIMIT 1", (upload_id,)).fetchone() is not None


# ── revisión ──────────────────────────────────────────────────────────
def corrections(record_id: str) -> dict[int, dict]:
    with _conn() as c:
        rows = c.execute("SELECT epoch, stage, author, at FROM corrections WHERE record_id=? ORDER BY epoch",
                         (record_id,)).fetchall()
    return {r["epoch"]: dict(r) for r in rows}


def apply_changes(record_id: str, changes: list[tuple[int, int | None, int, int]], author: str):
    """changes: (época, estadio nuevo o None para volver al modelo, estadio vigente, estadio del modelo).
    Cada cambio deja su entrada en la bitácora con el valor anterior y el nuevo."""
    at = now()
    with _conn() as c:
        for epoch, stage, previous, model in changes:
            if stage is None:
                c.execute("DELETE FROM corrections WHERE record_id=? AND epoch=?", (record_id, epoch))
            else:
                c.execute("INSERT INTO corrections VALUES (?,?,?,?,?) ON CONFLICT(record_id, epoch) "
                          "DO UPDATE SET stage=excluded.stage, author=excluded.author, at=excluded.at",
                          (record_id, epoch, stage, author, at))
            c.execute("INSERT INTO history(record_id, at, author, action, epoch, stage, previous, old_value, "
                      "new_value) VALUES (?,?,?,?,?,?,?,?,?)",
                      (record_id, at, author, "clear" if stage is None else "set", epoch, stage, previous,
                       _stage(previous), _stage(model if stage is None else stage)))


def log_action(record_id: str, author: str, action: str, old: str | None = None, new: str | None = None):
    with _conn() as c:
        c.execute("INSERT INTO history(record_id, at, author, action, old_value, new_value) VALUES (?,?,?,?,?,?)",
                  (record_id, now(), author, action, old, new))


def set_review(record_id: str, review: dict):
    with _conn() as c:
        c.execute("UPDATE records SET review=? WHERE id=?", (json.dumps(review), record_id))


def history(record_id: str, limit: int = 200) -> list[dict]:
    with _conn() as c:
        rows = c.execute("SELECT at, author, action, epoch, stage, previous, old_value AS old, new_value AS new "
                         "FROM history WHERE record_id=? ORDER BY id DESC LIMIT ?", (record_id, limit)).fetchall()
    return [dict(r) for r in rows]


def all_corrections() -> list[dict]:
    """Todas las correcciones vigentes, ordenadas por registro y época (exportación)."""
    with _conn() as c:
        rows = c.execute("SELECT c.record_id, c.epoch, c.stage, c.author, c.at "
                         "FROM corrections c JOIN records r ON r.id = c.record_id "
                         "ORDER BY r.created_at, c.record_id, c.epoch").fetchall()
    return [dict(r) for r in rows]


# ── notas del técnico ─────────────────────────────────────────────────
def notes(record_id: str) -> list[dict]:
    with _conn() as c:
        rows = c.execute("SELECT id, at, author, text FROM notes WHERE record_id=? ORDER BY id DESC",
                         (record_id,)).fetchall()
    return [dict(r) for r in rows]


def add_note(record_id: str, author: str, text: str):
    """La nota y su entrada en la bitácora se guardan juntas."""
    at = now()
    with _conn() as c:
        c.execute("INSERT INTO notes(record_id, at, author, text) VALUES (?,?,?,?)", (record_id, at, author, text))
        c.execute("INSERT INTO history(record_id, at, author, action, new_value) VALUES (?,?,?,?,?)",
                  (record_id, at, author, "note", text))


# ── encabezados del catálogo ──────────────────────────────────────────
def cached_headers(location: str) -> dict[str, dict]:
    with _conn() as c:
        rows = c.execute("SELECT key, etag, size, header FROM catalog_cache WHERE location=?", (location,)).fetchall()
    return {r["key"]: {"etag": r["etag"], "size": r["size"], "header": json.loads(r["header"])} for r in rows}


def cache_headers(location: str, items: list[tuple[str, str, int, dict]]):
    with _conn() as c:
        c.executemany("INSERT INTO catalog_cache VALUES (?,?,?,?,?) ON CONFLICT(location, key) "
                      "DO UPDATE SET etag=excluded.etag, size=excluded.size, header=excluded.header",
                      [(location, k, e, s, json.dumps(h)) for k, e, s, h in items])
