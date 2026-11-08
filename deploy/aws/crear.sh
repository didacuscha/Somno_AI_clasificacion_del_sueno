#!/usr/bin/env bash
# Crea (o completa, si ya existe una parte) la infraestructura de SomnoAI en AWS:
#   S3 (catálogo + copias de la base) · rol del servidor · firewall · IP elástica ·
#   ajustes cifrados (Parameter Store) · servidor EC2 con Docker y HTTPS.
#
#   deploy/aws/crear.sh <archivo con los ajustes del modelo>     (p. ej. el .env local)
#
# Del archivo solo se toman las líneas SOMNOAI_MODEL*. El script agrega lo que depende de AWS
# y genera la contraseña del tablero y la clave de las sesiones, sin imprimirlas: la
# contraseña se ve en la consola de AWS (Systems Manager → Parameter Store → /somnoai/env).
# Se puede volver a correr: lo que ya existe se conserva (la contraseña también).
#
# Variables: AWS_REGION (us-east-1) · BRANCH (main) · INSTANCE_TYPE (t3.small) · REPO
set -euo pipefail
SETTINGS=${1:?uso: deploy/aws/crear.sh <archivo con los ajustes del modelo>}
[ -f "$SETTINGS" ] || { echo "no existe $SETTINGS" >&2; exit 1; }
SETTINGS="$(cd "$(dirname "$SETTINGS")" && pwd)/$(basename "$SETTINGS")"   # antes del cd
cd "$(dirname "$0")"

REGION=${AWS_REGION:-us-east-1}
NAME=somnoai
REPO=${REPO:-didacuscha/Somno_AI_clasificacion_del_sueno}
BRANCH=${BRANCH:-main}
TYPE=${INSTANCE_TYPE:-t3.small}
PARAM=/$NAME/env
SOURCE=s3://physionet-open/sleep-edfx/1.0.0/sleep-cassette
INDEX=../../backend/app/data/sleep_edfx_index.csv
export AWS_REGION=$REGION AWS_DEFAULT_REGION=$REGION
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
BUCKET=$NAME-$ACCOUNT
say() { printf '\n== %s\n' "$*"; }

for key in SOMNOAI_MODEL_API SOMNOAI_MODEL_TOKEN; do
  grep -q "^$key=." "$SETTINGS" || { echo "falta $key en $SETTINGS" >&2; exit 1; }
done

# 1 · S3: privado, cifrado, copias de la base por 30 días ─────────────────────────────
say "S3: s3://$BUCKET"
if ! aws s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
  if [ "$REGION" = us-east-1 ]; then aws s3api create-bucket --bucket "$BUCKET" >/dev/null
  else aws s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration LocationConstraint="$REGION" >/dev/null; fi
fi
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration '{"Rules":[
  {"ID":"copias-30-dias","Filter":{"Prefix":"backups/"},"Status":"Enabled","Expiration":{"Days":30}},
  {"ID":"cargas-incompletas","Filter":{"Prefix":""},"Status":"Enabled","AbortIncompleteMultipartUpload":{"DaysAfterInitiation":7}}]}' >/dev/null
aws s3api put-bucket-tagging --bucket "$BUCKET" --tagging "TagSet=[{Key=proyecto,Value=$NAME}]"

say "Catálogo: las 32 noches de test de Sleep-EDFx (copia dentro de S3, desde PhysioNet)"
for f in $(awk -F, '{ sub(/\r$/, "") } NR > 1 && $8 == "test" { print $6; print $7 }' "$INDEX"); do
  aws s3api head-object --bucket "$BUCKET" --key "catalog/$f" >/dev/null 2>&1 && continue
  # --copy-props none: el bucket público de PhysioNet no deja leer las etiquetas de sus objetos
  aws s3 cp --only-show-errors --copy-props none "$SOURCE/$f" "s3://$BUCKET/catalog/$f"
done
echo "$(aws s3 ls "s3://$BUCKET/catalog/" | wc -l | tr -d ' ') archivos en catalog/"

# 2 · Rol del servidor: su bucket, sus ajustes y Session Manager (sin SSH ni llaves) ─
say "IAM: rol $NAME-ec2"
if ! aws iam get-role --role-name "$NAME-ec2" >/dev/null 2>&1; then
  aws iam create-role --role-name "$NAME-ec2" --description "Servidor de SomnoAI" \
    --tags Key=proyecto,Value=$NAME --assume-role-policy-document \
    '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
fi
aws iam put-role-policy --role-name "$NAME-ec2" --policy-name "$NAME-app" --policy-document \
  "$(sed -e "s/__BUCKET__/$BUCKET/g" -e "s/__REGION__/$REGION/g" -e "s/__ACCOUNT__/$ACCOUNT/g" politica-ec2.json)"
aws iam attach-role-policy --role-name "$NAME-ec2" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
if ! aws iam get-instance-profile --instance-profile-name "$NAME-ec2" >/dev/null 2>&1; then
  aws iam create-instance-profile --instance-profile-name "$NAME-ec2" >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name "$NAME-ec2" --role-name "$NAME-ec2"
fi

# 3 · Firewall: solo HTTP y HTTPS ─────────────────────────────────────────────────────
say "Firewall: $NAME-web (80 y 443; sin SSH)"
VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=$NAME-web Name=vpc-id,Values="$VPC" \
  --query 'SecurityGroups[0].GroupId' --output text)
if [ "$SG" = None ]; then
  SG=$(aws ec2 create-security-group --group-name "$NAME-web" --description "SomnoAI: HTTP y HTTPS" \
    --vpc-id "$VPC" --query GroupId --output text)
  aws ec2 authorize-security-group-ingress --group-id "$SG" --ip-permissions \
    'IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges=[{CidrIp=0.0.0.0/0}],Ipv6Ranges=[{CidrIpv6=::/0}]' \
    'IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0}],Ipv6Ranges=[{CidrIpv6=::/0}]' >/dev/null
  aws ec2 create-tags --resources "$SG" --tags Key=Name,Value=$NAME Key=proyecto,Value=$NAME
fi
echo "$SG"

# 4 · IP elástica: la dirección (y el certificado) no cambian si el servidor se reinicia ─
say "IP elástica"
ALLOC=$(aws ec2 describe-addresses --filters Name=tag:Name,Values=$NAME --query 'Addresses[0].AllocationId' --output text)
if [ "$ALLOC" = None ]; then
  ALLOC=$(aws ec2 allocate-address --domain vpc --query AllocationId --output text \
    --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=$NAME},{Key=proyecto,Value=$NAME}]")
fi
IP=$(aws ec2 describe-addresses --allocation-ids "$ALLOC" --query 'Addresses[0].PublicIp' --output text)
DOMAIN="${IP//./-}.sslip.io"
echo "$IP → https://$DOMAIN"

# 5 · Ajustes cifrados del servidor (el .env de producción) ───────────────────────────
say "Ajustes cifrados: $PARAM"
if aws ssm get-parameter --name "$PARAM" >/dev/null 2>&1; then
  echo "ya existe: se conserva (con su contraseña y su clave de sesiones)"
else
  tmp=$(mktemp); chmod 600 "$tmp"
  {
    grep -E '^SOMNOAI_MODEL' "$SETTINGS"
    echo "SOMNOAI_CATALOG=s3://$BUCKET/catalog/"
    echo "SOMNOAI_S3_ANONYMOUS=0"
    echo "AWS_REGION=$REGION"
    echo "SOMNOAI_BACKUP_S3=s3://$BUCKET/backups/"
    echo "SOMNOAI_DOMAIN=$DOMAIN"
    echo "SOMNOAI_API_PORT=127.0.0.1:8000"
    echo "SOMNOAI_SECRET=$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
    python3 -c 'import json, secrets; print("SOMNOAI_USERS=" + repr(json.dumps({"superusuario": {"password": secrets.token_urlsafe(18), "name": "Superusuario", "initials": "SU"}})))'
  } > "$tmp"
  aws ssm put-parameter --name "$PARAM" --type SecureString --tier Standard \
    --description "SomnoAI: .env del servidor" --tags Key=proyecto,Value=$NAME --value "file://$tmp" >/dev/null
  rm -f "$tmp"
  echo "creado · la contraseña de superusuario está ahí (consola de AWS → Systems Manager → Parameter Store)"
fi

# 6 · Servidor ─────────────────────────────────────────────────────────────────────────
say "Servidor: $TYPE · Ubuntu 24.04 · rama $BRANCH de $REPO"
ID=$(aws ec2 describe-instances --filters Name=tag:Name,Values=$NAME \
  Name=instance-state-name,Values=pending,running,stopping,stopped --query 'Reservations[0].Instances[0].InstanceId' --output text)
if [ "$ID" = None ]; then
  AMI=$(aws ssm get-parameter --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id \
    --query Parameter.Value --output text)
  ud=$(mktemp); err=$(mktemp)
  sed -e "s#__REPO__#$REPO#" -e "s#__BRANCH__#$BRANCH#" -e "s#__REGION__#$REGION#" -e "s#__PARAM__#$PARAM#" user-data.sh > "$ud"
  ID=""
  for _ in 1 2 3 4 5 6 7 8; do        # un perfil de IAM recién creado tarda unos segundos en verse
    if ID=$(aws ec2 run-instances --image-id "$AMI" --instance-type "$TYPE" \
        --iam-instance-profile Name=$NAME-ec2 --security-group-ids "$SG" \
        --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=20,VolumeType=gp3,Encrypted=true,DeleteOnTermination=true}' \
        --metadata-options HttpEndpoint=enabled,HttpTokens=required,HttpPutResponseHopLimit=2 \
        --user-data "file://$ud" \
        --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME},{Key=proyecto,Value=$NAME}]" \
                             "ResourceType=volume,Tags=[{Key=Name,Value=$NAME},{Key=proyecto,Value=$NAME}]" \
        --query 'Instances[0].InstanceId' --output text 2>"$err"); then break; fi
    ID=""
    grep -qi "instance profile" "$err" || { cat "$err" >&2; exit 1; }
    echo "esperando a que el perfil de IAM esté disponible…"; sleep 10
  done
  rm -f "$ud" "$err"
  [ -n "$ID" ] || { echo "no se pudo crear el servidor" >&2; exit 1; }
fi
aws ec2 wait instance-running --instance-ids "$ID"
aws ec2 associate-address --allocation-id "$ALLOC" --instance-id "$ID" >/dev/null

say "Listo"
echo "Servidor  $ID · $IP"
echo "Tablero   https://$DOMAIN   (la instalación tarda ~10 min; registro: /var/log/somnoai-setup.log)"
echo "Usuario   superusuario · contraseña en Systems Manager → Parameter Store → $PARAM"
