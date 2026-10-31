"""Regla de confianza y revisión del especialista.

La confianza de una época es la probabilidad del estadio elegido. Si queda bajo el
umbral, la época se marca «revisar» y se ofrecen la 1.ª y la 2.ª opción (informe,
sección III). El especialista confirma o corrige épocas; el hipnograma final es la
predicción con esas correcciones encima. Las métricas se recalculan sobre él.
"""
import numpy as np

from . import metrics


def decide(probs: np.ndarray, threshold: float) -> dict:
    """Estadio, 2.ª opción, confianza y marca de revisión de cada época."""
    p = np.asarray(probs, dtype=float)
    order = np.argsort(-p, axis=1, kind="stable")
    conf = p.max(axis=1)
    return {
        "stage": order[:, 0].astype(int).tolist(),
        "second": order[:, 1].astype(int).tolist(),
        "confidence": np.round(conf, 3).tolist(),
        "review": (conf < threshold).astype(int).tolist(),
        "probs": np.round(p, 3).tolist(),
    }


def final_stages(predicted: list[int], corrections: dict[int, int]) -> list[int]:
    out = list(predicted)
    for epoch, stage in corrections.items():
        if 0 <= epoch < len(out):
            out[epoch] = stage
    return out


def state(epochs: dict, corrections: dict[int, int], signed: dict, night_fraction: float) -> dict:
    """Avance de la revisión: marcadas, resueltas (confirmadas o corregidas) y firma."""
    pred = epochs["stage"]
    flagged = [i for i, f in enumerate(epochs["review"]) if f]
    resolved = [i for i in flagged if i in corrections]
    confirmed = sum(1 for i in resolved if corrections[i] == pred[i])
    changed = sum(1 for i, s in corrections.items() if s != pred[i])
    n = len(pred)
    if signed.get("by"):
        status = "signed_off"
    else:
        status = "in_progress" if corrections else "pending"
    return {
        "status": status,
        "n_epochs": n,
        "flagged": len(flagged),
        "flagged_fraction": round(len(flagged) / n, 4) if n else 0.0,
        "whole_night_recommended": bool(n and len(flagged) / n > night_fraction),
        "resolved": len(resolved),
        "pending": len(flagged) - len(resolved),
        "confirmed": confirmed,
        "corrected": changed,
        "signed_off_by": signed.get("by"),
        "signed_off_at": signed.get("at"),
    }


def derived(detail: dict, corrections: dict[int, int]) -> dict:
    """Lo que cambia con cada corrección: hipnograma final, sus métricas y su concordancia."""
    ep = detail["epochs"]
    final = final_stages(ep["stage"], corrections)
    lo = detail["night"].get("lights_off_epoch")
    out = {"final": final, "metrics_final": metrics.architecture(final, lo), "agreement_final": None}
    if ep.get("reference") is not None:
        out["agreement_final"] = metrics.agreement(final, ep["reference"])
    return out
