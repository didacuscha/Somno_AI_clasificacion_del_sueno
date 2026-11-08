# Integración del modelo — la frontera del adaptador

La aplicación nunca habla directamente con un modelo: el pipeline (`backend/app/jobs.py`) solo
conoce una interfaz pequeña, `ModelAdapter`, definida en `backend/app/model/adapter.py`. Hoy hay
dos adaptadores reales y un doble de pruebas:

| `SOMNOAI_MODEL` | Adaptador | Para qué |
|---|---|---|
| `provisional` (por defecto) | `model/provisional.py` | YASA corriendo en la API (estadificador abierto). |
| `api` | `model/remote.py` | **El modelo del proyecto** (stacking) en SageMaker, por su API pública con token (sección 3). |
| `mock` | `model/mock.py` | Probabilidades sintéticas deterministas: pruebas y CI. |

Conectar otro modelo = escribir una clase nueva que cumpla `ModelAdapter` y registrarla en
`get_adapter()`. El pipeline, la revisión, las métricas, la interfaz y la exportación no cambian.

## 1 · La interfaz

```python
class ModelAdapter(Protocol):
    def info(self) -> ModelInfo: ...
    def predict(self, req: StagingRequest) -> StagingResult: ...
```

### `info()` → `ModelInfo`
| Campo | Significado |
|---|---|
| `kind`, `name` | tipo y nombre para mostrar (p. ej. «Modelo provisional (YASA)»). |
| `version` | versión del modelo. **Queda guardada con cada noche** y no cambia aunque el adaptador cambie después. |
| `threshold` | umbral de confianza (0,65): una época con probabilidad del estadio elegido bajo el umbral se marca para revisión. |
| `night_review_fraction` | si se marca más de esta fracción de la noche (0,273), se sugiere revisarla completa. |
| `expected`, `expected_source` | desempeño de test por combinación de canales y de dónde sale (lo muestra «Desempeño del modelo»). |

Las reglas viajan con el adaptador porque se fijaron con la validación de cada versión del modelo;
`GET /config` y cada análisis las leen de aquí, no del tablero.

### `predict(req)` — lo que recibe: `StagingRequest`
El pipeline ya leyó el EDF, se quedó con los canales seleccionados, recortó la ventana de análisis
y la dividió en épocas de 30 s:

| Campo | Tipo | Significado |
|---|---|---|
| `record_id` | str | id del análisis. |
| `epochs` | dict[str, ndarray] | entrada → matriz `(n_epochs, muestras por época)` en µV, **solo las seleccionadas**, a su frecuencia nativa. |
| `fs` | dict[str, float] | frecuencia de cada entrada (el EMG de Sleep-EDFx viene a 1 Hz). |
| `labels` | dict[str, str] | entrada → etiqueta del canal en el EDF. |
| `start_epoch` | int | primera época de la ventana, contada desde el inicio del registro. |
| `lights_off_s` | float \| None | apagado de luces en segundos desde el inicio del registro (`None` → inicio de la ventana). |
| `epoch_s` | int | 30. |
| `source` | str \| None | ruta local del EDF original, para un adaptador que necesite el archivo completo. |
| `progress` | callable \| None | mensaje del paso «Predecir» mientras dura (p. ej. «Esperando al modelo»). |
| `n_epochs`, `slots`, `combination`, `mask` | propiedades | número de épocas, entradas presentes, `fpz_eog`…, máscara `(fpz, pz, eog, emg)`. |

### Lo que devuelve: `StagingResult`
| Campo | Tipo | Obligatorio | Significado |
|---|---|---|---|
| `stages` | `(n_epochs,)` int | sí | estadio predicho por época: 0=W, 1=N1, 2=N2, 3=N3, 4=REM. |
| `probs` | `(n_epochs, 5)` | sí | probabilidades en el orden **W, N1, N2, N3, REM**; cada fila suma 1. |
| `notes` | list[str] | no | avisos para el usuario (se muestran con el resultado). |
| `timings` | dict | no | segundos por etapa (se guardan; sirven para medir latencia). |

## 2 · Validación de la salida

`validate()` revisa el resultado **antes de guardar nada**. Si falla, el paso «Predecir» queda
fallido con el motivo, el análisis no guarda resultados y se puede reintentar:

- faltan o sobran épocas (filas de `probs` o de `stages` ≠ `n_epochs`);
- no hay 5 probabilidades por época, o hay valores negativos o no numéricos;
- una fila no suma 1 (tolerancia `PROB_SUM_TOLERANCE` = 0,01; dentro de ella se normaliza);
- un estadio fuera de 0–4, o que no es el más probable según las propias probabilidades.

Si el adaptador falla por su cuenta debe lanzar `ModelError("mensaje en español")`: es lo que ve el usuario.

Todo lo demás lo deriva la aplicación: confianza (probabilidad del estadio elegido), 2.ª opción,
marca de revisión, aviso de noche completa, arquitectura del sueño, acuerdo con la referencia,
evidencia espectral y decisiones del revisor.

## 3 · El modelo del proyecto: adaptador `api`

El stacking del proyecto ([repositorio del modelo](https://github.com/juancasas1996/MAIA_Trabajo_de_Grado_DeepSleep_Stacking))
corre en un endpoint asíncrono de SageMaker (`sistema-sueno`), detrás de una función Lambda con URL
pública y token (`despliegue/api/` en ese repositorio):

| Ruta | Para qué |
|---|---|
| `POST /subir` | URL firmada de S3 para subir un EDF con un PUT (dura 1 h) |
| `POST /analizar` | `{"s3_uri", "canales", "hora_apagado", "epoca_inicio", "epoca_fin"}` → `{"id"}` |
| `GET /resultado/<id>` | `pendiente`, `listo` (con el resultado) o `error` |

### Configuración (en `.env`, fuera de git; plantilla en `.env.example`)

| Variable | |
|---|---|
| `SOMNOAI_MODEL=api` | activa el adaptador |
| `SOMNOAI_MODEL_API`, `SOMNOAI_MODEL_TOKEN` | URL y token de la API. **Secretos**: solo en el servidor |
| `SOMNOAI_MODEL_NIGHTS` | `s3://…/sistema-sueno/noches/`: donde la API ya tiene las 32 noches de test |
| `SOMNOAI_MODEL_VERSION` | versión que sirve el endpoint (por defecto `sistema-sueno-v7`): la API no la informa |
| `SOMNOAI_MODEL_TIMEOUT_MIN`, `SOMNOAI_MODEL_POLL_S` | espera máxima (25 min) y cada cuánto se consulta (10 s) |

Sin URL o sin token el adaptador no cae al simulado: cada análisis falla diciendo qué falta.

### Qué hace con cada noche

1. **Deja el EDF donde el endpoint lo lee.** Una noche de test de Sleep-EDFx sin tocar se pide por su
   ruta en `SOMNOAI_MODEL_NIGHTS`; cualquier otra (y siempre un PSG subido por el usuario) se sube con
   `/subir`. El endpoint busca los canales por su nombre de Sleep-EDF (`EEG Fpz-Cz`, `EEG Pz-Oz`,
   `EOG horizontal`, `EMG submental`): si el archivo los llama distinto, se sube una copia con esas
   etiquetas cambiadas en el encabezado (`edf_io.relabel_edf`; las muestras no cambian).
2. **Pide la misma ventana, los mismos canales y el mismo apagado de luces** que el análisis
   (`hora_apagado` = inicio del registro + `lights_off_s`, como reloj).
3. **Espera la respuesta** consultando `/resultado`. El endpoint se apaga tras 5 min sin uso y tarda
   ~8 min en prender: el paso «Predecir» muestra el tiempo de espera y lo advierte. Tolera hasta tres
   fallas de red seguidas mientras espera.
4. **Revisa y entrega**: las épocas y los canales de la respuesta deben ser los pedidos; las 5
   probabilidades por época pasan por `validate()` como las de cualquier adaptador. Los tiempos
   quedan en `quality.timings` (`model_process_s` en el endpoint, `model_wait_s`, `model_upload_s`).

Reglas del modelo: umbral 0,65 y aviso de noche 0,2765 (`modelos/sistema.json` de la v7). El
desempeño esperado por combinación es el de la Tabla IV del informe (v1); la v2 desplegada empata.

### Seguridad

- El token y la URL viven solo en el servidor: no van en los logs, en los mensajes de error, en
  `/health`, en `/config` ni en el tablero (las pruebas lo verifican). Las URL firmadas de `/subir`
  tampoco se registran: llevan credenciales temporales de AWS.
- Lo que se sube queda en el bucket del modelo. Es un prototipo con Sleep-EDFx: **no suba datos
  reales de pacientes**.

### Límites conocidos

- El endpoint vive en una cuenta de AWS Academy: si la sesión del laboratorio se cierra, la API
  responde HTTP 502 y los análisis fallan con ese motivo (se pueden reintentar después).
- La API no dice qué versión sirve: si el equipo despliega otra, hay que actualizar
  `SOMNOAI_MODEL_VERSION`. Propuesta para el repositorio del modelo: incluir la versión
  (`MLFLOW_VERSION_SISTEMA`) en la respuesta de `inference.py`.

## 4 · Cómo probar un adaptador

1. `cd backend && .venv/bin/pytest -q`: las pruebas usan el doble `mock` y deben seguir pasando;
   `tests/test_remote.py` prueba el adaptador `api` contra una imitación local de la API.
   `tests/test_pipeline.py` tiene los casos de salida inválida que `validate()` debe rechazar.
2. Arrancar la API con el adaptador nuevo y analizar noches del catálogo con los 4 canales y con
   Fpz-Cz solo. En «Desempeño del modelo», el acuerdo con la referencia debería quedar en el rango
   de la tabla de desempeño esperado; si queda muy por debajo, revisar el orden de las columnas de
   `probs` y la alineación de `start_epoch`.
3. En «Detalles del análisis» y en `GET /health`, la versión debe ser la que reporta el adaptador.
