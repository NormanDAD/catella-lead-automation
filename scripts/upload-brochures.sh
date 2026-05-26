#!/bin/bash
# upload-brochures.sh
# Uploade tous les PDFs de ~/Documents/Brochures vers le volume Railway.
#
# Usage :
#   UPLOAD_TOKEN=ton_token ./scripts/upload-brochures.sh
#
# Variables optionnelles :
#   RAILWAY_URL  — base URL du serveur (défaut : prod)
#   SRC_DIR      — dossier source (défaut : ~/Documents/Brochures)

set -euo pipefail

RAILWAY_URL="${RAILWAY_URL:-https://lead-automation-production-33e8.up.railway.app}"
SRC_DIR="${SRC_DIR:-$HOME/Documents/Brochures}"
TOKEN="${UPLOAD_TOKEN:-}"

if [[ -z "$TOKEN" ]]; then
  echo "❌ UPLOAD_TOKEN non défini. Usage : UPLOAD_TOKEN=xxx ./scripts/upload-brochures.sh"
  exit 1
fi

ok=0; fail=0; skip=0

for f in "$SRC_DIR"/*.pdf; do
  [[ -f "$f" ]] || continue

  # Extraire le nom du programme (2e segment du nom de fichier)
  base=$(basename "$f" .pdf)
  IFS=' - ' read -ra parts <<< "$base"
  if [[ ${#parts[@]} -lt 3 ]]; then
    echo "⚠️  skip (format inattendu): $base"
    ((skip++)); continue
  fi

  programme="${parts[1]}"

  # Vérifier si c'est une version non-1 (v2, v3…) → skip
  rest="${parts[*]:3}"
  if [[ "$rest" =~ ^[Vv][2-9] ]]; then
    echo "·  skip (variante ${rest:0:2}): $base"
    ((skip++)); continue
  fi

  slug=$(echo "$programme" | iconv -f utf-8 -t ascii//TRANSLIT | \
    tr '[:upper:]' '[:lower:]' | \
    sed "s/['\"]//g" | \
    sed 's/[^a-z0-9]/-/g' | \
    sed 's/-\+/-/g' | \
    sed 's/^-\|-$//g').pdf

  echo -n "⬆  $slug ... "

  encoded_slug=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$slug")
  http_status=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "${RAILWAY_URL}/api/admin/upload-brochure?filename=${encoded_slug}" \
    -H "x-admin-token: ${TOKEN}" \
    -H "Content-Type: application/octet-stream" \
    --data-binary "@$f")

  if [[ "$http_status" == "200" ]]; then
    echo "✅ ($http_status)"
    ((ok++))
  else
    echo "❌ ($http_status)"
    ((fail++))
  fi
done

echo ""
echo "Terminé : ${ok} ok · ${fail} erreurs · ${skip} ignorés"
