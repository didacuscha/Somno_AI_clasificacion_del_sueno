#!/bin/sh
# Genera el PDF de la guía de uso (frontend/guia/SomnoAI_guia_de_uso.pdf) a partir de
# frontend/guia.html, la misma página que se abre desde la aplicación: así el PDF y la página
# no se separan. Vuelva a correrlo cada vez que cambie la guía o sus capturas.
#
#   sh docs/guia/generar_pdf.sh
#
# Necesita Google Chrome o Chromium (CHROME=/ruta/al/ejecutable para otra ubicación).
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT="$ROOT/frontend/guia/SomnoAI_guia_de_uso.pdf"

if [ -z "${CHROME:-}" ]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "$(command -v google-chrome || true)" "$(command -v chromium || true)" "$(command -v chromium-browser || true)"; do
    if [ -n "$c" ] && [ -x "$c" ]; then CHROME=$c; break; fi
  done
fi
[ -n "${CHROME:-}" ] || { echo "No encontré Chrome: indique la ruta con CHROME=..." >&2; exit 1; }

PROFILE=$(mktemp -d)
trap 'rm -rf "$PROFILE"' EXIT

# Los estilos de impresión de guia.html fijan el tamaño carta, el tema claro y el pie con el número de página.
"$CHROME" --headless=new --disable-gpu --no-first-run --no-default-browser-check \
  --user-data-dir="$PROFILE" --no-pdf-header-footer --print-to-pdf="$OUT" \
  "file://$ROOT/frontend/guia.html" 2>/dev/null

echo "PDF: $OUT ($(du -k "$OUT" | cut -f1) KB)"
