"""Cliente del endpoint asíncrono de SageMaker AI con el stacking del proyecto.

PENDIENTE — lo implementa el equipo de modelo. La aplicación ya está lista para
usarlo: basta con completar `stage()` y arrancar la API con SOMNOAI_MODEL=sagemaker.

Flujo esperado (informe, sección VI):
  1. subir `req.psg_path` a S3 (o usar la ubicación que ya tenga la noche de test);
  2. invocar el endpoint asíncrono con la ubicación del EDF, la máscara de canales
     `req.mask` / `req.channels`, la ventana (`req.start_epoch`, `req.n_epochs`) y
     `req.lights_off_s`;
  3. esperar la respuesta en S3 (OutputLocation / FailureLocation). El endpoint
     baja a cero instancias tras 5 min sin uso, así que el primer análisis puede
     tardar varios minutos en encenderlo: el trabajo corre en segundo plano y la
     interfaz lo muestra «en proceso» mientras tanto;
  4. devolver un StagingResult con las probabilidades por época (n_epochs × 5, orden
     W, N1, N2, N3, REM), la versión del modelo registrada en MLflow y, si el modelo
     las trae, sus reglas de confianza (umbral 0,65 y aviso de noche 27,3 %).

Lo demás (estadio, confianza, 2.ª opción, marcas de revisión, métricas, correcciones)
lo deriva la aplicación. Detalle del contrato y ejemplo de JSON en
docs/MODEL_INTEGRATION.md.

Variables sugeridas: SOMNOAI_SAGEMAKER_ENDPOINT, SOMNOAI_S3_BUCKET, AWS_REGION y las
credenciales de AWS Academy en el entorno (nunca en el repositorio).
"""
import os

from .client import ModelError, StagingRequest, StagingResult


class SageMakerClient:
    kind = "sagemaker"

    def __init__(self):
        self.endpoint = os.environ.get("SOMNOAI_SAGEMAKER_ENDPOINT", "sistema-sueno")

    def version(self) -> str:
        return os.environ.get("SOMNOAI_SAGEMAKER_MODEL_VERSION", f"sagemaker:{self.endpoint}")

    def stage(self, req: StagingRequest) -> StagingResult:
        raise ModelError("La conexión con el endpoint de SageMaker todavía no está implementada. "
                         "Arranque la API con SOMNOAI_MODEL=provisional o SOMNOAI_MODEL=mock.")
