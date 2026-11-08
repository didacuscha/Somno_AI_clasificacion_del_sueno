#!/bin/sh
# Arranca la API y el tablero de SomnoAI en http://localhost:8000
#   SOMNOAI_MODEL=provisional (por defecto) | api | mock
cd "$(dirname "$0")"
# ajustes y secretos locales (fuera de git): ../.env, ver ../.env.example
if [ -f ../.env ]; then set -a; . ../.env; set +a; fi
exec ./.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
