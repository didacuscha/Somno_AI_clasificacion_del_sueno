#!/bin/sh
# Descarga noches de Sleep-EDFx (PhysioNet) para usarlas como demo en la API.
#
#   ./download_demos.sh          las 3 noches destacadas del test (~150 MB)
#   ./download_demos.sh --test   las 32 noches del test del proyecto (~1,6 GB)
#
# Son noches de sujetos que el modelo del proyecto nunca vio (particiones.json).
# Se intenta primero el espejo S3 (más rápido) y luego physionet.org.
cd "$(dirname "$0")"
S3="https://physionet-open.s3.amazonaws.com/sleep-edfx/1.0.0/sleep-cassette"
PN="https://physionet.org/files/sleep-edfx/1.0.0/sleep-cassette"
FILES="SC4001E0-PSG.edf SC4001EC-Hypnogram.edf SC4331F0-PSG.edf SC4331FV-Hypnogram.edf SC4601E0-PSG.edf SC4601EC-Hypnogram.edf"
if [ "$1" = "--test" ]; then
  FILES=$(awk -F, '{ sub(/\r$/, "") } NR > 1 && $8 == "test" { print $6, $7 }' ../../app/data/sleep_edfx_index.csv)
fi
for f in $FILES; do
  if [ -s "$f" ]; then echo "ya existe: $f"; continue; fi
  echo "descargando $f…"
  curl -sf -o "$f.part" "$S3/$f" || curl -sf -o "$f.part" "$PN/$f?download" || { echo "FALLÓ $f"; rm -f "$f.part"; exit 1; }
  mv "$f.part" "$f"
done
echo "Listo: $(ls SC4*-PSG.edf 2>/dev/null | wc -l | tr -d ' ') noches en $(pwd)"
