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
DEMO_DIR = Path(os.environ.get("SOMNOAI_DEMO_DIR", DATA_DIR / "demo"))   # EDFs de Sleep-EDFx
STORE_DIR = DATA_DIR / "store"
UPLOAD_DIR = STORE_DIR / "uploads"      # archivos subidos, solo mientras se analizan
SIGNAL_DIR = STORE_DIR / "signals"      # señal de la ventana analizada (visor)
DB_PATH = STORE_DIR / "somnoai.db"
INDEX_PATH = Path(__file__).resolve().parent / "data" / "sleep_edfx_index.csv"

# ── modelo ────────────────────────────────────────────────────────────
# provisional: YASA, estadificador abierto que corre aquí mismo (para probar la app)
# mock:        resultados sintéticos deterministas (desarrollo de la interfaz y CI)
# sagemaker:   el endpoint asíncrono del proyecto (lo conecta el equipo de modelo)
MODEL_BACKEND = os.environ.get("SOMNOAI_MODEL", "provisional")
WORKERS = int(os.environ.get("SOMNOAI_WORKERS", "1"))
# Al arrancar con la base vacía, analiza las noches demo para que el tablero no empiece en blanco.
SEED_DEMOS = os.environ.get("SOMNOAI_SEED_DEMOS", "1") == "1"

# ── usuarios ──────────────────────────────────────────────────────────
# Cada corrección queda firmada con el nombre del usuario que la hizo. Se pueden
# definir más cuentas con SOMNOAI_USERS='{"usuario": {"password": "…", "name": "…"}}'.
USERS = {"superusuario": {"password": "somnoai2026", "name": "Superusuario", "initials": "SU"}}
USERS.update(json.loads(os.environ.get("SOMNOAI_USERS", "{}")))
TOKEN_HOURS = 12

# ── reglas del modelo (informe de avance, secciones III y IV) ─────────
EPOCH_S = 30
STAGES = ("W", "N1", "N2", "N3", "REM")             # codificación 0..4; -1 = sin etiqueta
WINDOW_MARGIN_EPOCHS = 60       # ventana de sueño: 30 min de vigilia a cada lado
MIN_WINDOW_EPOCHS = 20          # menos de 10 min no es una noche analizable
CONFIDENCE_THRESHOLD = 0.65     # la época se entrega si p(estadio elegido) ≥ 0,65; si no, «revisar»
NIGHT_REVIEW_FRACTION = 0.273   # si se marca más del 27,3 % de la noche, revisarla completa
MF1_GOAL = 0.75                 # meta interna con un solo EEG
MAX_UPLOAD_MB = 600

# Las cuatro modalidades, con las mismas claves que el código del proyecto de grado.
CHANNELS = {
    "fpz": {"label": "EEG Fpz-Cz", "kind": "eeg", "name": "Fpz-Cz"},
    "pz": {"label": "EEG Pz-Oz", "kind": "eeg", "name": "Pz-Oz"},
    "eog": {"label": "EOG horizontal", "kind": "eog", "name": "EOG"},
    "emg": {"label": "EMG submental", "kind": "emg", "name": "EMG"},
}
SLOTS = tuple(CHANNELS)

# Etiquetas que se reconocen como cada modalidad. Se comparan en minúsculas, sin
# espacios, guiones bajos ni puntos («EEG Fpz-Cz» → «eegfpz-cz»).
CHANNEL_ALIASES = {
    "fpz": [r"^(eeg)?fpz-?cz$"],
    "pz": [r"^(eeg)?pz-?oz$"],
    "eog": [r"^eog(horizontal|horiz|hor|h)?$", r"^heog$", r"^e1-?e2$", r"^loc-?roc$"],
    "emg": [r"^(emg)?(submental|chin|mentalis)$", r"^emg$", r"^chinemg$"],
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

# Noches demo destacadas: del test del proyecto (sujetos que el modelo nunca vio)
# y con edades distintas. Cualquier otra noche del índice con sus archivos en
# DEMO_DIR también aparece en la lista de demos.
FEATURED_DEMOS = ("SC4001E0", "SC4331F0", "SC4601E0")

# Análisis que se lanzan al arrancar con la base vacía (si están los archivos):
# muestran combinaciones distintas, incluida una por debajo de la meta (Pz-Oz).
SEED_ANALYSES = [
    {"demo_id": "SC4001E0", "channels": ["fpz", "pz", "eog", "emg"]},
    {"demo_id": "SC4001E0", "channels": ["fpz"]},
    {"demo_id": "SC4331F0", "channels": ["fpz", "eog"]},
    {"demo_id": "SC4601E0", "channels": ["pz"]},
]

for _d in (STORE_DIR, UPLOAD_DIR, SIGNAL_DIR):
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
