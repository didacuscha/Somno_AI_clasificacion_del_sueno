# API de SomnoAI v2 — FastAPI + tablero estático
#
# OJO: el contexto de construcción es la RAÍZ del repositorio, no backend/, para
# que el tablero (frontend/) entre en la imagen. Ver docker-compose.yml.
FROM python:3.12-slim

# libgomp1: la necesita LightGBM, que usa el modelo provisional (YASA)
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Los --trusted-host toleran el proxy corporativo que intercepta TLS;
# en redes normales no estorban.
COPY backend/requirements.txt .
RUN pip install --no-cache-dir \
    --trusted-host pypi.org --trusted-host files.pythonhosted.org \
    -r requirements.txt

COPY backend/app ./app
COPY frontend /frontend
ENV SOMNOAI_FRONTEND_DIR=/frontend

# data/ llega como volumen (ver docker-compose.yml): noches demo, base de datos
# y señales viven fuera de la imagen.
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
