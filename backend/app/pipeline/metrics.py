"""Métricas de una noche: arquitectura del sueño y concordancia con la referencia.

Se calculan sobre la ventana analizada, igual para la predicción del modelo, para
el hipnograma final (con las correcciones del especialista) y para la referencia.
"""
import numpy as np

from .. import config

K = len(config.STAGES)
EP_MIN = config.EPOCH_S / 60


def _r(v, d=1):
    return None if v is None else round(float(v), d)


def architecture(stages, lights_off_epoch: int | None = None) -> dict:
    """Arquitectura del sueño. El tiempo en cama cuenta desde el apagado de luces
    (o desde el inicio de la ventana si no se conoce) hasta el final de la ventana."""
    s = np.asarray(stages)
    start = min(max(int(lights_off_epoch or 0), 0), len(s))
    s = s[start:]
    sleep = (s >= 1) & (s <= 4)
    tib, tst = len(s) * EP_MIN, sleep.sum() * EP_MIN
    out = {"tib_min": _r(tib), "tst_min": _r(tst),
           "efficiency_pct": _r(100 * tst / tib) if tib else None,
           "sol_min": None, "rem_latency_min": None, "waso_min": None, "awakenings": 0,
           "stages": {}}
    for code, name in enumerate(config.STAGES):
        minutes = (s == code).sum() * EP_MIN
        # vigilia como % del tiempo en cama; los estadios de sueño como % del sueño total
        base = tib if code == 0 else tst
        out["stages"][name] = {"min": _r(minutes), "pct": _r(100 * minutes / base) if base else 0.0}
    if sleep.any():
        onset = int(np.argmax(sleep))
        last = len(sleep) - 1 - int(np.argmax(sleep[::-1]))
        rem = np.where(s[onset:] == 4)[0]
        mid = s[onset:last + 1] == 0
        out["sol_min"] = _r(onset * EP_MIN)
        out["rem_latency_min"] = _r(rem[0] * EP_MIN) if len(rem) else None
        out["waso_min"] = _r(mid.sum() * EP_MIN)
        # despertares: rachas de vigilia de al menos 1 min entre el inicio y el final del sueño
        edges = np.diff(np.concatenate([[0], mid.astype(int), [0]]))
        lengths = np.where(edges == -1)[0] - np.where(edges == 1)[0]
        out["awakenings"] = int((lengths >= 2).sum())
    return out


def agreement(pred, ref) -> dict | None:
    """Concordancia época a época con la referencia (las épocas sin estadio no cuentan)."""
    pred, ref = np.asarray(pred), np.asarray(ref)
    valid = (ref >= 0) & (pred >= 0)
    n = int(valid.sum())
    if n == 0:
        return None
    cm = np.bincount(ref[valid] * K + pred[valid], minlength=K * K).reshape(K, K)
    tp, rows, cols = np.diag(cm), cm.sum(1), cm.sum(0)
    present = (rows + cols) > 0
    f1 = np.divide(2 * tp, rows + cols, out=np.zeros(K), where=present)
    po = tp.sum() / n
    pe = (rows * cols).sum() / n ** 2
    return {
        "n_epochs": n,
        "accuracy": _r(po, 3),
        "mf1": _r(f1[present].mean(), 3),
        "kappa": _r((po - pe) / (1 - pe), 3) if pe < 1 else 1.0,
        "f1": {name: _r(f1[i], 3) for i, name in enumerate(config.STAGES)},
        "confusion": cm.tolist(),          # filas: referencia · columnas: predicción
    }
