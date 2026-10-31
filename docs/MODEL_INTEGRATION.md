# Integración del modelo — guía para el equipo de modelo

La aplicación nunca habla directamente con un modelo: habla con un **cliente** que cumple
una interfaz pequeña (`backend/app/model/client.py`). Hoy hay tres:

| `SOMNOAI_MODEL` | Cliente | Para qué |
|---|---|---|
| `provisional` (por defecto) | `provisional_client.py` | YASA corriendo en la API: resultados reales sobre la señal mientras se conecta el endpoint. |
| `mock` | `mock_client.py` | Probabilidades sintéticas deterministas: interfaz y CI. |
| `sagemaker` | `sagemaker_client.py` | **Pendiente**: el endpoint asíncrono con el stacking del proyecto. |

Conectar el modelo del proyecto = implementar `SageMakerClient.stage()` y arrancar la API
con `SOMNOAI_MODEL=sagemaker`. No hay que tocar nada más: la interfaz, la revisión del
especialista, las métricas y la exportación ya funcionan con cualquier cliente.

## 1 · Lo que recibe el cliente: `StagingRequest`

| Campo | Tipo | Significado |
|---|---|---|
| `record_id` | str | id del análisis (útil como prefijo en S3). |
| `psg_path` | str | ruta local del EDF del PSG (el cliente lo sube a S3 si hace falta). |
| `channels` | dict | modalidad → etiqueta en el EDF, **solo las seleccionadas**. Ej.: `{"fpz": "EEG Fpz-Cz", "eog": "EOG horizontal"}`. Puede traer etiquetas distintas a las de Sleep-EDFx si el usuario asignó canales a mano. |
| `mask` | list[bool] | `(fpz, pz, eog, emg)`: la misma máscara de 4 canales del meta-modelo. |
| `combination` | str | `fpz`, `pz`, `eeg2`, `fpz_eog`, …, `eeg2_eog_emg` (convención de `particiones.json`). |
| `start_epoch` | int | primera época de la ventana, contada desde el inicio del registro (épocas de 30 s). |
| `n_epochs` | int | épocas a estadificar. |
| `lights_off_s` | float \| None | apagado de luces en segundos desde el inicio del registro. `None` → tomar el inicio de la ventana (regla del informe). Alimenta el rasgo «horas desde que se apagó la luz» del modelo A. |
| `channel_fs` | dict | frecuencia nativa de cada modalidad seleccionada (el EMG de Sleep-EDFx viene a 1 Hz). |
| `reference` | ndarray \| None | **siempre `None` para el modelo real** (solo lo usa el simulado). |

La ventana ya viene resuelta: con hipnograma de referencia es la ventana de sueño ±30 min
(la misma de `particiones.json`: SC4001E0 da 841 épocas, de la 961 a la 1801); sin él, el
rango horario o el registro completo que eligió el usuario.

## 2 · Lo que devuelve el cliente: `StagingResult`

| Campo | Tipo | Obligatorio | Significado |
|---|---|---|---|
| `probs` | ndarray `(n_epochs, 5)` | sí | probabilidades por época en el orden **W, N1, N2, N3, REM**. La fila `i` es la época `start_epoch + i`. |
| `model_version` | str | sí | versión registrada en MLflow (p. ej. `sistema-sueno/1`). Queda guardada con cada análisis. |
| `threshold` | float | no | umbral de confianza del modelo (0,65). Si falta se usa el del informe. |
| `night_review_fraction` | float | no | límite para sugerir revisar la noche completa (0,273). |
| `notes` | list[str] | no | avisos para el usuario (se muestran en la vista de resultados). |
| `timings` | dict | no | segundos por etapa (`read_s`, `model_a_s`, `model_b_s`, `meta_s`, `endpoint_s`…). Se muestran y guardan: sirven para medir la latencia que pide la sección VII. |

`check_result()` valida la forma (`n_epochs × 5`, valores finitos y no negativos) y
normaliza cada fila. Si algo sale mal, el cliente debe lanzar `ModelError("mensaje en
español")`: el análisis queda como fallido y el usuario ve ese mensaje.

Todo lo demás lo deriva la aplicación con la regla del informe: estadio = argmax, confianza
= su probabilidad, 2.ª opción, marca de revisión si `confianza < threshold`, aviso de noche
completa, arquitectura del sueño, concordancia con la referencia y correcciones del especialista.
Por eso basta con las probabilidades: las reglas de decisión quedan en un solo lugar.

## 3 · Un formato posible para el endpoint asíncrono

El informe describe un endpoint que recibe la ubicación del EDF en S3 y los canales, y
escribe en S3 la respuesta por época. Un JSON que encaja con este contrato:

```json
// InputLocation (s3://<bucket>/entradas/<record_id>.json)
{
  "edf": "s3://<bucket>/entradas/<record_id>/SC4001E0-PSG.edf",
  "channels": { "fpz": "EEG Fpz-Cz", "pz": "EEG Pz-Oz", "eog": "EOG horizontal", "emg": "EMG submental" },
  "mask": [true, true, true, true],
  "start_epoch": 961,
  "n_epochs": 841,
  "lights_off_s": 30300
}
```
```json
// OutputLocation
{
  "model_version": "sistema-sueno/1",
  "threshold": 0.65,
  "night_review_fraction": 0.273,
  "probs": [[0.98, 0.01, 0.01, 0.0, 0.0], "… una fila por época …"],
  "timings": { "read_s": 1.9, "model_a_s": 3.2, "model_b_s": 3.9, "meta_s": 0.01 }
}
```

Esbozo de `stage()` (boto3), como guía:

```python
s3 = boto3.client("s3"); rt = boto3.client("sagemaker-runtime")
s3.upload_file(req.psg_path, BUCKET, f"entradas/{req.record_id}/{Path(req.psg_path).name}")
s3.put_object(Bucket=BUCKET, Key=f"entradas/{req.record_id}.json", Body=json.dumps(payload))
r = rt.invoke_endpoint_async(EndpointName=ENDPOINT, ContentType="application/json",
                             InputLocation=f"s3://{BUCKET}/entradas/{req.record_id}.json")
# esperar r["OutputLocation"] (o r["FailureLocation"]) con un tope de tiempo:
# el endpoint baja a cero instancias tras 5 min sin uso y tarda en encender
out = json.loads(<objeto de OutputLocation>)
return StagingResult(probs=np.array(out["probs"]), model_version=out["model_version"],
                     threshold=out.get("threshold"), night_review_fraction=out.get("night_review_fraction"),
                     timings={**out.get("timings", {}), "endpoint_s": <espera total>})
```

El análisis corre en un hilo aparte (`backend/app/jobs.py`), así que esperar al endpoint no
bloquea la API; el tablero muestra «Estadificando…» mientras tanto. Si la espera supera el
tope, lanzar `ModelError` con un mensaje claro («El endpoint no respondió en N min…»).

Variables sugeridas: `SOMNOAI_SAGEMAKER_ENDPOINT`, `SOMNOAI_S3_BUCKET`, `AWS_REGION`,
`SOMNOAI_SAGEMAKER_MODEL_VERSION` y las credenciales de AWS Academy en el entorno.
**Nunca** en el repositorio.

## 4 · Cómo probar la integración

1. `cd backend && .venv/bin/pytest -q`: las pruebas usan el simulado y deben seguir pasando.
2. `SOMNOAI_MODEL=sagemaker ./run.sh` y, en el tablero, analizar las noches demo (son del
   test: SC4001E0, SC4331F0, SC4601E0) con los 4 canales y con Fpz-Cz solo.
3. La concordancia con la referencia (panel «Concordancia») debería quedar en el rango de la
   Tabla IV para cada combinación; si queda muy por debajo, revisar el orden de las columnas
   de `probs` y la alineación de `start_epoch`.
4. Revisar en «Registro y modelo» la versión y los tiempos, y en `GET /health` que
   `model.kind` sea `sagemaker`.
5. Con `backend/data/demo/download_demos.sh --test` se bajan las 32 noches del test (las que
   el endpoint tiene en S3 en su primera versión) y aparecen todas en la lista de demos.
