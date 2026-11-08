#!/usr/bin/env bash
# Despliega en el servidor la última versión de una rama (por Session Manager, sin SSH):
#
#   deploy/aws/actualizar.sh [rama]          (por defecto, main)
#
# Trae la rama, vuelve a leer los ajustes cifrados (/somnoai/env) y reconstruye los
# contenedores. La base, las señales y los certificados se conservan.
set -euo pipefail
REGION=${AWS_REGION:-us-east-1}
BRANCH=${1:-main}
export AWS_REGION=$REGION AWS_DEFAULT_REGION=$REGION

ID=$(aws ec2 describe-instances --filters Name=tag:Name,Values=somnoai Name=instance-state-name,Values=running \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)
[ "$ID" != None ] || { echo "no hay un servidor somnoai encendido en $REGION" >&2; exit 1; }

# Session Manager corre esto con /bin/sh (dash en Ubuntu: no tiene pipefail) y sin HOME.
# Además, el aws del snap lanzado desde Session Manager deja vacío el archivo si su salida
# va directo a él: por eso pasa por «| cat». Y como sin pipefail una falla de aws no se
# notaría, los ajustes se revisan ANTES de reemplazar el .env y de tocar el código.
script=$(cat <<EOF
set -eu
export HOME=/root
cd /opt/somnoai
( umask 077; /snap/bin/aws ssm get-parameter --region $REGION --name /somnoai/env --with-decryption --query Parameter.Value --output text | cat > .env.nuevo )
if ! grep -q '^SOMNOAI_DOMAIN=.' .env.nuevo || ! grep -q '^SOMNOAI_MODEL=.' .env.nuevo; then
  rm -f .env.nuevo
  echo "los ajustes de /somnoai/env llegaron vacíos o incompletos: el servidor no se tocó" >&2
  exit 1
fi
mv .env.nuevo .env
git fetch --depth 1 origin "$BRANCH"
git checkout -B "$BRANCH" FETCH_HEAD
docker compose --profile https up -d --build
docker image prune -f >/dev/null
git log --oneline -1
docker compose ps --format '{{.Name}} {{.Status}}'
EOF
)
CMD=$(aws ssm send-command --instance-ids "$ID" --document-name AWS-RunShellScript \
  --comment "SomnoAI: desplegar $BRANCH" --timeout-seconds 1800 \
  --parameters "$(python3 -c 'import json, sys; print(json.dumps({"commands": [sys.argv[1]], "executionTimeout": ["1800"]}))' "$script")" \
  --query Command.CommandId --output text)
echo "desplegando $BRANCH en $ID (comando $CMD)…"
while true; do
  status=$(aws ssm get-command-invocation --command-id "$CMD" --instance-id "$ID" --query Status --output text 2>/dev/null || echo Pending)
  case $status in Pending|InProgress|Delayed) sleep 10 ;; *) break ;; esac
done
aws ssm get-command-invocation --command-id "$CMD" --instance-id "$ID" \
  --query '[Status, StandardOutputContent, StandardErrorContent]' --output text | tail -25
[ "$status" = Success ]
