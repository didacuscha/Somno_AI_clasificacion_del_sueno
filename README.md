# SomnoAI v2 — Estadificación automática del sueño con canales variables

Plataforma web que clasifica cada época de 30 s de una polisomnografía en uno de cinco
estadios (W, N1, N2, N3, REM) con **cualquier combinación de canales que incluya al menos
un EEG**, y que deja al especialista revisar y corregir lo que el modelo no tiene claro.

Proyecto de grado — Maestría en Inteligencia Artificial (MAIA), Universidad de los Andes · Grupo 3.

**Equipo:** Diego Charry Cárdenas · Isabella del Pilar Camargo Salazar · Javier Andrés
Marín Gallón · Juan Camilo Martínez Vélez · Juan Sebastián Casas Castillo

> ⚠ **Prototipo académico de apoyo a la estadificación. No es un instrumento de diagnóstico clínico.**

---

## Qué hace

- **Elige una noche del catálogo** (las noches de prueba guardadas en S3, o en una carpeta local):
  lista buscable con sujeto, noche y canales disponibles. Como opción secundaria, **sube un PSG
  propio** (`.edf`, o `.zip` con el PSG y su hipnograma; hasta 600 MB): el servidor lo revisa y
  muestra los canales que encontró, o explica qué está mal.
- **Canales:** el servidor reconoce las cuatro entradas del modelo (Fpz-Cz, Pz-Oz, EOG, EMG; 12
  combinaciones, siempre con un EEG) y muestra el resto como «en el archivo, no lo usa el modelo»
  («7 canales en el archivo · 4 utilizables»). Solo un canal del mismo tipo se puede asignar a
  mano; un mismo canal no puede ocupar dos entradas (la interfaz lo impide y la API lo rechaza).
  Se ve el desempeño esperado de la combinación elegida.
- **Ventana de análisis:** la noche según el hipnograma (±30 min, el recorte con que se entrenó el
  modelo), un rango horario o el registro completo; y el **apagado de luces**.
- **Pipeline en segundo plano** con cinco pasos visibles (cargar señales, preprocesar, predecir,
  marcar épocas, guardar): el diálogo de avance se queda abierto hasta que termina o falla, y si
  un paso falla dice por qué, no guarda resultados parciales y deja reintentar.
- Entrega el **hipnograma** con la confianza de cada época y las épocas **marcadas para revisión**
  (confianza < 0,65). La noche queda «por revisar» o, si se marca más del 27,3 %, con «revisión
  completa sugerida».
- **Revisión del especialista** época a época: visor multicanal con controles de tiempo y amplitud
  claros, **épocas vecinas** (anterior y siguiente, del modelo o decididas por un revisor), las
  **dos opciones más probables** a un clic, **evidencia de la señal** (potencia del EEG por bandas,
  comparada con las épocas típicas de cada estadio en la misma noche), atajos de teclado y cola de
  épocas pendientes. Antes de **finalizar**, un resumen de lo confirmado y corregido permite
  deshacer un cambio por error.
- **Vista clínica** sin métricas de evaluación del modelo: hipnograma, revisión, **arquitectura del
  sueño** del hipnograma final (TIB, TST, eficiencia, latencias, WASO, despertares, % por estadio),
  **notas del técnico** y **bitácora** (usuario, fecha, acción, valor anterior y nuevo). Lo técnico
  (acuerdo con la referencia, F1 macro, kappa, matriz de confusión) va aparte, en «Desempeño del
  modelo». Cada término técnico tiene una explicación en lenguaje llano (ⓘ).
- No entrega diagnósticos ni recomendaciones clínicas, y lo dice en cada resultado.
- Exporta el hipnograma por época y **todas las correcciones** en CSV: el insumo para medir
  el modelo en uso y reentrenarlo.

## Cómo funciona

```
catálogo (S3 / carpeta) ─┐
PSG subido (POST /uploads)┴─► canales + ventana + apagado de luces ─► POST /analyses (valida y responde 202)
   ─► pipeline en segundo plano (app/jobs.py):
        1 cargar señales   EDF (descargado de S3 si hace falta), canales elegidos, ventana
        2 preprocesar      épocas de 30 s; señal para el visor
        3 predecir         adaptador del modelo → estadio + 5 probabilidades por época (validadas)
        4 marcar épocas    regla de confianza (umbral 0,65 · aviso de noche 27,3 %), métricas
        5 guardar          todo de una vez: «to_review» o «full_review_suggested»
   ─► revisión: épocas vecinas · 2 opciones · evidencia espectral · confirmar / corregir
   ─► resumen de cambios ─► finalizar · notas · bitácora · exportación
```

El modelo está detrás de un **adaptador** (`app/model/adapter.py`): el pipeline solo conoce esa
interfaz, y la versión y el umbral del modelo los reporta el adaptador y quedan guardados con cada
noche (`SOMNOAI_MODEL`):

| Adaptador | Qué hace |
|---|---|
| `provisional` (por defecto) | YASA, un estadificador abierto que corre en la API: resultados reales sobre la señal mientras se integra el modelo del proyecto. |
| `mock` | Doble de pruebas con probabilidades sintéticas deterministas (pruebas y CI). |

El stacking del proyecto (XGBoost + CNN/Transformer + meta-modelo; ver
[el repositorio del proyecto](https://github.com/juancasas1996/MAIA_Trabajo_de_Grado_DeepSleep_Stacking))
se conectará después como otro adaptador, sin tocar el pipeline ni la interfaz:
[`docs/MODEL_INTEGRATION.md`](docs/MODEL_INTEGRATION.md).

## Arquitectura

```
┌──────────────────┐  HTTP/JSON   ┌───────────────────────────────┐  StagingRequest  ┌─────────────────────┐
│ Tablero          │ ───────────► │ API (FastAPI)                 │ ───────────────► │ Adaptador del modelo│
│ HTML + JS puro   │ docs/API_    │ catálogo · cargas · pipeline  │ ◄─────────────── │ provisional · mock  │
│ (sin build)      │ CONTRACT.md  │ por pasos · SQLite · revisión │  estadio + probs │                     │
└──────────────────┘              └──────────────┬────────────────┘                  └─────────────────────┘
                                                 │ encabezados por rango · descarga al analizar
                                          ┌──────▼──────┐
                                          │ S3 (noches) │
                                          └─────────────┘
```

- El catálogo lista las noches leyendo solo el encabezado de cada PSG (por rango en S3) y lo guarda
  en la base; la noche se descarga al analizarla y queda en una cache local con tope.
- El visor nunca recibe la señal cruda completa: la API sirve la **envolvente mín-máx** de
  la ventana visible (`GET /records/{id}/signal`).
- La salida del modelo se guarda tal como llegó; las decisiones del especialista se guardan
  aparte, con autor y fecha. El hipnograma final y sus métricas se recalculan al leer.
- Todo vive en SQLite (`data/store/somnoai.db`): sobrevive a reinicios y lo comparten todos los
  usuarios. Una base de la versión anterior se migra sola al arrancar.

## Estructura del repositorio

```
frontend/                  Tablero (HTML + JS puro, sin dependencias ni build)
  index.html               vistas y estilos (modo claro y oscuro)
  js/config.js             URL de la API, o null = modo demo sin backend
  js/api.js · js/mock.js   cliente de la API · backend simulado del modo demo
  js/edf.js                lectura del encabezado EDF en el navegador (solo modo demo)
  js/charts.js             gráficos SVG: hipnograma, visor multicanal, métricas
  js/ui.js                 glosario (ⓘ), diálogos, pasos del análisis, etiquetas
  js/app.js                sesión, registros y «Analizar nuevo» (catálogo, carga, canales)
  js/review.js             avance, resultados, revisión, notas y desempeño del modelo
backend/
  app/main.py              endpoints (contrato en docs/API_CONTRACT.md)
  app/jobs.py              pipeline por pasos en segundo plano, reintento
  app/catalog.py           catálogo de noches (carpeta local o S3)
  app/uploads.py           PSG subidos: validación y canales
  app/channels.py          reconocer canales, tipos y validar asignaciones
  app/db.py                SQLite: noches, decisiones, notas, bitácora (con migración)
  app/model/               adapter (interfaz y validación) · provisional (YASA) · mock (pruebas)
  app/pipeline/            edf_io · epochs · hypnogram · window · metrics · review · spectral
  app/data/sleep_edfx_index.csv   las 153 noches de Sleep-EDFx con edad, sexo, apagado de luces y partición
  data/demo/download_demos.sh     descarga las noches demo de PhysioNet
  scripts/make_subset_nights.py   ~50 noches con un subconjunto de canales (US-08)
  tests/                   pruebas (pytest) con EDF sintéticos
  Dockerfile · run.sh · requirements.txt · requirements-dev.txt
docs/
  API_CONTRACT.md          contrato tablero ↔ API
  MODEL_INTEGRATION.md     la frontera del adaptador del modelo
.github/workflows/ci.yml   pruebas en cada pull request
docker-compose.yml         API + tablero
```

## Requisitos

- **Python 3.12** y `pip` (probado con 3.12.9 en macOS).
- ~150 MB de disco para las 3 noches demo (1,6 GB para las 32 del test).
- Docker solo para el despliegue con contenedores.

## Instalación y ejecución

```bash
git clone <url-del-repositorio> SomnoAI-v2 && cd SomnoAI-v2

# 1 · entorno del backend
python3.12 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements-dev.txt

# 2 · noches demo (3 noches del test de Sleep-EDFx, ~150 MB)
sh backend/data/demo/download_demos.sh

# 3 · API + tablero → http://localhost:8000
backend/run.sh
```

Credenciales del prototipo: **superusuario / somnoai2026** (más cuentas con `SOMNOAI_USERS`).
Con la base vacía, el primer arranque lanza cuatro análisis de muestra sobre las noches demo del
catálogo (combinaciones distintas, incluida Pz-Oz sola, que queda bajo la meta). La documentación
interactiva de la API está en `http://localhost:8000/docs`.

### Catálogo en S3

Por defecto el catálogo es la carpeta `backend/data/demo`. Para usar las noches de prueba en S3:

```bash
export SOMNOAI_CATALOG=s3://<bucket>/<prefijo>/     # *-PSG.edf con su *-Hypnogram.edf
export AWS_REGION=us-east-1                         # + credenciales de AWS en el entorno (nunca en el repo)
backend/run.sh
```

Sin credenciales se lee sin firmar, lo que sirve para buckets públicos; por ejemplo, el espejo de
PhysioNet: `SOMNOAI_CATALOG=s3://physionet-open/sleep-edfx/1.0.0/sleep-cassette/` (153 noches).

### Noches con canales faltantes (US-08)

```bash
cd backend
.venv/bin/python scripts/make_subset_nights.py --dry-run     # el plan: ~50 noches, sin escribir nada
.venv/bin/python scripts/make_subset_nights.py               # → <catálogo>/subsets/<noche>-<combinación>/
```

Toma las noches de test del catálogo y crea ~50 copias, cada una con una combinación válida de
canales (siempre con un EEG; nunca la de los cuatro), repartidas por igual entre las 11
combinaciones incompletas. Es una copia exacta de las muestras sin los canales que «faltan»; se
conservan los que el modelo no usa y el hipnograma. Con `--source`/`--dest` en `s3://…` escribe en
el bucket (necesita permiso de escritura). En `<destino>/manifest.json` queda lo que se generó.

Variables útiles:

| Variable | Valor por defecto | |
|---|---|---|
| `SOMNOAI_MODEL` | `provisional` | `provisional` o `mock` |
| `SOMNOAI_CATALOG` | `backend/data/demo` | catálogo de noches: una carpeta o `s3://bucket/prefijo/` |
| `SOMNOAI_S3_ANONYMOUS` | `auto` | `1` lee S3 sin firmar, `0` exige credenciales, `auto` decide según haya credenciales |
| `AWS_REGION` | `us-east-1` | región del bucket |
| `SOMNOAI_CACHE_MB` | `3000` | tope de la cache local de noches descargadas de S3 |
| `SOMNOAI_DEMO_DIR` | `backend/data/demo` | carpeta con los EDF de Sleep-EDFx (catálogo por defecto) |
| `SOMNOAI_SEED_DEMOS` | `1` | `0` para no lanzar análisis de muestra |
| `SOMNOAI_USERS` | — | `{"usuario": {"password": "…", "name": "Dra. …"}}` |
| `SOMNOAI_SECRET` | archivo en `data/store/` | clave con que se firman las sesiones |

### Con Docker

```bash
sh backend/data/demo/download_demos.sh     # los datos van por volumen, no en la imagen
docker compose up --build                  # API y tablero :8000 · tablero aparte (nginx) :8050
```

### Modo demo (solo el tablero, sin backend)

Abrir `frontend/index.html` directamente (o poner `apiBase: null` en `frontend/js/config.js`):
el tablero corre con un backend simulado en el navegador, con las mismas reglas y datos
sintéticos. Sirve para mostrar la interfaz sin Python.

## Guía rápida

1. **Analizar nuevo** → busque y elija una noche del catálogo (o, abajo, suba su propio PSG).
2. Revise los **canales**: los del modelo se asignan solos, los demás aparecen como «no los usa el
   modelo». Mire el desempeño esperado de la combinación.
3. Elija la **ventana** y confirme el **apagado de luces** → *Analizar*. El diálogo muestra cada
   paso; al terminar, *Ver resultados*.
4. En **Resultados** (vista clínica), el hipnograma muestra en naranja las épocas para revisar. En
   **Revisión época a época**:

   | Tecla | Acción |
   |---|---|
   | `←` `→` | época anterior / siguiente |
   | `⇧` + `←` `→` | época marcada pendiente anterior / siguiente |
   | `A` `B` | 1.ª / 2.ª opción del modelo |
   | `W` `1` `2` `3` `R` | asignar W, N1, N2, N3, REM (también `0` y `5`) |
   | `Enter` | confirmar el estadio del modelo |
   | `⌫` | volver al estadio del modelo |

   Al decidir, el visor salta a la siguiente época pendiente. Un clic en el hipnograma, en la señal
   o en una época vecina lleva a esa época.
5. **Finalizar revisión** muestra el resumen de cambios (se puede deshacer cualquiera) y firma con
   su nombre; se puede reabrir. Agregue **notas** si hace falta.
6. **Desempeño del modelo** (pestaña aparte) tiene el acuerdo con el hipnograma del experto.
7. **Exportar** el hipnograma por época, o desde *Registros* todas las correcciones.

## Pruebas e integración continua

```bash
cd backend && .venv/bin/pytest -q          # 57 pruebas, ~4 s, con el doble de pruebas del modelo
```

Las pruebas generan EDF y EDF+ sintéticos con la estructura de Sleep-EDFx (no necesitan el
dataset) y cubren canales y asignaciones inválidas, encabezados y épocas, la validación de la
salida del adaptador, la evidencia espectral, el catálogo (carpeta y S3 simulado), las cargas
válidas e inválidas, el pipeline por pasos con fallo sin resultados parciales y reintento, la
versión del modelo por noche, la revisión (confirmar, corregir, deshacer, resumen, finalizar,
reabrir), las notas, la bitácora, la persistencia tras un reinicio, la migración de la base, las
noches con canales faltantes y la exportación. GitHub Actions las corre en cada pull request,
junto con una revisión de sintaxis del JavaScript y la construcción de la imagen Docker.

## Probar la API con curl

```bash
TOKEN=$(curl -s -X POST http://localhost:8000/api/v1/auth/login \
  -H 'Content-Type: application/json' -d '{"username":"superusuario","password":"somnoai2026"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
H="Authorization: Bearer $TOKEN"

# noches del catálogo y sus canales
curl -s http://localhost:8000/api/v1/catalog -H "$H"

# analizar una noche del catálogo con Fpz-Cz + EOG en la ventana del hipnograma
curl -s -X POST http://localhost:8000/api/v1/analyses -H "$H" -H 'Content-Type: application/json' \
  -d '{"source":{"type":"catalog","id":"SC4001E0-PSG.edf"},"channels":["fpz","eog"]}'

# o subir un PSG propio y analizarlo
curl -s -X POST http://localhost:8000/api/v1/uploads -H "$H" -F "file=@noche.edf"
curl -s -X POST http://localhost:8000/api/v1/analyses -H "$H" -H 'Content-Type: application/json' \
  -d '{"source":{"type":"upload","id":"<id de la carga>"},"channels":["fpz"],"window_mode":"full"}'

# consultar el registro (pasos en progress.steps) hasta que status sea done
curl -s http://localhost:8000/api/v1/records/<id> -H "$H"

# corregir la época 120 a N2 y finalizar
curl -s -X PATCH http://localhost:8000/api/v1/records/<id>/epochs -H "$H" \
  -H 'Content-Type: application/json' -d '{"changes":[{"epoch":120,"stage":2}]}'
curl -s -X POST http://localhost:8000/api/v1/records/<id>/review -H "$H" \
  -H 'Content-Type: application/json' -d '{"action":"finalize"}'
```

## Estado y pendientes

- [x] Adaptador del modelo con el modelo provisional; salida validada antes de guardar (US-01).
- [x] Pipeline de punta a punta por pasos, con fallos explícitos y reintento (US-02, US-20).
- [x] Persistencia de noches, decisiones, notas y bitácora; migración de la base (US-03).
- [x] Versión y umbral del modelo por noche (US-04); arquitectura del hipnograma final (US-05).
- [x] Catálogo de noches en S3 o carpeta (US-06); PSG propio validado en el servidor (US-07);
      script de noches con canales faltantes (US-08).
- [x] Canales del modelo vs. del archivo, sin asignaciones duplicadas ni inválidas (US-09, US-10).
- [x] Revisión asistida: evidencia espectral, épocas vecinas, dos opciones, resumen antes de
      finalizar, notas (US-11 a US-15).
- [x] Vista clínica, glosario, aviso de alcance, controles de amplitud, arquitectura legible (US-16 a US-21).
- [ ] Ajustar las bandas de la evidencia espectral con la investigación de Juan Camilo
      (`SPECTRAL_BANDS` en `app/config.py`).
- [ ] Correr `scripts/make_subset_nights.py` contra el bucket del equipo (con Sebastián).
- [ ] Fuera de este alcance: adaptador de SageMaker, despliegue y CI/CD.

## Datos y referencias

**Datos:** [Sleep-EDF Database Expanded v1.0.0](https://physionet.org/content/sleep-edfx/1.0.0/)
(PhysioNet), subconjunto Sleep Cassette: 153 noches de 78 personas sanas, EEG Fpz-Cz y
Pz-Oz y EOG a 100 Hz, EMG submental como envolvente a 1 Hz, hipnogramas R&K (3 y 4 unidos
en N3). Los EDF no se versionan en el repositorio.

- Kemp B. et al. *Analysis of a sleep-dependent neuronal feedback loop.* IEEE TBME, 2000.
- Goldberger A.L. et al. *PhysioBank, PhysioToolkit, and PhysioNet.* Circulation, 2000.
- Rosenberg R.S., Van Hout S. *The AASM inter-scorer reliability program: sleep stage scoring.* JCSM, 2013.
- Vallat R., Walker M.P. *An open-source, high-performance tool for automated sleep staging (YASA).* eLife, 2021 — modelo provisional.
- Gramfort A. et al. *MEG and EEG data analysis with MNE-Python.* Frontiers in Neuroscience, 2013.

## Licencia y uso

Proyecto académico (MAIA · Universidad de los Andes, 2026). Los datos de Sleep-EDFx son de
PhysioNet y conservan su licencia original (ODC-BY 1.0). Este software se comparte con fines
educativos; **no debe usarse para tomar decisiones clínicas**.
