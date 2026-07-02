#!/bin/sh
set -eu

CERT_DIR="/var/www/virgo-api/app/cert"
KEY_FILE="$CERT_DIR/key.pem"
CERT_FILE="$CERT_DIR/cert.pem"
CSR_FILE="$CERT_DIR/csr.pem"

mkdir -p "$CERT_DIR"

if [ ! -f "$KEY_FILE" ] || [ ! -f "$CERT_FILE" ]; then
  openssl genrsa -out "$KEY_FILE" 4096
  chmod 600 "$KEY_FILE"
  openssl req -new -key "$KEY_FILE" -out "$CSR_FILE" -subj "/CN=virgo/O=univrs.cloud/C=RO"
  openssl x509 -req -days 365 -in "$CSR_FILE" -signkey "$KEY_FILE" -out "$CERT_FILE" -sha256
  chmod 644 "$CERT_FILE"
  rm -f "$CSR_FILE"
fi

exec node index.js
