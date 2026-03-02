#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRIVATE_KEY_PATH="$ROOT_DIR/tesla-private-key.pem"
PUBLIC_KEY_PATH="$ROOT_DIR/public/.well-known/appspecific/com.tesla.3p.public-key.pem"
MAX_PUBLIC_KEY_BYTES=2048

mkdir -p "$(dirname "$PUBLIC_KEY_PATH")"

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required to generate Tesla keys" >&2
  exit 1
fi

# Tesla partner key should be EC P-256 (prime256v1 / secp256r1).
openssl ecparam -name prime256v1 -genkey -noout -out "$PRIVATE_KEY_PATH"
openssl ec -in "$PRIVATE_KEY_PATH" -pubout -out "$PUBLIC_KEY_PATH"

PUBLIC_KEY_BYTES="$(wc -c < "$PUBLIC_KEY_PATH" | tr -d '[:space:]')"
if [[ "$PUBLIC_KEY_BYTES" -gt "$MAX_PUBLIC_KEY_BYTES" ]]; then
  echo "Public key too large: ${PUBLIC_KEY_BYTES} bytes (max ${MAX_PUBLIC_KEY_BYTES})" >&2
  exit 1
fi

echo "Generated private key: $PRIVATE_KEY_PATH"
echo "Generated public key:  $PUBLIC_KEY_PATH"
echo "Public key size:       ${PUBLIC_KEY_BYTES} bytes"
