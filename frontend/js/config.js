/* ════════════════════════════════════════════════════════════════════
   Configuración del tablero MAIA / SomnoAI v2
   ────────────────────────────────────────────────────────────────────
   apiBase:
     - null  → modo DEMO: el tablero funciona solo, con un backend
               simulado en el navegador (js/mock.js).
     - URL   → modo REAL: la API de FastAPI (contrato en docs/API_CONTRACT.md).
   Las reglas del modelo (umbral de confianza, canales, desempeño esperado
   por combinación) NO viven aquí: las entrega la API en GET /config.
   ════════════════════════════════════════════════════════════════════ */
window.MAIA_CONFIG = {
  // Servido por la propia API (puerto 8000) → misma origen. Servido aparte (nginx
  // en :8050, python -m http.server) → la API en el puerto 8000 del mismo host.
  // Abierto como archivo (file://) → modo demo.
  apiBase: location.protocol === "file:" ? null
    : location.port === "8000" ? location.origin + "/api/v1"
    : "http://" + location.hostname + ":8000/api/v1",

  // La carga de un .edf de cientos de MB puede tardar; el análisis en sí corre
  // en segundo plano y el tablero solo consulta su estado.
  uploadTimeoutMs: 10 * 60 * 1000,
  requestTimeoutMs: 30 * 1000,
  pollMs: 1500
};
