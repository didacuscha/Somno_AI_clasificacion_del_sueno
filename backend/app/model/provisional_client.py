"""Modelo provisional: YASA (Vallat y Walker, eLife 2021) sobre la señal real.

NO es el modelo del proyecto. Es un estadificador abierto que corre dentro de la
API para que la aplicación entregue resultados reales mientras se conecta el
endpoint de SageMaker con el stacking. Respeta la selección de canales en lo que
puede:

- EEG: Fpz-Cz o Pz-Oz; con los dos se promedian las probabilidades de cada uno;
- EOG: se usa si está seleccionado;
- EMG: solo si viene a ≥ 80 Hz. YASA no admite la envolvente de 1 Hz de Sleep-EDFx.
"""
import time
import warnings

import numpy as np

from ..pipeline import edf_io
from .client import ModelError, StagingRequest, StagingResult

PROBA_COLUMNS = ["WAKE", "N1", "N2", "N3", "REM"]     # columnas de Hypnogram.proba en YASA ≥ 0.7
CH_TYPE = {"fpz": "eeg", "pz": "eeg", "eog": "eog", "emg": "emg"}


class ProvisionalClient:
    kind = "provisional"

    def __init__(self):
        import yasa  # falla aquí si no está instalado: get_client() cae al simulado

        self._yasa = yasa

    def version(self) -> str:
        return f"yasa-{self._yasa.__version__}-provisional"

    def stage(self, req: StagingRequest) -> StagingResult:
        import mne

        t0 = time.perf_counter()
        notes = []
        slots = [s for s in ("fpz", "pz", "eog", "emg") if s in req.channels]
        if "emg" in slots and req.channel_fs.get("emg", 0) < 80:
            slots.remove("emg")
            notes.append("El modelo provisional no usa el EMG de 1 Hz (la envolvente de Sleep-EDFx); "
                         "el modelo del proyecto sí lo usa.")
        labels = [req.channels[s] for s in slots]
        start = req.start_epoch * req.epoch_s
        series, sfreq = edf_io.load_signals(req.psg_path, labels, start, start + req.n_epochs * req.epoch_s)
        t_read = time.perf_counter()

        info = mne.create_info(labels, sfreq, ch_types=[CH_TYPE[s] for s in slots])
        raw = mne.io.RawArray(np.vstack([series[lab] for lab in labels]) * 1e-6, info, verbose="ERROR")
        eog = req.channels["eog"] if "eog" in slots else None
        emg = req.channels["emg"] if "emg" in slots else None
        runs = []
        for eeg in (s for s in ("fpz", "pz") if s in slots):
            try:
                with warnings.catch_warnings():
                    # los clasificadores de YASA se guardaron con otra versión de scikit-learn
                    warnings.simplefilter("ignore", UserWarning)
                    hyp = self._yasa.SleepStaging(raw, eeg_name=req.channels[eeg], eog_name=eog,
                                                  emg_name=emg).predict()
            except Exception as e:
                raise ModelError(f"El modelo provisional no pudo estadificar el registro: {e}") from e
            runs.append(hyp.proba.reindex(columns=PROBA_COLUMNS).fillna(0.0).to_numpy())
        if len(runs) == 2:
            notes.append("Con los dos EEG se promediaron las probabilidades obtenidas con cada uno.")
        p = np.mean(runs, axis=0)
        # YASA cuenta épocas completas desde el inicio de la señal recortada; si la última
        # quedó incompleta (fin del archivo) se repite la penúltima para cubrir la ventana.
        if len(p) < req.n_epochs:
            p = np.vstack([p, np.repeat(p[-1:], req.n_epochs - len(p), axis=0)])
        return StagingResult(
            probs=p[:req.n_epochs], model_version=self.version(), notes=notes,
            timings={"read_s": round(t_read - t0, 2), "model_s": round(time.perf_counter() - t_read, 2)})
