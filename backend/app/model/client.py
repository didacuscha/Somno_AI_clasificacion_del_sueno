"""La costura entre la aplicación y el modelo de estadificación.

La aplicación nunca habla directamente con un modelo: arma un `StagingRequest`,
se lo pasa al cliente activo y recibe un `StagingResult` con las probabilidades
de cada época. Todo lo demás (estadio, confianza, 2.ª opción, marcas de revisión,
métricas) se deriva aquí de esas probabilidades, con la regla del informe.

Clientes disponibles (variable SOMNOAI_MODEL):
  provisional  YASA corriendo en la misma API: resultados reales sobre la señal
               mientras se conecta el endpoint del proyecto.
  mock         probabilidades sintéticas deterministas: desarrollo de la interfaz y CI.
  sagemaker    el endpoint asíncrono del stacking del proyecto (sagemaker_client.py).

El contrato completo que debe cumplir un cliente está en docs/MODEL_INTEGRATION.md.
"""
import logging
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Protocol

import numpy as np

from .. import config

log = logging.getLogger("somnoai.model")


class ModelError(Exception):
    """Falla del modelo; el mensaje se muestra al usuario tal cual."""


@dataclass
class StagingRequest:
    record_id: str
    psg_path: str                       # EDF en disco local (el cliente lo sube adonde haga falta)
    channels: dict[str, str]            # modalidad → etiqueta en el EDF, solo las seleccionadas
    mask: list[bool]                    # (fpz, pz, eog, emg): la máscara de canales del meta-modelo
    combination: str                    # fpz, pz, eeg2, fpz_eog, … (convención del proyecto)
    start_epoch: int                    # primera época de la ventana, desde el inicio del registro
    n_epochs: int                       # épocas de 30 s a estadificar
    lights_off_s: float | None          # apagado de luces en s desde el inicio; None = inicio de la ventana
    channel_fs: dict[str, float] = field(default_factory=dict)   # frecuencia nativa de cada modalidad
    epoch_s: int = config.EPOCH_S
    # Solo para clientes de prueba (mock): el modelo real NO debe usar la referencia.
    reference: np.ndarray | None = None


@dataclass
class StagingResult:
    probs: np.ndarray                   # (n_epochs, 5), orden W, N1, N2, N3, REM; cada fila suma 1
    model_version: str
    # Las reglas de confianza viajan con la versión del modelo (se fijaron con su CV);
    # si el cliente no las trae se usan las del informe.
    threshold: float | None = None
    night_review_fraction: float | None = None
    notes: list[str] = field(default_factory=list)          # avisos para el usuario
    timings: dict[str, float] = field(default_factory=dict) # segundos por etapa (latencia)


class StagingClient(Protocol):
    kind: str                           # provisional | mock | sagemaker

    def version(self) -> str: ...

    def stage(self, req: StagingRequest) -> StagingResult: ...


def check_result(res: StagingResult, req: StagingRequest) -> np.ndarray:
    """Valida la forma de la salida y normaliza cada fila a probabilidades."""
    p = np.asarray(res.probs, dtype=float)
    if p.shape != (req.n_epochs, len(config.STAGES)):
        raise ModelError(f"El modelo devolvió {p.shape[0] if p.ndim else 0} épocas con "
                         f"{p.shape[1] if p.ndim > 1 else 0} probabilidades; se esperaban "
                         f"{req.n_epochs} × {len(config.STAGES)}.")
    if not np.isfinite(p).all() or (p < 0).any():
        raise ModelError("El modelo devolvió probabilidades inválidas (negativas o no numéricas).")
    s = p.sum(axis=1, keepdims=True)
    s[s == 0] = 1.0
    return p / s


@lru_cache(maxsize=1)
def get_client() -> StagingClient:
    kind = config.MODEL_BACKEND
    if kind == "sagemaker":
        from .sagemaker_client import SageMakerClient
        return SageMakerClient()
    if kind == "provisional":
        try:
            from .provisional_client import ProvisionalClient
            return ProvisionalClient()
        except ImportError as e:
            log.warning("No se pudo cargar el modelo provisional (%s); se usa el simulado.", e)
    elif kind != "mock":
        log.warning("SOMNOAI_MODEL=%s no existe; se usa el simulado.", kind)
    from .mock_client import MockClient
    return MockClient()
