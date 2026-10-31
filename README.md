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

- Recibe una noche de PSG (`.edf`, o `.zip` con el PSG y su hipnograma; hasta 600 MB) o
  analiza una de las noches de Sleep-EDFx guardadas en el servidor.
- Lee el encabezado **en el navegador** antes de subir nada: canales, frecuencias, hora de
  inicio, duración, edad y sexo. El usuario **elige los canales** (Fpz-Cz, Pz-Oz, EOG, EMG;
  12 combinaciones, siempre con un EEG), puede asignar a mano canales con otro nombre y ve el
  desempeño que obtuvo el modelo del proyecto con esa combinación (Tabla IV del informe).
- Elige la **ventana de análisis**: la ventana de sueño del hipnograma (±30 min, el recorte
  con que se entrenó el modelo), un rango horario o el registro completo; y el **apagado de
  luces** (se completa solo para las noches de Sleep-EDFx).
- Corre el análisis **en segundo plano** (el endpoint de SageMaker puede tardar minutos en
  encenderse) y muestra su avance.
- Entrega el **hipnograma** con la confianza de cada época, la 2.ª opción y las épocas
  **marcadas para revisión** (confianza < 0,65). Si se marca más del 27,3 % de la noche,
  sugiere revisarla completa.
- **Revisión del especialista** época a época: visor multicanal (también con los canales que
  el modelo no usó), probabilidades del modelo, referencia del experto si existe, atajos de
  teclado, cola de épocas pendientes, bitácora de cambios y **firma** de la revisión.
- Recalcula con cada corrección la **arquitectura del sueño** (TST, eficiencia, latencias,
  WASO, % por estadio) y la **concordancia** con el hipnograma de referencia (exactitud, MF1,
  κ, F1 por estadio, matriz de confusión), del modelo y del hipnograma final.
- Exporta el hipnograma por época y **todas las correcciones** en CSV: el insumo para medir
  el modelo en uso y reentrenarlo.

## Cómo funciona

```
.edf / .zip ──► encabezado leído en el navegador ──► canales + ventana + apagado de luces
           ──► POST /analyses (valida formato, canales y ventana; responde 202 al instante)
           ──► trabajo en segundo plano:
                 leer la ventana de cada canal (señal para el visor)
                 ──► cliente del modelo: probabilidades W/N1/N2/N3/REM por época
                 ──► regla de confianza (umbral 0,65 · aviso de noche 27,3 %)
                 ──► métricas de la noche y concordancia con la referencia
           ──► revisión del especialista: confirmar / corregir / firmar
           ──► métricas finales · bitácora · exportación
```

El modelo del proyecto (stacking de XGBoost con rasgos + CNN/Transformer sobre la señal +
meta-modelo; ver el informe de avance y
[el repositorio del proyecto](https://github.com/juancasas1996/MAIA_Trabajo_de_Grado_DeepSleep_Stacking))
vive en un endpoint asíncrono de SageMaker AI. La aplicación habla con él a través de un
**cliente intercambiable** (`SOMNOAI_MODEL`):

| Cliente | Qué hace |
|---|---|
| `provisional` (por defecto) | YASA, un estadificador abierto que corre en la API: resultados reales sobre la señal mientras se conecta el endpoint. |
| `mock` | Probabilidades sintéticas deterministas (desarrollo de la interfaz y CI). |
| `sagemaker` | El stacking del proyecto. **Pendiente**: lo conecta el equipo de modelo siguiendo [`docs/MODEL_INTEGRATION.md`](docs/MODEL_INTEGRATION.md). |

## Arquitectura

```
┌──────────────────┐  HTTP/JSON   ┌───────────────────────────────┐   StagingRequest   ┌─────────────────────┐
│ Tablero          │ ───────────► │ API (FastAPI)                 │ ─────────────────► │ Cliente del modelo  │
│ HTML + JS puro   │ docs/API_    │ validación · trabajos en 2.º  │ ◄───────────────── │ provisional · mock  │
│ (sin build)      │ CONTRACT.md  │ plano · SQLite · señal por    │  probabilidades    │ · sagemaker (S3 +   │
└──────────────────┘              │ ventanas · revisión · CSV     │  por época         │   endpoint async)   │
                                  └───────────────────────────────┘                    └─────────────────────┘
```

- El visor nunca recibe la señal cruda completa: la API sirve la **envolvente mín-máx** de
  la ventana visible (`GET /records/{id}/signal`).
- La salida del modelo se guarda tal como llegó; las correcciones del especialista se guardan
  aparte, con autor y fecha. El hipnograma final y sus métricas se recalculan al leer.
- Las reglas del modelo (umbral, canales, desempeño esperado) viven en el backend
  (`app/config.py`) y el tablero las lee de `GET /config`.

## Estructura del repositorio

```
frontend/                  Tablero (HTML + JS puro, sin dependencias ni build)
  index.html               vistas y estilos (modo claro y oscuro)
  js/config.js             URL de la API, o null = modo demo sin backend
  js/api.js · js/mock.js   cliente de la API · backend simulado del modo demo
  js/edf.js                lectura del encabezado EDF (y de un .zip) en el navegador
  js/charts.js             gráficos SVG: hipnograma, visor multicanal, métricas
  js/ui.js · js/app.js     piezas comunes · sesión, registros y carga
  js/review.js             resultados y revisión del especialista
backend/
  app/main.py              endpoints (contrato en docs/API_CONTRACT.md)
  app/jobs.py              análisis en segundo plano
  app/channels.py          reconocer canales y validar combinaciones
  app/pipeline/            edf_io · hypnogram · window · metrics · review
  app/model/               client (interfaz) · provisional · mock · sagemaker
  app/data/sleep_edfx_index.csv   las 153 noches de Sleep-EDFx con edad, sexo, apagado de luces y partición
  data/demo/download_demos.sh     descarga las noches demo de PhysioNet
  tests/                   pruebas (pytest) con EDF sintéticos
  Dockerfile · run.sh · requirements.txt · requirements-dev.txt
docs/
  API_CONTRACT.md          contrato tablero ↔ API
  MODEL_INTEGRATION.md     cómo conectar el endpoint de SageMaker
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
Con la base vacía, el primer arranque lanza cuatro análisis de muestra sobre las noches demo
(combinaciones distintas, incluida Pz-Oz sola, que queda bajo la meta). La documentación
interactiva de la API está en `http://localhost:8000/docs`.

Variables útiles:

| Variable | Valor por defecto | |
|---|---|---|
| `SOMNOAI_MODEL` | `provisional` | `provisional`, `mock` o `sagemaker` |
| `SOMNOAI_DEMO_DIR` | `backend/data/demo` | carpeta con los EDF de Sleep-EDFx (puede apuntar al dataset completo) |
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

1. **Analizar nuevo** → arrastre el `.edf` o el `.zip` (o elija una noche demo).
2. Revise los **canales** (los que no están en el archivo aparecen deshabilitados; un canal
   con otro nombre se puede asignar a mano) y mire el desempeño esperado de la combinación.
3. Elija la **ventana** y confirme el **apagado de luces** → *Analizar registro*.
4. En **Resultados**, el hipnograma muestra en naranja las épocas para revisar. En
   **Revisión época a época**:

   | Tecla | Acción |
   |---|---|
   | `←` `→` | época anterior / siguiente |
   | `⇧` + `←` `→` | época marcada pendiente anterior / siguiente |
   | `W` `1` `2` `3` `R` | asignar W, N1, N2, N3, REM (también `0` y `5`) |
   | `Enter` | confirmar la sugerencia del modelo |
   | `⌫` | volver a la predicción del modelo |

   Al decidir, el visor salta a la siguiente época pendiente. Un clic en el hipnograma o en
   la señal lleva a esa época.
5. **Finalizar revisión** firma el hipnograma con su nombre (se puede reabrir).
6. **Exportar** el hipnograma por época, o desde *Registros* todas las correcciones.

## Pruebas e integración continua

```bash
cd backend && .venv/bin/pytest -q          # 26 pruebas, ~3 s, con el modelo simulado
```

Las pruebas generan EDF y EDF+ sintéticos con la estructura de Sleep-EDFx (no necesitan el
dataset) y cubren canales y combinaciones, encabezados, hipnograma y ventana, métricas,
regla de confianza, el flujo asíncrono de la API, la revisión (confirmar, corregir, revertir,
firmar, bloquear, reabrir) y la exportación. GitHub Actions las corre en cada pull request,
junto con una revisión de sintaxis del JavaScript y la construcción de la imagen Docker.

## Probar la API con curl

```bash
TOKEN=$(curl -s -X POST http://localhost:8000/api/v1/auth/login \
  -H 'Content-Type: application/json' -d '{"username":"superusuario","password":"somnoai2026"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

# analizar un registro con Fpz-Cz + EOG en la ventana del hipnograma
curl -s -X POST http://localhost:8000/api/v1/analyses -H "Authorization: Bearer $TOKEN" \
  -F "file=@noche.zip" -F "channels=fpz,eog" -F "window_mode=reference"

# consultar el registro hasta que status sea done
curl -s http://localhost:8000/api/v1/records/<id> -H "Authorization: Bearer $TOKEN"

# corregir la época 120 a N2
curl -s -X PATCH http://localhost:8000/api/v1/records/<id>/epochs -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"changes":[{"epoch":120,"stage":2}]}'
```

## Estado y pendientes

- [x] Carga con lectura del encabezado en el navegador, selección de canales y ventana.
- [x] Análisis asíncrono con cliente de modelo intercambiable (provisional, simulado).
- [x] Revisión del especialista con bitácora y firma; métricas y concordancia recalculadas.
- [x] Exportación por registro y de todas las correcciones.
- [x] Pruebas automáticas, CI y Docker.
- [ ] Conectar el endpoint de SageMaker (`app/model/sagemaker_client.py`) — equipo de modelo.
- [ ] Medir la latencia de punta a punta en el endpoint desplegado (sección VII del informe).
- [ ] Despliegue en AWS y monitoreo (fracción marcada por noche, errores de validación).

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
