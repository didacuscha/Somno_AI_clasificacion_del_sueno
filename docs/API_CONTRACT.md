# Contrato de API — SomnoAI v2

Lo que el tablero (frontend) espera de la API. La implementación está en
`backend/app/main.py`; el tablero la consume desde `frontend/js/api.js`, y
`frontend/js/mock.js` implementa este mismo contrato en el navegador (modo demo).
La documentación interactiva generada por FastAPI está en `http://localhost:8000/docs`.

- **Base:** `http://localhost:8000/api/v1`
- **Formato:** JSON, UTF-8, números con punto decimal (el tablero formatea en es-CO).
- **Errores:** siempre `{"error": {"code": "...", "message": "..."}}` con el código HTTP
  correspondiente. El `message` se muestra al usuario tal cual: va en español.
- **Auth:** todo excepto `/health` y `/auth/login` exige `Authorization: Bearer <token>`.
  `401` → el tablero cierra la sesión y vuelve al login.
- **Estadios:** `0=W, 1=N1, 2=N2, 3=N3, 4=REM`; `-1` = época sin estadio (solo en la referencia).
- **Modalidades:** `fpz` (EEG Fpz-Cz), `pz` (EEG Pz-Oz), `eog` (EOG horizontal), `emg`
  (EMG submental). Las combinaciones se nombran como en el proyecto de grado:
  `fpz`, `pz`, `eeg2`, `fpz_eog`, …, `eeg2_eog_emg` (12 en total, siempre con un EEG).
- **Épocas:** índices desde 0 relativos al inicio de la **ventana analizada**.

---

## 1 · Sesión

### POST `/auth/login`
```json
{ "username": "superusuario", "password": "…" }
```
**200** `{ "token": "…", "user": { "username": "superusuario", "name": "Superusuario", "initials": "SU" } }`
· **401** `invalid_credentials`.

El token está firmado (usuario, vencimiento a 12 h, HMAC): sobrevive a reinicios de la API.
Cada corrección queda firmada con `user.name`. Más cuentas: variable `SOMNOAI_USERS`.

### GET `/health` (sin auth)
`{ "status": "ok", "records": 6, "model": { "kind": "provisional", "version": "yasa-0.7.0-provisional" } }`

---

## 2 · Configuración y noches demo

### GET `/config`
Las reglas del modelo y el catálogo de canales. El tablero **no** las duplica.
```json
{
  "stages": ["W", "N1", "N2", "N3", "REM"],
  "epoch_s": 30,
  "channels": { "fpz": { "label": "EEG Fpz-Cz", "kind": "eeg", "name": "Fpz-Cz" }, "…": {} },
  "channel_aliases": { "fpz": ["^(eeg)?fpz-?cz$"], "…": [] },
  "confidence_threshold": 0.65,
  "night_review_fraction": 0.273,
  "mf1_goal": 0.75,
  "window_margin_min": 30,
  "min_window_min": 10,
  "expected": { "fpz": { "cv_mf1": 0.802, "test_mf1": 0.772, "test_ci": [0.736, 0.802], "test_kappa": 0.75, "test_f1_n1": 0.518 }, "…": {} },
  "max_upload_mb": 600,
  "model": { "kind": "provisional", "version": "yasa-0.7.0-provisional" }
}
```
`expected` es la Tabla IV del informe (sistema completo por combinación). `channel_aliases`
son expresiones regulares sobre la etiqueta normalizada (minúsculas, sin espacios, `_` ni `.`).

### GET `/demos`
Noches del índice de Sleep-EDFx cuyos archivos están en el servidor (`backend/data/demo`).
```json
{ "demos": [ {
  "id": "SC4001E0", "subject": 0, "night": 1, "age": 33, "sex": "F", "lights_off": "00:38",
  "psg": "SC4001E0-PSG.edf", "hypnogram": "SC4001EC-Hypnogram.edf",
  "split": "test", "featured": true, "has_hypnogram": true,
  "header": { "labels": ["EEG Fpz-Cz", "…"], "fs": { "EEG Fpz-Cz": 100.0, "…": 1.0 },
              "start_clock_s": 58380, "duration_s": 79500.0 },
  "detected": { "fpz": "EEG Fpz-Cz", "pz": "EEG Pz-Oz", "eog": "EOG horizontal", "emg": "EMG submental" }
} ] }
```
`split`: `test` (sujeto reservado, el modelo no lo vio) o `dev` (se usó para entrenar).

### GET `/dataset/lookup?file_name=SC4001E0-PSG.edf`
`{ "night": { "id", "subject", "night", "age", "sex", "lights_off", "psg", "hypnogram", "split" } }`
o `{ "night": null }` si el archivo no sigue la convención `SC4ssN…` de Sleep-EDFx.

---

## 3 · Análisis (asíncronos)

Crear un análisis valida al instante formato, canales y ventana, y responde **202** con el
resumen en estado `queued`. El análisis corre en segundo plano (el endpoint de SageMaker
puede tardar minutos en encenderse); el tablero consulta `GET /records/{id}` hasta que
`status` sea `done` o `failed`.

### POST `/analyses` — `multipart/form-data`

| campo | tipo | reglas |
|---|---|---|
| `file` | archivo | `.edf` (PSG) o `.zip` con el PSG y, opcional, su `*Hypnogram*.edf`. Máx. 600 MB. |
| `hypnogram` | archivo, opcional | EDF+ de anotaciones. Si viene, manda sobre el del zip. |
| `channels` | texto | modalidades separadas por coma: `fpz,eog`. Al menos un EEG. |
| `channel_map` | JSON, opcional | `{"fpz": "C4-M1"}`: etiqueta del archivo para una modalidad (montajes con otro nombre). Lo que no venga se reconoce por nombre. |
| `window_mode` | texto, opcional | `reference` (ventana de sueño del hipnograma ±30 min), `range` o `full`. Por defecto `reference` si hay hipnograma, si no `full`. |
| `start_clock`, `end_clock` | `HH:MM` | obligatorios con `range`. Se interpretan como la primera vez que el reloj marca esa hora después del inicio del registro. |
| `lights_off` | `HH:MM` o `none` | apagado de luces. Ausente → el del índice de Sleep-EDFx si la noche está en él; `none` → sin apagado (se toma el inicio de la ventana). |

**202** → resumen (ver §4) con `"status": "queued"` y `progress`.

**Errores:** `413 too_large`; `422 invalid_file` (no es EDF, solo hipnograma, ventana o
apagado de luces inválidos, «la ventana del hipnograma necesita el hipnograma»…);
`422 invalid_channels` (sin EEG, canal ausente, etiqueta repetida). El `message` explica qué falló.

### POST `/analyses/demo` — JSON
```json
{ "demo_id": "SC4001E0", "channels": ["fpz", "eog"], "channel_map": null,
  "window_mode": "reference", "start_clock": null, "end_clock": null, "lights_off": null }
```
Mismas reglas que la carga. **202** → resumen · **404** demo desconocido o sin archivos.

---

## 4 · Registros

### GET `/records`
Todos los análisis, más reciente primero.
```json
{ "records": [ {
  "id": "09f629e7f596", "created_at": "2026-10-27T19:08:04", "created_by": "Sistema",
  "source": "demo", "file_name": "SC4001E0-PSG.edf", "subject_code": "SC00", "sex": "F", "age": 33,
  "channels": ["fpz", "pz", "eog", "emg"], "combination": "eeg2_eog_emg",
  "combination_name": "Fpz-Cz + Pz-Oz + EOG + EMG", "window_mode": "reference",
  "n_epochs": 841, "has_reference": true, "dataset_split": "test",
  "model_version": "yasa-0.7.0-provisional", "finished_at": "2026-10-27T19:08:05",
  "status": "done", "progress": null, "error": null,
  "review": {
    "status": "in_progress", "n_epochs": 841, "flagged": 234, "flagged_fraction": 0.2782,
    "whole_night_recommended": true, "resolved": 2, "pending": 232, "confirmed": 1, "corrected": 1,
    "signed_off_by": null, "signed_off_at": null
  }
} ] }
```
- `status`: `queued | running | done | failed`. En proceso, `progress` =
  `{"step": "queued|reading|staging|metrics", "label": "…", "message": "…"}`; si falló, `error` trae el motivo.
- `subject_code`: `"SC" + sujeto` según la convención Sleep-EDFx `SC4ssN…`.
- `review` (solo `done`): marcadas = épocas con confianza bajo el umbral; resueltas = marcadas
  que el especialista confirmó o corrigió; `corrected` = épocas cuyo estadio final difiere del
  modelo (marcadas o no); `whole_night_recommended` = `flagged_fraction > night_review_fraction`.
  `status`: `pending` (sin tocar) · `in_progress` · `signed_off` (finalizada y firmada).

### GET `/records/{id}`
En proceso o fallido: el resumen anterior. Terminado: el resumen **más**:

```json
{
  "patient":  { "age": 33, "sex": "F", "source": "edf-header" },
  "channels": { "selected": ["fpz","pz","eog","emg"], "combination": "eeg2_eog_emg",
                "combination_name": "…", "mask": [true,true,true,true],
                "map": { "fpz": "EEG Fpz-Cz", "…": "…" },
                "available": { "fpz": "EEG Fpz-Cz", "…": "…" },
                "file_labels": ["EEG Fpz-Cz", "…"], "fs": { "fpz": 100.0, "emg": 1.0 } },
  "model":    { "version": "…", "kind": "provisional|mock|sagemaker", "threshold": 0.65,
                "night_review_fraction": 0.273, "notes": ["…"],
                "expected": { "test_mf1": 0.784, "test_ci": [0.753, 0.81], "test_kappa": 0.758,
                              "cv_mf1": 0.819, "test_f1_n1": 0.534, "below_goal": false, "goal_mf1": 0.75 } },
  "night":    { "epoch_s": 30, "n_epochs": 841, "start_epoch": 961, "start_clock_s": 87210,
                "window": { "mode": "reference", "start_s": 28830, "end_s": 54060 },
                "lights_off_clock": "00:38", "lights_off_source": "dataset-index", "lights_off_epoch": 49 },
  "epochs":   { "stage": [0, 0, "…"], "second": [1, 1, "…"], "confidence": [0.993, "…"],
                "review": [0, 0, "…"], "probs": [[0.993, 0.005, 0.001, 0.0, 0.001], "…"],
                "reference": [0, 0, "…"], "final": [0, 0, "…"] },
  "metrics":  { "predicted": { "…": "…" }, "final": { "…": "…" }, "reference": { "…": "…" } },
  "agreement": { "predicted": { "…": "…" }, "final": { "…": "…" } },
  "corrections": [ { "epoch": 64, "stage": 2, "author": "Superusuario", "at": "2026-10-27T19:09:46" } ],
  "history": [ { "at": "…", "author": "Superusuario", "action": "set", "epoch": 64, "stage": 2, "previous": 1 } ],
  "review": { "…": "igual que en el listado" },
  "quality":  { "file": { "name": "…", "size_mb": 46.1, "start": "1989-04-24T16:13:00",
                          "start_clock_s": 58380, "total_duration_s": 79500.0, "channels": 7, "sampling_hz": 100.0 },
                "composition": [ { "label": "Antes de la ventana", "hours": 8.01, "kind": "outside" },
                                 { "label": "Ventana analizada", "hours": 7.01, "kind": "window" }, "…" ],
                "reference_unscored": 0,
                "timings": { "read_s": 0.14, "model_s": 1.26, "total_s": 1.4 } },
  "dataset":  { "id": "SC4001E0", "subject": 0, "night": 1, "split": "test", "lights_off": "00:38", "…": "…" }
}
```

Notas:
- `epochs.*` van alineados por índice (una entrada por época de la ventana). `stage`,
  `second`, `confidence` y `review` se derivan de `probs` con la regla del informe: estadio =
  argmax, confianza = su probabilidad, `review = confidence < threshold`.
- `epochs.final` = predicción con las correcciones vigentes encima. `metrics.final` y
  `agreement.final` se recalculan con cada corrección.
- `epochs.reference` y `agreement` solo existen si hubo hipnograma de referencia.
- `night.start_clock_s`: hora de reloj del inicio de la ventana en segundos desde las 00:00
  (puede superar 86400 si cruza la medianoche). `lights_off_epoch` puede ser negativo (antes
  de la ventana); `lights_off_source`: `manual` o `dataset-index`.
- `metrics.*`: `tib_min`, `tst_min`, `efficiency_pct`, `sol_min`, `rem_latency_min`,
  `waso_min`, `awakenings` (vigilia ≥ 1 min tras dormirse) y `stages.{W,N1,N2,N3,REM}` con
  `min` y `pct` (W como % del tiempo en cama; el resto, % del sueño total).
- `agreement.*`: `n_epochs`, `accuracy`, `mf1`, `kappa`, `f1` por estadio y `confusion`
  (5×5, filas = referencia, columnas = predicción).
- `channels.available`: todas las modalidades reconocibles del archivo (el visor puede
  mostrar también las que no se le dieron al modelo).

### DELETE `/records/{id}`
**200** `{"deleted": "<id>"}` · **404** · **409 busy** si el análisis sigue en proceso.
Borra también correcciones, bitácora y señal derivada.

### GET `/records/{id}/signal?start_s=2400&duration_s=90&points=800&channels=fpz,eog`
Envolvente mín-máx por canal para la ventana visible (nunca la señal cruda completa).
`start_s` relativo al inicio de la ventana analizada; `points` ≤ 4000; `channels` vacío = todos.
```json
{ "start_s": 2400, "duration_s": 90, "points": 800, "unit": "µV",
  "traces": { "fpz": { "min": [-42.1, "…"], "max": [38.9, "…"] }, "eog": { "…": "…" } } }
```
**404** · **409 not_ready** · **422 out_of_range**.

---

## 5 · Revisión del especialista

### PATCH `/records/{id}/epochs`
```json
{ "changes": [ { "epoch": 64, "stage": 2 }, { "epoch": 59, "stage": 0 }, { "epoch": 70, "stage": null } ] }
```
- `stage` 0–4: el estadio que decide el especialista. Igual a la predicción = **confirmar**.
- `stage: null`: vuelve a la predicción del modelo (borra la corrección).
- Cada cambio queda en la bitácora con autor, fecha y estadio anterior.

**200** → `{ "final", "metrics_final", "agreement_final", "corrections", "review", "history" }`
(lo que cambia con la corrección; el tablero lo combina con el detalle que ya tiene).
**409 review_locked** si la revisión está finalizada · **422 out_of_range / invalid_stage**.

### POST `/records/{id}/review`
`{ "action": "sign_off" }` finaliza y firma la revisión (con épocas pendientes, el
hipnograma final las toma como las predijo el modelo); `{ "action": "reopen" }` la reabre.
**200** → mismo cuerpo que el PATCH.

---

## 6 · Exportación (CSV)

### GET `/records/{id}/export.csv`
Una fila por época: `epoca, hora, inicio_s, prediccion, confianza, segunda_opcion,
p_W, p_N1, p_N2, p_N3, p_REM, marcada_revisar, estadio_final, revision
(pendiente|confirmada|corregida), revisado_por, referencia`.

### GET `/corrections/export.csv`
Todas las épocas confirmadas o corregidas por un especialista, en todos los registros:
`registro, archivo, sujeto, combinacion, version_modelo, epoca, inicio_s, prediccion,
confianza, marcada_revisar, estadio_especialista, autor, fecha, referencia`. Es el insumo
para medir el modelo en uso y reentrenarlo.

---

## 7 · Qué consume cada panel

| Panel | Campos |
|---|---|
| KPIs, distribución y tabla (Registros) | `records[]`: `review.*`, `status`, `channels`, `n_epochs`, `subject_code` |
| Paso 2 · canales (Analizar) | `GET /config` (`channels`, `channel_aliases`, `expected`), encabezado leído en el navegador o `demos[].header` |
| Avisos y KPIs (Resultados) | `review`, `model.expected`, `model.notes`, `dataset.split`, `agreement` |
| Hipnograma | `epochs.final/stage`, `epochs.review`, `epochs.confidence`, `epochs.reference`, `corrections`, `night` |
| Revisión época a época | `epochs.*` + `GET …/signal` + `PATCH …/epochs` + `POST …/review` |
| Arquitectura del sueño | `metrics.predicted/final/reference` |
| Concordancia | `agreement.predicted/final` |
| Registro y modelo | `quality.*`, `night.*`, `model.*`, `channels.map`, `history` |
