#!/bin/sh
# Arranca la API y el tablero de SomnoAI en http://localhost:8000
#   SOMNOAI_MODEL=provisional (por defecto) | mock
cd "$(dirname "$0")"
exec ./.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
