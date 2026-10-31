"""Modelo simulado: probabilidades sintéticas y deterministas.

Para desarrollar la interfaz y correr las pruebas sin ningún modelo cargado. Si
hay hipnograma de referencia parte de él y le agrega los errores típicos del
sistema (N1 confundido con N2, W y REM, como en la Fig. 5 del informe); si no,
inventa una noche plausible. Mismo archivo y mismos canales → mismo resultado.
Las combinaciones más pobres (Pz-Oz solo) se equivocan más, en proporción a su
MF1 de test.
"""
import hashlib
import os
import time
from pathlib import Path

import numpy as np

from .. import config
from .client import StagingRequest, StagingResult

# A qué estadio se va cada error, por estadio real (filas W, N1, N2, N3, REM).
CONFUSION = np.array([
    [0.00, 0.70, 0.15, 0.00, 0.15],
    [0.30, 0.00, 0.45, 0.00, 0.25],
    [0.05, 0.40, 0.00, 0.50, 0.05],
    [0.00, 0.05, 0.95, 0.00, 0.00],
    [0.20, 0.55, 0.25, 0.00, 0.00],
])
ERROR_RATE = np.array([0.06, 0.45, 0.10, 0.18, 0.10])      # con los cuatro canales
DELAY_S = float(os.environ.get("SOMNOAI_MOCK_DELAY", "2"))  # para que se vea el estado «en proceso»


def _synthetic_night(rng: np.random.Generator, n: int, lights_off: int | None) -> np.ndarray:
    """Vigilia, ciclos de ~90 min (N3 al inicio, REM al final) y vigilia otra vez."""
    stages = np.zeros(n, dtype=int)
    onset = max(0, (lights_off if lights_off is not None else 60) + int(rng.integers(20, 60)))
    end = min(n - 20, onset + int(rng.integers(900, 1020)))     # 7,5 – 8,5 h de sueño
    i, cycle = onset, 0
    while i < end:
        for stage, length in ((1, rng.integers(3, 9)), (2, rng.integers(40, 64)),
                              (3, max(4, int((46 - cycle * 11) * rng.uniform(0.7, 1.3)))),
                              (2, rng.integers(20, 42)), (4, int((22 + cycle * 8) * rng.uniform(0.7, 1.3))),
                              (0, rng.integers(1, 6))):
            stages[i:min(i + int(length), end)] = stage
            i += int(length)
        cycle += 1
    return stages


class MockClient:
    kind = "mock"

    def version(self) -> str:
        return "simulado-1.0"

    def stage(self, req: StagingRequest) -> StagingResult:
        t0 = time.perf_counter()
        key = f"{Path(req.psg_path).name}|{req.combination}|{req.start_epoch}|{req.n_epochs}"
        rng = np.random.default_rng(int(hashlib.sha256(key.encode()).hexdigest()[:8], 16))
        n = req.n_epochs

        if req.reference is not None:
            truth = np.asarray(req.reference, dtype=int).copy()
            for i in range(n):                       # épocas sin estadio: se arrastra el anterior
                if truth[i] < 0:
                    truth[i] = truth[i - 1] if i else 0
        else:
            lo = None
            if req.lights_off_s is not None:
                lo = int(req.lights_off_s // req.epoch_s) - req.start_epoch
            truth = _synthetic_night(rng, n, lo)

        weaker = (1 - config.EXPECTED[req.combination]["test_mf1"]) / (1 - 0.784)
        transition = np.zeros(n, dtype=bool)
        transition[1:] |= truth[1:] != truth[:-1]
        transition[:-1] |= truth[:-1] != truth[1:]
        wrong = rng.random(n) < np.clip(ERROR_RATE[truth] * weaker * np.where(transition, 1.8, 1.0), 0, 0.9)

        probs = np.zeros((n, 5))
        for i in range(n):
            t = truth[i]
            pred = rng.choice(5, p=CONFUSION[t]) if wrong[i] else t
            # cuando se equivoca, la correcta suele quedar de 2.ª opción (86 % en el informe)
            second = t if wrong[i] and rng.random() < 0.86 else rng.choice(5, p=CONFUSION[t])
            if second == pred:
                second = (pred + 1) % 5
            conf = rng.uniform(0.36, 0.72) if wrong[i] else 0.45 + 0.55 * rng.beta(8, 1.6)
            if transition[i] and not wrong[i]:
                conf *= rng.uniform(0.75, 1.0)
            conf = float(np.clip(conf, 0.34, 0.995))
            rest = 1 - conf
            share = min(rng.uniform(0.55, 0.9) * rest, conf - 0.02)
            others = [k for k in range(5) if k not in (pred, second)]
            probs[i, pred] = conf
            probs[i, second] = share
            probs[i, others] = rng.dirichlet(np.ones(3)) * (rest - share)

        if DELAY_S:
            time.sleep(DELAY_S)
        return StagingResult(probs=probs, model_version=self.version(),
                             notes=["Resultados simulados: no provienen de ningún modelo entrenado."],
                             timings={"model_s": round(time.perf_counter() - t0, 2)})
