"""Regla de confianza y revisión del especialista.

La confianza de una época es la probabilidad del estadio que eligió el modelo. Si
queda bajo el umbral, la época se marca «revisar» y se ofrecen la 1.ª y la 2.ª
opción (informe, sección III). El especialista confirma o corrige épocas; el
hipnograma final es la predicción con esas decisiones encima, y las métricas de la
noche se recalculan sobre él.

Estado de la noche (review.status):
  to_review              analizada, a la espera del especialista (revisión sin iniciar)
  full_review_suggested  ídem, pero se marcó más del 27,3 % de la noche
  in_review              revisión abierta: alguien la inició o la reabrió, o ya hay decisiones
  finalized              revisión finalizada (se puede reabrir)
Solo con la revisión abierta (`open`) se confirman o corrigen épocas. Las decisiones se
guardan en la base una por una, al tomarlas: finalizar no es lo que las guarda.
"""
import numpy as np

from . import metrics

STATUSES = ("to_review", "full_review_suggested", "in_review", "finalized")


def decide(stages, probs, threshold: float) -> dict:
    """Estadio, 2.ª opción, confianza y marca de revisión de cada época."""
    p = np.asarray(probs, dtype=float)
    s = np.asarray(stages, dtype=int)
    rows = np.arange(len(s))
    conf = p[rows, s]
    others = p.copy()
    others[rows, s] = -1.0
    return {
        "stage": s.tolist(),
        "second": others.argmax(axis=1).astype(int).tolist(),
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


def state(epochs: dict, corrections: dict[int, int], finalized: dict, night_fraction: float,
          started: dict | None = None) -> dict:
    """Avance de la revisión: marcadas, resueltas, confirmadas, corregidas y estado de la noche.
    `started` ({by, at}) es quién la inició o la reabrió por última vez."""
    started = started or {}
    pred = epochs["stage"]
    flagged = [i for i, f in enumerate(epochs["review"]) if f]
    resolved = [i for i in flagged if i in corrections]
    n = len(pred)
    whole = bool(n and len(flagged) / n > night_fraction)
    if finalized.get("by"):
        status = "finalized"
    elif corrections or started.get("by"):
        status = "in_review"
    else:
        status = "full_review_suggested" if whole else "to_review"
    return {
        "status": status,
        "n_epochs": n,
        "flagged": len(flagged),
        "flagged_fraction": round(len(flagged) / n, 4) if n else 0.0,
        "whole_night_recommended": whole,
        "resolved": len(resolved),
        "pending": len(flagged) - len(resolved),
        "confirmed": sum(1 for i, s in corrections.items() if s == pred[i]),
        "corrected": sum(1 for i, s in corrections.items() if s != pred[i]),
        "finalized_by": finalized.get("by"),
        "finalized_at": finalized.get("at"),
        "open": status == "in_review",
        "started_by": started.get("by"),
        "started_at": started.get("at"),
    }


def changes(detail: dict, corrections: dict[int, dict]) -> dict:
    """Resumen antes de finalizar: cuántas épocas confirmó y corrigió el revisor, la lista
    de correcciones (`changes`) y la de todas sus decisiones, confirmadas y corregidas
    (`decisions`, con `kind`), para poder deshacer cualquiera desde el resumen."""
    ep, night = detail["epochs"], detail["night"]
    pred = ep["stage"]
    t0 = night.get("start_clock_s")
    decisions = [
        {"epoch": i, "clock_s": t0 + i * night["epoch_s"] if t0 is not None else None,
         "kind": "confirmed" if c["stage"] == pred[i] else "corrected",
         "model_stage": pred[i], "reviewer_stage": c["stage"], "flagged": bool(ep["review"][i]),
         "author": c["author"], "at": c["at"]}
        for i, c in sorted(corrections.items())]
    corrected = [{k: v for k, v in d.items() if k != "kind"} for d in decisions if d["kind"] == "corrected"]
    flagged = [i for i, f in enumerate(ep["review"]) if f]
    return {
        "confirmed": len(decisions) - len(corrected),
        "corrected": len(corrected),
        "pending": sum(1 for i in flagged if i not in corrections),
        "changes": corrected,
        "decisions": decisions,
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
