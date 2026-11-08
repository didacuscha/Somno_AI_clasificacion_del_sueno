"""La frontera entre la aplicación y el modelo de estadificación (US-01).

El pipeline (app/jobs.py) solo conoce esta interfaz: arma un `StagingRequest` con
las épocas de 30 s de cada canal seleccionado, se lo pasa al adaptador activo y
recibe un `StagingResult` con el estadio predicho y las probabilidades de los cinco
estadios de cada época. `validate()` revisa esa salida antes de guardar nada: si
faltan épocas, si una fila no suma 1 o si el estadio no es el más probable, el
análisis falla con un mensaje claro en vez de guardar resultados malos.

La versión del modelo y sus reglas de confianza (umbral, aviso de noche completa)
las reporta el propio adaptador en `info()`; quedan guardadas con cada noche.

Adaptadores (variable SOMNOAI_MODEL):
  provisional  YASA corriendo en la misma API.
  api          el modelo del proyecto (stacking) en SageMaker, por su API pública (remote.py).
  mock         doble de pruebas con resultados sintéticos deterministas (CI).

Para conectar otro modelo basta con una clase nueva que cumpla `ModelAdapter` y
registrarla en `get_adapter()`; el pipeline y la interfaz no cambian. Contrato
completo en docs/MODEL_INTEGRATION.md.
"""
import logging
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from functools import lru_cache
from typing import Callable, Protocol, Sequence

import numpy as np

from .. import channels, config

log = logging.getLogger("somnoai.model")
K = len(config.STAGES)


class ModelError(Exception):
    """Falla del modelo; el mensaje se muestra al usuario tal cual."""


class InvalidModelOutput(ModelError):
    """La salida del adaptador no cumple el contrato (no se guarda nada)."""


@dataclass(frozen=True)
class ModelInfo:
    kind: str                           # provisional | mock | …
    name: str                           # nombre para mostrar
    version: str                        # queda guardada con cada noche
    threshold: float = config.CONFIDENCE_THRESHOLD
    night_review_fraction: float = config.NIGHT_REVIEW_FRACTION
    # desempeño de test por combinación de canales, y de dónde sale
    expected: dict = field(default_factory=lambda: config.EXPECTED, compare=False)
    expected_source: str = "Modelo del proyecto, Tabla IV del informe (test, 16 sujetos)"

    def public(self) -> dict:
        d = asdict(self)
        d.pop("expected")
        return d


@dataclass
class StagingRequest:
    record_id: str
    epochs: dict[str, np.ndarray]       # entrada → (n_epochs, muestras por época) en µV, solo las seleccionadas
    fs: dict[str, float]                # entrada → frecuencia de muestreo nativa (el EMG de Sleep-EDFx: 1 Hz)
    labels: dict[str, str]              # entrada → etiqueta del canal en el EDF
    start_epoch: int                    # primera época de la ventana, desde el inicio del registro
    lights_off_s: float | None          # apagado de luces en s desde el inicio del registro; None = inicio de la ventana
    epoch_s: int = config.EPOCH_S
    source: str | None = None           # archivo original (para adaptadores que necesiten el EDF completo)
    progress: Callable[[str], None] | None = None   # mensaje del paso «Predecir» (p. ej. «esperando al modelo»)

    @property
    def n_epochs(self) -> int:
        return next(iter(self.epochs.values())).shape[0]

    @property
    def slots(self) -> list[str]:
        return channels.ordered(self.epochs)

    @property
    def combination(self) -> str:
        return channels.combination_key(self.slots)

    @property
    def mask(self) -> list[bool]:
        return channels.mask(self.slots)


@dataclass
class StagingResult:
    stages: Sequence[int]               # (n_epochs,) estadio predicho 0..4 (W, N1, N2, N3, REM)
    probs: np.ndarray                   # (n_epochs, 5) en ese orden; cada fila suma 1
    notes: list[str] = field(default_factory=list)            # avisos para el usuario
    timings: dict[str, float] = field(default_factory=dict)   # segundos por etapa


class ModelAdapter(Protocol):
    def info(self) -> ModelInfo: ...

    def predict(self, req: StagingRequest) -> StagingResult: ...


def validate(res: StagingResult, req: StagingRequest) -> tuple[np.ndarray, np.ndarray]:
    """Revisa la salida del adaptador → (estadios, probabilidades). Lanza InvalidModelOutput."""
    n = req.n_epochs
    try:
        p = np.asarray(res.probs, dtype=float)
        s = np.asarray(res.stages, dtype=float)
    except (TypeError, ValueError) as e:
        raise InvalidModelOutput("El modelo devolvió estadios o probabilidades que no son números.") from e
    if p.ndim != 2 or p.shape[1] != K:
        raise InvalidModelOutput(f"El modelo debe devolver {K} probabilidades por época (W, N1, N2, N3, REM); "
                                 f"devolvió una tabla de forma {p.shape}.")
    if p.shape[0] != n:
        falta = "faltan" if p.shape[0] < n else "sobran"
        raise InvalidModelOutput(f"El modelo devolvió probabilidades para {p.shape[0]} épocas y la ventana tiene "
                                 f"{n}: {falta} {abs(n - p.shape[0])}.")
    if s.shape != (n,):
        raise InvalidModelOutput(f"El modelo devolvió el estadio de {s.size} épocas y la ventana tiene {n}.")
    if not np.isfinite(p).all() or (p < 0).any():
        raise InvalidModelOutput("El modelo devolvió probabilidades inválidas (negativas o no numéricas).")
    sums = p.sum(axis=1)
    bad = np.flatnonzero(np.abs(sums - 1) > config.PROB_SUM_TOLERANCE)
    if bad.size:
        i = int(bad[0])
        more = f" (y {bad.size - 1} épocas más)" if bad.size > 1 else ""
        raise InvalidModelOutput(f"Las probabilidades de la época {i + 1} suman {sums[i]:.3f}{more}; "
                                 "cada época debe sumar 1.")
    if not np.isfinite(s).all() or (s != np.round(s)).any() or (s < 0).any() or (s >= K).any():
        raise InvalidModelOutput("El modelo devolvió estadios fuera de 0–4 (W, N1, N2, N3, REM).")
    s = s.astype(int)
    p = p / sums[:, None]                       # quita el error de redondeo
    off = np.flatnonzero(p[np.arange(n), s] < p.max(axis=1) - 1e-6)
    if off.size:
        i = int(off[0])
        raise InvalidModelOutput(f"En la época {i + 1} el modelo eligió {config.STAGES[s[i]]}, pero el estadio "
                                 f"más probable según sus propias probabilidades es {config.STAGES[int(p[i].argmax())]}.")
    return s, p


# ── adaptador activo ──────────────────────────────────────────────────
_override: list[ModelAdapter] = []


@lru_cache(maxsize=1)
def _configured() -> ModelAdapter:
    kind = config.MODEL_BACKEND
    if kind == "provisional":
        try:
            from .provisional import ProvisionalAdapter
            return ProvisionalAdapter()
        except ImportError as e:
            log.warning("No se pudo cargar el modelo provisional (%s); se usa el simulado.", e)
    elif kind == "api":
        # sin caer al simulado: si falta la configuración, cada análisis falla diciendo qué falta
        from .remote import RemoteAdapter
        return RemoteAdapter()
    elif kind != "mock":
        log.warning("SOMNOAI_MODEL=%s no existe (use provisional, api o mock); se usa el simulado.", kind)
    from .mock import MockAdapter
    return MockAdapter()


def get_adapter() -> ModelAdapter:
    return _override[-1] if _override else _configured()


@contextmanager
def override(adapter: ModelAdapter):
    """Usa otro adaptador mientras dure el bloque (pruebas)."""
    _override.append(adapter)
    try:
        yield adapter
    finally:
        _override.remove(adapter)
