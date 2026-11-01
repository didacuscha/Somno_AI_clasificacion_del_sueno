"""Modelo provisional: YASA (Vallat y Walker, eLife 2021) sobre la señal real.

NO es el modelo del proyecto. Es un estadificador abierto que corre dentro de la
API para que la aplicación entregue resultados reales mientras se conecta el
stacking del proyecto. Recibe del pipeline las épocas de 30 s de cada canal
seleccionado y respeta la selección en lo que puede:

- EEG: Fpz-Cz o Pz-Oz; con los dos se promedian las probabilidades de cada uno;
- EOG: se usa si está seleccionado;
- EMG: solo si viene a ≥ 80 Hz. YASA no admite la envolvente de 1 Hz de Sleep-EDFx.
"""
import time
import warnings

import numpy as np

from .. import config
from ..pipeline import edf_io
from .adapter import ModelError, ModelInfo, StagingRequest, StagingResult

PROBA_COLUMNS = ["WAKE", "N1", "N2", "N3", "REM"]     # columnas de Hypnogram.proba en YASA ≥ 0.7
CH_TYPE = {"fpz": "eeg", "pz": "eeg", "eog": "eog", "emg": "emg"}


class ProvisionalAdapter:
    def __init__(self):
        import yasa  # falla aquí si no está instalado: get_adapter() cae al simulado

        self._yasa = yasa
        self._info = ModelInfo(kind="provisional", name="Modelo provisional (YASA)",
                               version=f"yasa-{yasa.__version__}-provisional",
                               threshold=config.CONFIDENCE_THRESHOLD,
                               night_review_fraction=config.NIGHT_REVIEW_FRACTION)

    def info(self) -> ModelInfo:
        return self._info

    def predict(self, req: StagingRequest) -> StagingResult:
        import mne

        t0 = time.perf_counter()
        notes = []
        slots = list(req.slots)
        if "emg" in slots and req.fs.get("emg", 0) < 80:
            slots.remove("emg")
            notes.append("El modelo provisional no usa el EMG de 1 Hz (la envolvente de Sleep-EDFx); "
                         "el modelo del proyecto sí lo usa.")
        # YASA recibe un Raw de MNE: todos los canales a la misma frecuencia
        rate = max(req.fs[s] for s in slots)
        series = [edf_io.resample(req.epochs[s].reshape(-1), req.fs[s], rate) for s in slots]
        n = min(len(x) for x in series)
        names = [req.labels[s] for s in slots]
        info = mne.create_info(names, rate, ch_types=[CH_TYPE[s] for s in slots])
        raw = mne.io.RawArray(np.vstack([x[:n] for x in series]) * 1e-6, info, verbose="ERROR")
        eog = req.labels["eog"] if "eog" in slots else None
        emg = req.labels["emg"] if "emg" in slots else None
        runs = []
        for eeg in (s for s in ("fpz", "pz") if s in slots):
            try:
                with warnings.catch_warnings():
                    # los clasificadores de YASA se guardaron con otra versión de scikit-learn
                    warnings.simplefilter("ignore", UserWarning)
                    hyp = self._yasa.SleepStaging(raw, eeg_name=req.labels[eeg], eog_name=eog,
                                                  emg_name=emg).predict()
            except Exception as e:
                raise ModelError(f"El modelo provisional no pudo estadificar el registro: {e}") from e
            runs.append(hyp.proba.reindex(columns=PROBA_COLUMNS).fillna(0.0).to_numpy())
        if len(runs) == 2:
            notes.append("Con los dos EEG se promediaron las probabilidades obtenidas con cada uno.")
        p = np.mean(runs, axis=0)
        return StagingResult(stages=p.argmax(axis=1), probs=p, notes=notes,
                             timings={"model_s": round(time.perf_counter() - t0, 2)})
