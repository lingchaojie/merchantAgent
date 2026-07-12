#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tls_dir="${script_dir}/tls"

rm -rf "${tls_dir}"
mkdir -p "${tls_dir}"

openssl genrsa -out "${tls_dir}/ca.key" 3072
openssl req -x509 -new -sha256 -days 30 \
  -key "${tls_dir}/ca.key" \
  -out "${tls_dir}/ca.crt" \
  -subj "/CN=merchantAgent SQL Server Test CA"

openssl genrsa -out "${tls_dir}/server.key" 2048
openssl req -new -sha256 \
  -key "${tls_dir}/server.key" \
  -out "${tls_dir}/server.csr" \
  -subj "/CN=localhost"

cat > "${tls_dir}/server.ext" <<'EOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,IP:127.0.0.1
EOF

openssl x509 -req -sha256 -days 30 \
  -in "${tls_dir}/server.csr" \
  -CA "${tls_dir}/ca.crt" \
  -CAkey "${tls_dir}/ca.key" \
  -CAcreateserial \
  -out "${tls_dir}/server.crt" \
  -extfile "${tls_dir}/server.ext"

rm -f "${tls_dir}/server.csr" "${tls_dir}/server.ext" "${tls_dir}/ca.srl"
chmod 644 "${tls_dir}/ca.crt" "${tls_dir}/server.crt" "${tls_dir}/server.key"
