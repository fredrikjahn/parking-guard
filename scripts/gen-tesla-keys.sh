#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRIVATE_KEY_PATH="$ROOT_DIR/tesla-private-key.pem"
PUBLIC_KEY_PATH="$ROOT_DIR/public/.well-known/appspecific/com.tesla.3p.public-key.pem"

mkdir -p "$(dirname "$PUBLIC_KEY_PATH")"

if command -v openssl >/dev/null 2>&1; then
  openssl genrsa -out "$PRIVATE_KEY_PATH" 2048
  openssl rsa -in "$PRIVATE_KEY_PATH" -pubout -out "$PUBLIC_KEY_PATH"
else
  node - "$PRIVATE_KEY_PATH" "$PUBLIC_KEY_PATH" <<'NODE'
const { generateKeyPairSync } = require('node:crypto');
const { writeFileSync, mkdirSync } = require('node:fs');
const { dirname } = require('node:path');

const privatePath = process.argv[2];
const publicPath = process.argv[3];

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: {
    type: 'spki',
    format: 'pem',
  },
  privateKeyEncoding: {
    type: 'pkcs8',
    format: 'pem',
  },
});

mkdirSync(dirname(publicPath), { recursive: true });
writeFileSync(privatePath, privateKey, { encoding: 'utf8' });
writeFileSync(publicPath, publicKey, { encoding: 'utf8' });
NODE
fi

echo "Generated private key: $PRIVATE_KEY_PATH"
echo "Generated public key:  $PUBLIC_KEY_PATH"
