#!/bin/bash
# Primer arranque del servidor de SomnoAI (Ubuntu 24.04). deploy/aws/crear.sh completa los
# __VALORES__ y lo pasa como user-data. Aquí no hay secretos: los ajustes se leen cifrados
# del Parameter Store con el rol del servidor. Registro: /var/log/somnoai-setup.log
set -euxo pipefail
exec > >(tee -a /var/log/somnoai-setup.log) 2>&1

REPO="__REPO__"
BRANCH="__BRANCH__"
REGION="__REGION__"
PARAM="__PARAM__"
DIR=/opt/somnoai

# 2 GB de swap: la t3.small tiene 2 GB de RAM y construir la imagen pide más
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q docker.io docker-compose-v2 git
snap install aws-cli --classic
systemctl enable --now docker

git clone --branch "$BRANCH" --depth 1 "https://github.com/$REPO.git" "$DIR"
cd "$DIR"

# ajustes y secretos → .env, legible solo por root
( umask 077; /snap/bin/aws ssm get-parameter --region "$REGION" --name "$PARAM" --with-decryption \
    --query Parameter.Value --output text > .env )

docker compose --profile https up -d --build

# copia diaria de la base en S3 (03:15 UTC)
cat > /etc/cron.d/somnoai-backup <<'CRON'
15 3 * * * root docker exec somnoai-api python -m app.backup >> /var/log/somnoai-backup.log 2>&1
CRON

echo "SomnoAI listo: $(date -u)"
