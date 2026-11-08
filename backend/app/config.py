"""Configuración del backend de SomnoAI v2 (estadificación del sueño).

Lo que cambia entre entornos se lee de variables SOMNOAI_*; el resto son las
reglas de operación del modelo, tal como las fija el informe de avance.
"""
import json
import os
import secrets
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent          # backend/
DATA_DIR = Path(os.environ.get("SOMNOAI_DATA_DIR", BASE_DIR / "data"))
DEMO_DIR = Path(os.environ.get("SOMNOAI_DEMO_DIR", DATA_DIR / "demo"))   # EDFs de Sleep-EDFx en disco
STORE_DIR = DATA_DIR / "store"
UPLOAD_DIR = STORE_DIR / "uploads"      # PSG subidos: se borran cuando su análisis termina bien
SIGNAL_DIR = STORE_DIR / "signals"      # señal de la ventana analizada (visor y evidencia espectral)
CACHE_DIR = STORE_DIR / "cache"         # noches del catálogo descargadas de S3
DB_PATH = STORE_DIR / "somnoai.db"
INDEX_PATH = Path(__file__).resolve().parent / "data" / "sleep_edfx_index.csv"

# ── catálogo de noches ────────────────────────────────────────────────
# Una carpeta local o una ubicación de S3 (s3://bucket/prefijo/). Se listan todos los
# *-PSG.edf con su *-Hypnogram.edf; lo que cuelga de SUBSET_PREFIX son las noches con
# un subconjunto de canales (scripts/make_subset_nights.py).
CATALOG = os.environ.get("SOMNOAI_CATALOG", str(DEMO_DIR))
SUBSET_PREFIX = "subsets/"
# S3: credenciales de la cadena estándar de AWS (variables, ~/.aws, rol). Sin
# credenciales se lee sin firmar (buckets públicos). "1" fuerza sin firmar, "0" exige firma.
S3_ANONYMOUS = os.environ.get("SOMNOAI_S3_ANONYMOUS", "auto")
AWS_REGION = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1"
CATALOG_TTL_S = int(os.environ.get("SOMNOAI_CATALOG_TTL", "120"))      # cache del listado
CACHE_MAX_MB = int(os.environ.get("SOMNOAI_CACHE_MB", "3000"))          # tope de noches descargadas
UPLOAD_TTL_H = 24                       # cargas que nadie analizó: se borran al arrancar

# ── modelo ────────────────────────────────────────────────────────────
# provisional: YASA, estadificador abierto que corre aquí mismo (el modelo de la app).
# api:         el modelo del proyecto (stacking) en SageMaker, por su API pública con token
#              (app/model/remote.py).
# mock:        doble de pruebas con resultados sintéticos deterministas (CI).
MODEL_BACKEND = os.environ.get("SOMNOAI_MODEL", "provisional")

# ── modelo del proyecto por su API (SOMNOAI_MODEL=api) ────────────────
# La URL y el token son secretos del servidor: van en .env (fuera de git), nunca en el
# código ni en el tablero.
MODEL_API = os.environ.get("SOMNOAI_MODEL_API", "").strip().rstrip("/")
MODEL_TOKEN = os.environ.get("SOMNOAI_MODEL_TOKEN", "").strip()
# Carpeta de S3 donde la API ya tiene las noches de test de Sleep-EDFx (s3://…/noches/):
# esas no se vuelven a subir. Vacía = se sube cada noche.
MODEL_NIGHTS = os.environ.get("SOMNOAI_MODEL_NIGHTS", "").strip()
if MODEL_NIGHTS and not MODEL_NIGHTS.endswith("/"):
    MODEL_NIGHTS += "/"
# La API no informa qué versión sirve: se declara aquí (el tag del repositorio del modelo).
MODEL_VERSION = os.environ.get("SOMNOAI_MODEL_VERSION", "sistema-sueno-v7")
# El endpoint se apaga tras 5 min sin uso y tarda ~8 min en prender: el tope cubre eso de sobra.
MODEL_TIMEOUT_MIN = float(os.environ.get("SOMNOAI_MODEL_TIMEOUT_MIN", "25"))
MODEL_POLL_S = float(os.environ.get("SOMNOAI_MODEL_POLL_S", "10"))
WORKERS = int(os.environ.get("SOMNOAI_WORKERS", "1"))
# Al arrancar con la base vacía, analiza unas noches del catálogo para que el tablero no empiece en blanco.
SEED_DEMOS = os.environ.get("SOMNOAI_SEED_DEMOS", "1") == "1"

# ── usuarios ──────────────────────────────────────────────────────────
# Cada corrección queda firmada con el nombre del usuario que la hizo. Se pueden
# definir más cuentas con SOMNOAI_USERS='{"usuario": {"password": "…", "name": "…"}}'.
USERS = {"superusuario": {"password": "somnoai2026", "name": "Superusuario", "initials": "SU"}}
USERS.update(json.loads(os.environ.get("SOMNOAI_USERS", "{}")))
TOKEN_HOURS = 12

# ── reglas del modelo (informe de avance, secciones III y IV) ─────────
# Las reporta el adaptador del modelo (cada versión trae las suyas); estas son las del informe.
EPOCH_S = 30
STAGES = ("W", "N1", "N2", "N3", "REM")             # codificación 0..4; -1 = sin etiqueta
WINDOW_MARGIN_EPOCHS = 60       # ventana de sueño: 30 min de vigilia a cada lado
MIN_WINDOW_EPOCHS = 20          # menos de 10 min no es una noche analizable
CONFIDENCE_THRESHOLD = 0.65     # la época se entrega si p(estadio elegido) ≥ 0,65; si no, «revisar»
NIGHT_REVIEW_FRACTION = 0.273   # si se marca más del 27,3 % de la noche, revisarla completa
PROB_SUM_TOLERANCE = 0.01       # cada fila de probabilidades debe sumar 1 ± esto
MF1_GOAL = 0.75                 # meta interna con un solo EEG
MAX_UPLOAD_MB = 600
MAX_NOTE_CHARS = 2000

# Las cuatro entradas del modelo, con las mismas claves que el código del proyecto de grado.
CHANNELS = {
    "fpz": {"label": "EEG Fpz-Cz", "kind": "eeg", "name": "Fpz-Cz"},
    "pz": {"label": "EEG Pz-Oz", "kind": "eeg", "name": "Pz-Oz"},
    "eog": {"label": "EOG horizontal", "kind": "eog", "name": "EOG"},
    "emg": {"label": "EMG submental", "kind": "emg", "name": "EMG"},
}
SLOTS = tuple(CHANNELS)

# Etiquetas que se reconocen como cada entrada. Se comparan en minúsculas, sin
# espacios, guiones bajos ni puntos («EEG Fpz-Cz» → «eegfpz-cz»).
CHANNEL_ALIASES = {
    "fpz": [r"^(eeg)?fpz-?cz$"],
    "pz": [r"^(eeg)?pz-?oz$"],
    "eog": [r"^eog(horizontal|horiz|hor|h)?$", r"^heog$", r"^e1-?e2$", r"^loc-?roc$"],
    "emg": [r"^(emg)?(submental|chin|mentalis)$", r"^emg$", r"^chinemg$"],
}
# Tipo de señal de un canal con otro nombre: solo un canal del mismo tipo se puede
# asignar a mano a una entrada. Lo demás (respiración, temperatura, marcadores, ECG…)
# queda como «en el archivo, no lo usa el modelo».
_ELECTRODE = r"(fp|af|f|fc|c|cp|p|po|o|t|tp|ft)[0-9z]{1,2}"
CHANNEL_KINDS = {
    "eeg": [r"eeg", rf"^{_ELECTRODE}(-?({_ELECTRODE}|[am][12]|ref|avg))?$"],
    "eog": [r"eog", r"^(loc|roc|e1|e2)(-?([am][12]|loc|roc|e1|e2))?$"],
    "emg": [r"emg", r"chin", r"submental", r"mentalis"],
}

# Desempeño del sistema completo por combinación (informe, Tabla IV): CV sobre los
# 62 sujetos de desarrollo y test sobre los 16 reservados (IC 95 % por bootstrap).
EXPECTED = {
    "fpz":          {"cv_mf1": 0.802, "test_mf1": 0.772, "test_ci": [0.736, 0.802], "test_kappa": 0.750, "test_f1_n1": 0.518},
    "fpz_emg":      {"cv_mf1": 0.805, "test_mf1": 0.772, "test_ci": [0.735, 0.803], "test_kappa": 0.747, "test_f1_n1": 0.523},
    "fpz_eog":      {"cv_mf1": 0.811, "test_mf1": 0.782, "test_ci": [0.749, 0.811], "test_kappa": 0.755, "test_f1_n1": 0.533},
    "fpz_eog_emg":  {"cv_mf1": 0.813, "test_mf1": 0.781, "test_ci": [0.748, 0.810], "test_kappa": 0.752, "test_f1_n1": 0.534},
    "pz":           {"cv_mf1": 0.762, "test_mf1": 0.737, "test_ci": [0.686, 0.773], "test_kappa": 0.704, "test_f1_n1": 0.492},
    "pz_emg":       {"cv_mf1": 0.766, "test_mf1": 0.738, "test_ci": [0.685, 0.777], "test_kappa": 0.702, "test_f1_n1": 0.499},
    "pz_eog":       {"cv_mf1": 0.790, "test_mf1": 0.753, "test_ci": [0.698, 0.793], "test_kappa": 0.718, "test_f1_n1": 0.506},
    "pz_eog_emg":   {"cv_mf1": 0.790, "test_mf1": 0.757, "test_ci": [0.711, 0.794], "test_kappa": 0.722, "test_f1_n1": 0.508},
    "eeg2":         {"cv_mf1": 0.812, "test_mf1": 0.780, "test_ci": [0.751, 0.805], "test_kappa": 0.758, "test_f1_n1": 0.522},
    "eeg2_emg":     {"cv_mf1": 0.814, "test_mf1": 0.779, "test_ci": [0.750, 0.804], "test_kappa": 0.754, "test_f1_n1": 0.526},
    "eeg2_eog":     {"cv_mf1": 0.819, "test_mf1": 0.785, "test_ci": [0.755, 0.812], "test_kappa": 0.759, "test_f1_n1": 0.531},
    "eeg2_eog_emg": {"cv_mf1": 0.819, "test_mf1": 0.784, "test_ci": [0.753, 0.810], "test_kappa": 0.758, "test_f1_n1": 0.534},
}

# ── evidencia espectral (US-11) ───────────────────────────────────────
# Potencia relativa por banda del EEG en la época. PROVISIONAL: las bandas que se
# muestran se ajustan con la investigación de Juan Camilo sobre lo que miran los
# técnicos al estadificar; basta con editar esta lista.
SPECTRAL_BANDS = [
    {"key": "delta", "label": "Delta", "lo": 0.5, "hi": 4.0, "hint": "Ondas lentas; predominan en N3."},
    {"key": "theta", "label": "Theta", "lo": 4.0, "hi": 8.0, "hint": "Típica de N1 y REM."},
    {"key": "alpha", "label": "Alfa", "lo": 8.0, "hi": 12.0, "hint": "Vigilia relajada con los ojos cerrados."},
    {"key": "sigma", "label": "Sigma (husos)", "lo": 12.0, "hi": 15.0, "hint": "Husos de sueño, típicos de N2."},
    {"key": "beta", "label": "Beta", "lo": 15.0, "hi": 30.0, "hint": "Vigilia activa y microdespertares."},
]
SPECTRAL_MIN_TYPICAL = 5        # épocas mínimas de un estadio para mostrar su perfil típico

# Noches destacadas: del test del proyecto (sujetos que el modelo nunca vio) y con
# edades distintas. Salen primero en el catálogo.
FEATURED_DEMOS = ("SC4001E0", "SC4331F0", "SC4601E0")

# Análisis que se lanzan al arrancar con la base vacía (si las noches están en el catálogo):
# muestran combinaciones distintas, incluida una por debajo de la meta (Pz-Oz).
SEED_ANALYSES = [
    {"psg": "SC4001E0-PSG.edf", "channels": ["fpz", "pz", "eog", "emg"]},
    {"psg": "SC4001E0-PSG.edf", "channels": ["fpz"]},
    {"psg": "SC4331F0-PSG.edf", "channels": ["fpz", "eog"]},
    {"psg": "SC4601E0-PSG.edf", "channels": ["pz"]},
]

for _d in (STORE_DIR, UPLOAD_DIR, SIGNAL_DIR, CACHE_DIR):
    _d.mkdir(parents=True, exist_ok=True)


def _secret() -> bytes:
    """Clave para firmar las sesiones. Se guarda en disco para que reiniciar la API
    no cierre la sesión de quien está revisando una noche."""
    if os.environ.get("SOMNOAI_SECRET"):
        return os.environ["SOMNOAI_SECRET"].encode()
    path = STORE_DIR / ".secret"
    if not path.exists():
        path.write_text(secrets.token_hex(32))
    return path.read_text().strip().encode()


SECRET = _secret()
