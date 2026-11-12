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
- **Entradas del modelo:** `fpz` (EEG Fpz-Cz), `pz` (EEG Pz-Oz), `eog` (EOG horizontal), `emg`
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
Cada decisión queda firmada con `user.name`. Más cuentas: variable `SOMNOAI_USERS`.

### GET `/health` (sin auth)
`{ "status": "ok", "records": 6, "model": { "kind": "provisional", "name": "Modelo provisional (YASA)", "version": "yasa-0.7.0-provisional" } }`

---

## 2 · Configuración y catálogo

### GET `/config`
Reglas del modelo (las **reporta el adaptador**, no se fijan en el tablero) y catálogo de canales.
```json
{
  "stages": ["W", "N1", "N2", "N3", "REM"],
  "epoch_s": 30,
  "channels": { "fpz": { "label": "EEG Fpz-Cz", "kind": "eeg", "name": "Fpz-Cz" }, "…": {} },
  "channel_aliases": { "fpz": ["^(eeg)?fpz-?cz$"], "…": [] },
  "channel_kinds": { "eeg": ["eeg", "…"], "eog": ["…"], "emg": ["…"] },
  "confidence_threshold": 0.65,
  "night_review_fraction": 0.273,
  "mf1_goal": 0.75,
  "window_margin_min": 30,
  "min_window_min": 10,
  "expected": { "fpz": { "cv_mf1": 0.802, "test_mf1": 0.772, "test_ci": [0.736, 0.802], "test_kappa": 0.75, "test_f1_n1": 0.518 }, "…": {} },
  "expected_source": "Modelo del proyecto, Tabla IV del informe (test, 16 sujetos)",
  "max_upload_mb": 600,
  "max_note_chars": 2000,
  "model": { "kind": "provisional", "name": "Modelo provisional (YASA)", "version": "yasa-0.7.0-provisional",
             "threshold": 0.65, "night_review_fraction": 0.273, "expected_source": "…" },
  "bands": [ { "key": "delta", "label": "Delta", "lo": 0.5, "hi": 4.0, "hint": "…" }, "…" ],
  "steps": [ { "key": "load", "label": "Cargar señales" }, { "key": "preprocess", "label": "Preprocesar" },
             { "key": "predict", "label": "Predecir" }, { "key": "flag", "label": "Marcar épocas" },
             { "key": "save", "label": "Guardar" } ],
  "catalog": { "kind": "s3", "location": "s3://bucket/prefijo/" }
}
```

### GET `/catalog[?refresh=true]`
Las noches del catálogo (`SOMNOAI_CATALOG`: carpeta local o `s3://bucket/prefijo/`). Listarlo **no
descarga** ninguna noche: solo se lee el encabezado de cada PSG (por rango en S3) y se guarda en la
base. El listado se cachea `SOMNOAI_CATALOG_TTL` segundos; `refresh=true` lo relee.
```json
{ "source": { "kind": "s3", "location": "s3://bucket/sleep-edfx/" },
  "nights": [ {
    "id": "SC4001E0-PSG.edf",                 // ruta del PSG relativa al catálogo: es el id
    "label": "SC4001E0", "psg": "SC4001E0-PSG.edf", "hypnogram": "SC4001EC-Hypnogram.edf",
    "folder": "", "subset": false, "size_mb": 46.1,
    "subject": 0, "night": 1, "age": 33, "sex": "F", "lights_off": "00:38", "split": "test",
    "featured": true, "has_hypnogram": true,
    "header": { "labels": ["EEG Fpz-Cz", "…"], "fs": { "EEG Fpz-Cz": 100.0, "…": 1.0 }, "duration_s": 79500.0,
                "start": "1989-04-24T16:13:00", "start_clock_s": 58380, "n_channels": 7,
                "patient": { "age": 33, "sex": "F" }, "annotations_only": false },
    "channels": { "…": "ver «Canales de un archivo» abajo" },
    "available": ["fpz", "pz", "eog", "emg"]
  } ] }
```
- `subset`: la noche cuelga de `subsets/` (subconjunto de canales, `scripts/make_subset_nights.py`).
- `split`: `test` (sujeto reservado, el modelo no lo vio) o `dev` (se usó para entrenar); `null` fuera del índice.
- **502** `catalog_unavailable` si S3 no responde o faltan permisos (el `message` dice por qué).

### Canales de un archivo (`channels`)
Lo devuelven el catálogo y las cargas: qué canales del archivo puede usar el modelo.
```json
{
  "channels": [ { "label": "EEG Fpz-Cz", "fs": 100.0, "kind": "eeg", "match": "fpz", "usable": true },
                { "label": "Resp oro-nasal", "fs": 1.0, "kind": null, "match": null, "usable": false } ],
  "matched":    { "fpz": "EEG Fpz-Cz", "pz": "EEG Pz-Oz", "eog": "EOG horizontal", "emg": "EMG submental" },
  "candidates": { "fpz": ["EEG Fpz-Cz", "EEG Pz-Oz"], "pz": ["…"], "eog": ["EOG horizontal"], "emg": ["EMG submental"] },
  "total": 7, "usable": 4,
  "unused": ["Resp oro-nasal", "Temp rectal", "Event marker"],
  "has_eeg": true
}
```
- `matched`: la entrada se reconoce por el nombre del canal (se asigna sola).
- `candidates`: canales del **mismo tipo** (EEG, EOG, EMG) que se pueden asignar a mano a esa entrada.
- `unused`: «en el archivo, no lo usa el modelo»; no se pueden asignar a ninguna entrada.

---

## 3 · PSG propio (opción secundaria)

### POST `/uploads` — `multipart/form-data`
| campo | tipo | reglas |
|---|---|---|
| `file` | archivo | PSG `.edf` (o `.zip` con el PSG y, opcional, su `*Hypnogram*.edf`). Máx. 600 MB. |
| `hypnogram` | archivo, opcional | EDF+ de anotaciones; solo es referencia. |

**201** → `{ "id", "file_name", "size_mb", "header": {…}, "channels": {…}, "hypnogram": {"name"} | null, "dataset": {…} | null }`.
**422** `invalid_file` con lo que está mal: no es un EDF legible, es solo un hipnograma, no tiene
ninguno de los canales del modelo, no tiene EEG, el hipnograma no trae estadios…

### POST `/uploads/{id}/hypnogram` (`multipart`, campo `file`) · DELETE `/uploads/{id}/hypnogram`
Adjunta o quita el hipnograma de referencia → la carga actualizada.

### GET `/uploads/{id}` · DELETE `/uploads/{id}`
La carga, o borrarla (409 `in_use` si ya pertenece a un análisis). Una carga se borra sola cuando su
análisis termina bien; si falla se conserva para reintentar. Las que nadie analizó se borran al
arrancar pasadas 24 h.

---

## 4 · Análisis (asíncronos)

### POST `/analyses` — JSON
```json
{ "source": { "type": "catalog", "id": "SC4001E0-PSG.edf" },      // o { "type": "upload", "id": "<id de la carga>" }
  "channels": ["fpz", "eog"],
  "channel_map": null,              // {"fpz": "C4-M1"}: otro canal del mismo tipo para una entrada
  "window_mode": "reference",       // reference | range | full (por defecto reference si hay hipnograma)
  "start_clock": null, "end_clock": null,   // HH:MM, obligatorios con range
  "lights_off": null }              // HH:MM | "none" | null (= el del índice de Sleep-EDFx)
```
Valida al instante fuente, canales y ventana, y responde **202** con el resumen en estado `queued`.
El análisis corre en segundo plano; el tablero consulta `GET /records/{id}` hasta `done` o `failed`.

**Errores:** `404 not_found` (noche o carga inexistente); `422 invalid_channels` (ningún canal:
«Seleccione al menos un canal»; sin EEG; un mismo canal en dos entradas; un canal que el modelo no
usa; canal ausente); `422 invalid_file` (ventana, apagado de luces, hipnograma…); `502 catalog_unavailable`.

### Pasos (`progress`)
Cada análisis informa el estado de cada paso del pipeline:
```json
{ "current": "predict",
  "steps": [ { "key": "load", "label": "Cargar señales", "status": "done", "message": "2 canales del modelo · 7,0 h de ventana", "seconds": 0.12 },
             { "key": "preprocess", "label": "Preprocesar", "status": "done", "message": "841 épocas de 30 s", "seconds": 0.03 },
             { "key": "predict", "label": "Predecir", "status": "running", "message": "Estadificando con Modelo provisional (YASA)", "seconds": null },
             { "key": "flag", "label": "Marcar épocas", "status": "pending", "message": null, "seconds": null },
             { "key": "save", "label": "Guardar", "status": "pending", "message": null, "seconds": null } ] }
```
`status`: `pending | running | done | failed`. Si un paso falla queda `failed` con el motivo en
`message`, el registro queda `failed` con ese `error` y **no se guarda ningún resultado** de la noche.

### POST `/records/{id}/retry`
Vuelve a lanzar un análisis `failed` con la misma configuración (mismo registro, `attempts` + 1;
queda en la bitácora). **409** si no está fallido.

---

## 5 · Registros

### GET `/records`
Todos los análisis, más reciente primero.
```json
{ "records": [ {
  "id": "09f629e7f596", "created_at": "2026-10-27T19:08:04", "created_by": "Sistema",
  "source": "catalog", "source_id": "SC4001E0-PSG.edf", "night_label": "SC4001E0", "subset": false,
  "file_name": "SC4001E0-PSG.edf", "subject_code": "SC00", "sex": "F", "age": 33,
  "channels": ["fpz", "pz", "eog", "emg"], "combination": "eeg2_eog_emg",
  "combination_name": "Fpz-Cz + Pz-Oz + EOG + EMG", "window_mode": "reference",
  "n_epochs": 841, "has_reference": true, "dataset_split": "test",
  "model_version": "yasa-0.7.0-provisional", "finished_at": "2026-10-27T19:08:05",
  "status": "done", "progress": { "…": "pasos" }, "error": null, "attempts": 1,
  "review": {
    "status": "in_review", "n_epochs": 841, "flagged": 234, "flagged_fraction": 0.2782,
    "whole_night_recommended": true, "resolved": 2, "pending": 232, "confirmed": 1, "corrected": 1,
    "finalized_by": null, "finalized_at": null,
    "open": true, "started_by": "Dra. X", "started_at": "2026-10-27T19:20:11"
  }
} ] }
```
- `status` del análisis: `queued | running | done | failed`.
- `review.status` = **estado de la noche**: `to_review` (analizada, por revisar; revisión sin iniciar) ·
  `full_review_suggested` (ídem, se marcó más del 27,3 %) · `in_review` (revisión abierta: alguien la
  inició o la reabrió, o ya hay decisiones) · `finalized`.
- `review.open`: la revisión está abierta (`in_review`): solo así el tablero deja confirmar o corregir.
  `started_by` / `started_at`: quién la inició o la reabrió por última vez.
- Marcadas = épocas con confianza bajo el umbral; resueltas = marcadas que el revisor decidió;
  `confirmed` / `corrected` = épocas que el revisor dejó igual / cambió respecto del modelo.

### GET `/records/{id}`
En proceso o fallido: el resumen anterior. Terminado: el resumen **más**:
```json
{
  "patient":  { "age": 33, "sex": "F", "source": "edf-header" },
  "channels": { "selected": ["fpz","pz","eog","emg"], "combination": "eeg2_eog_emg", "combination_name": "…",
                "mask": [true,true,true,true], "map": { "fpz": "EEG Fpz-Cz", "…": "…" },
                "available": { "fpz": "EEG Fpz-Cz", "…": "…" }, "file_labels": ["…"],
                "unused": ["Resp oro-nasal", "Temp rectal", "Event marker"], "fs": { "fpz": 100.0, "emg": 1.0 } },
  "model":    { "kind": "provisional", "name": "Modelo provisional (YASA)", "version": "yasa-0.7.0-provisional",
                "threshold": 0.65, "night_review_fraction": 0.273, "expected_source": "…", "notes": ["…"],
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
  "history": [ { "at": "…", "author": "Superusuario", "action": "set", "epoch": 64, "stage": 2, "previous": 1, "old": "N1", "new": "N2" } ],
  "notes":   [ { "id": 3, "at": "…", "author": "Superusuario", "text": "Artefacto de movimiento a las 01:10." } ],
  "review":  { "…": "igual que en el listado" },
  "quality": { "file": { "name": "…", "size_mb": 46.1, "start": "1989-04-24T16:13:00", "start_clock_s": 58380,
                         "total_duration_s": 79500.0, "channels": 7, "sampling_hz": 100.0 },
               "composition": [ { "label": "Ventana analizada", "hours": 7.01, "kind": "window" }, "…" ],
               "reference_unscored": 0, "timings": { "read_s": 0.14, "model_s": 1.26, "total_s": 1.4 } },
  "dataset":  { "id": "SC4001E0", "subject": 0, "night": 1, "split": "test", "lights_off": "00:38", "…": "…" },
  "source_info": { "type": "catalog", "id": "SC4001E0-PSG.edf", "label": "SC4001E0", "subset": false, "location": "s3://…" }
}
```
Notas:
- `model.version` y `model.threshold` son los que reportó el adaptador **cuando se analizó** la noche;
  no cambian aunque el adaptador cambie después.
- `epochs.*` van alineados por índice. `stage` es el estadio que devolvió el adaptador (validado: es el
  más probable), `confidence` su probabilidad, `second` el siguiente más probable y
  `review = confidence < threshold`.
- `epochs.final` = predicción con las decisiones vigentes encima. `metrics.final` y
  `agreement.final` se recalculan con cada decisión.
- `metrics.*`: `tib_min`, `tst_min`, `efficiency_pct`, `sol_min`, `rem_latency_min`, `waso_min`,
  `awakenings` (vigilia ≥ 1 min tras dormirse) y `stages.{W,N1,N2,N3,REM}` con `min` y `pct`
  (W como % del tiempo en cama; el resto, % del sueño total). Se cuentan desde el apagado de luces.
- `agreement.*` (solo con referencia): `n_epochs`, `accuracy`, `mf1`, `kappa`, `f1` por estadio y
  `confusion` (5×5, filas = referencia, columnas = predicción).
- `history[].action`: `start` (iniciar la revisión) · `set` (confirmar o corregir) · `clear` (volver al
  modelo) · `finalize` · `reopen` · `note` · `retry`, con el valor anterior (`old`) y el nuevo (`new`).
- `channels.units`: la unidad de cada canal del visor según su encabezado EDF (`"µV"` en Sleep-EDF).

### DELETE `/records/{id}`
**200** `{"deleted": "<id>"}` · **404** · **409 busy** si el análisis sigue en proceso.
Borra también decisiones, notas, bitácora y señal derivada.

### GET `/records/{id}/signal?start_s=2400&duration_s=90&points=800&channels=fpz,eog`
Envolvente mín-máx por canal para la ventana visible (nunca la señal cruda completa), en la unidad
que declara el encabezado EDF de cada canal (Sleep-EDF: µV; un canal en mV llega en mV).
```json
{ "start_s": 2400, "duration_s": 90, "points": 800, "unit": "µV",
  "traces": { "fpz": { "min": [-42.1, "…"], "max": [38.9, "…"], "unit": "µV" }, "eog": { "…": "…" } } }
```
`unit`: la de todos los trazos si coinciden; `null` si son distintas (cada trazo trae la suya).
La señal se guarda en µV (MNE la entrega en voltios y se multiplica por 10⁶); la API la devuelve a
la unidad del encabezado.

### GET `/records/{id}/epochs/{epoch}/evidence[?channel=pz]`
Evidencia espectral de la época: potencia relativa del EEG por banda (Welch, 0,5–30 Hz) y el perfil
típico de cada estadio **en esta misma noche** (mediana de las épocas sobre el umbral o decididas por
un revisor, según el hipnograma final).
```json
{ "epoch": 64, "channel": "fpz", "channel_name": "Fpz-Cz", "file_label": "EEG Fpz-Cz", "channels": ["fpz", "pz"], "fs": 100.0,
  "bands": [ { "key": "delta", "label": "Delta", "lo": 0.5, "hi": 4.0, "hint": "…", "value": 0.81 }, "…" ],
  "typical": { "N2": { "n": 195, "values": [0.83, 0.11, 0.02, 0.02, 0.01] }, "…": {} },
  "candidates": [2, 1], "closest": 2,
  "method": "Potencia relativa del EEG por banda (Welch, ventanas de 4 s) entre 0,5 y 30 Hz." }
```
`closest`: de los dos estadios candidatos, el de perfil típico más parecido (o `null`).
**422** si la época no existe o el canal no es un EEG del registro.

---

## 6 · Revisión del especialista

### PATCH `/records/{id}/epochs`
```json
{ "changes": [ { "epoch": 64, "stage": 2 }, { "epoch": 59, "stage": 0 }, { "epoch": 70, "stage": null } ] }
```
- `stage` 0–4: el estadio que decide el revisor. Igual al del modelo = **confirmada**; distinto = **corregida**.
- `stage: null`: vuelve al estadio del modelo (deshace la decisión).
- Cada cambio queda en la bitácora con usuario, fecha, valor anterior y nuevo.
- Cada cambio queda **guardado en la base al responder**: no hace falta finalizar para conservarlo
  (sobrevive a recargar el navegador, a otro computador y a reiniciar o redesplegar la API).
- En una revisión sin iniciar (`to_review`), el primer cambio la inicia (`start` en la bitácora).

**200** → `{ "final", "metrics_final", "agreement_final", "corrections", "review", "history", "notes" }`.
**409 review_locked** si la revisión está finalizada · **422 out_of_range / invalid_stage**.

### GET `/records/{id}/changes`
Resumen antes de finalizar:
`{ "confirmed": 12, "corrected": 3, "pending": 210, "changes": [ { "epoch": 64, "clock_s": 87420, "model_stage": 1, "reviewer_stage": 2, "flagged": true, "author": "…", "at": "…" } ], "decisions": [ { "epoch": 59, "kind": "confirmed", … }, { "epoch": 64, "kind": "corrected", … } ], "review": {…} }`

- `changes`: solo las correcciones (estadio distinto del modelo).
- `decisions`: todas las decisiones del revisor, confirmadas y corregidas (`kind`), con los mismos campos;
  el resumen las lista para poder deshacer cualquiera.

### POST `/records/{id}/review`
`{ "action": "start" }` inicia una revisión sin iniciar (queda `in_review`, abierta). Si ya estaba
abierta, no cambia nada; si está finalizada → **409 review_locked** (se reabre, no se inicia).
`{ "action": "finalize", "expected_corrected": 3 }` finaliza la revisión con el nombre del usuario
(con épocas pendientes, el hipnograma final las toma como las predijo el modelo). `expected_corrected`
es el número de cambios que vio el revisor en el resumen: si ya no coincide → **409 stale_summary**.
`{ "action": "reopen" }` la reabre: queda `in_review` (abierta), aunque no haya decisiones.
**409** si ya estaba finalizada / no lo estaba.
**200** → mismo cuerpo que el PATCH.

### POST `/records/{id}/notes`
`{ "text": "…" }` (1–2000 caracteres) → **201** `{ "notes": [...], "history": [...] }`. La nota queda
con autor y fecha, y en la bitácora (`action: "note"`).

---

## 7 · Exportación

### GET `/records/{id}/export.xlsx`
**Clasificación por época** en Excel (botón «Exportar clasificación por época (Excel)»), archivo
`<noche>_clasificacion_por_epoca.xlsx` (p. ej. `SC4001E0_clasificacion_por_epoca.xlsx`). Una fila por
época: `epoca, hora, inicio_s, prediccion, confianza, segunda_opcion, p_W, p_N1, p_N2, p_N3, p_REM,
marcada_revisar, estadio_final, revision (pendiente|confirmada|corregida), revisado_por, referencia`.

### GET `/records/{id}/export.csv`
Las mismas columnas y filas en CSV (para scripts).

### GET `/corrections/export.csv`
Todas las épocas confirmadas o corregidas por un especialista, en todos los registros:
`registro, archivo, sujeto, combinacion, version_modelo, epoca, inicio_s, prediccion,
confianza, marcada_revisar, estadio_especialista, autor, fecha, referencia`.

---

## 8 · Qué consume cada panel

| Panel | Campos |
|---|---|
| Registros (KPIs, gráfico, tabla) | `records[]`: `review.*`, `status`, `progress`, `channels`, `n_epochs`, `subset` |
| Analizar · 1 elegir la noche | `GET /catalog`, `POST /uploads` |
| Analizar · 2 canales | `nights[].channels` o `upload.channels`, `GET /config` (`channels`, `expected`) |
| Diálogo de avance | `POST /analyses`, `GET /records/{id}` → `progress.steps`, `POST …/retry` |
| Vista clínica | `review`, `epochs.*`, `metrics.final`, `notes`, `history`, `model` (versión y umbral) |
| Revisión época a época | `epochs.*` + `GET …/signal` + `GET …/evidence` + `PATCH …/epochs` |
| Finalizar | `GET …/changes` + `POST …/review` |
| Desempeño del modelo | `agreement.*`, `model.expected`, `metrics.predicted/final/reference`, `quality.timings` |
