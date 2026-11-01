# Integración del modelo — la frontera del adaptador

La aplicación nunca habla directamente con un modelo: el pipeline (`backend/app/jobs.py`) solo
conoce una interfaz pequeña, `ModelAdapter`, definida en `backend/app/model/adapter.py`. Hoy hay
un adaptador real y un doble de pruebas:

| `SOMNOAI_MODEL` | Adaptador | Para qué |
|---|---|---|
| `provisional` (por defecto) | `model/provisional.py` | YASA corriendo en la API. Es el modelo de la aplicación mientras se integra el del proyecto. |
| `mock` | `model/mock.py` | Probabilidades sintéticas deterministas: pruebas y CI. |

Conectar otro modelo (el stacking del proyecto, más adelante) = escribir una clase nueva que cumpla
`ModelAdapter` y registrarla en `get_adapter()`. El pipeline, la revisión, las métricas, la
interfaz y la exportación no cambian.

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

## 3 · Para el adaptador del modelo del proyecto (pendiente, fuera de este alcance)

La integración con SageMaker se hará después, detrás de esta misma interfaz. Lo que debe cumplir:

1. `info()` con la versión registrada del modelo y sus reglas (umbral y fracción de noche).
2. `predict()` con exactamente `req.n_epochs` filas, en el orden W, N1, N2, N3, REM, y `stages`
   coherentes con `probs`. Si el endpoint trabaja sobre el EDF completo, `req.source`,
   `req.start_epoch`, `req.n_epochs` y `req.labels` dicen qué archivo, qué ventana y qué canales.
3. Nunca usar el hipnograma de referencia (el adaptador no lo recibe).
4. Errores como `ModelError` con un mensaje claro (p. ej. «El endpoint no respondió en N min»).

## 4 · Cómo probar un adaptador

1. `cd backend && .venv/bin/pytest -q`: las pruebas usan el doble `mock` y deben seguir pasando.
   `tests/test_pipeline.py` tiene los casos de salida inválida que `validate()` debe rechazar.
2. Arrancar la API con el adaptador nuevo y analizar noches del catálogo con los 4 canales y con
   Fpz-Cz solo. En «Desempeño del modelo», el acuerdo con la referencia debería quedar en el rango
   de la tabla de desempeño esperado; si queda muy por debajo, revisar el orden de las columnas de
   `probs` y la alineación de `start_epoch`.
3. En «Detalles del análisis» y en `GET /health`, la versión debe ser la que reporta el adaptador.
