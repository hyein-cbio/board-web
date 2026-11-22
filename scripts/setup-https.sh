#!/bin/sh
# Makes a certificate for https://localhost and trusts it for this macOS user,
# so Board Web can answer https on its port. Only localhost, 127.0.0.1 and ::1
# are in it, and it can sign nothing else. Run again with --force for a new one.
set -eu

dir="${BOARD_WEB_TLS_DIR:-$HOME/.config/board-web/tls}"
cert="$dir/localhost.crt"
key="$dir/localhost.key"
name="Board Web (localhost)"
keychain="$HOME/Library/Keychains/login.keychain-db"
days=825 # the longest macOS accepts for a TLS server certificate

mkdir -p "$dir"
chmod 700 "$dir"
if [ ! -f "$cert" ] || [ ! -f "$key" ] || [ "${1:-}" = "--force" ]; then
  if [ "$(uname)" = "Darwin" ]; then
    security find-certificate -a -c "$name" -Z "$keychain" 2>/dev/null |
      awk '/^SHA-1 hash:/ { print $3 }' |
      while read -r hash; do security delete-certificate -Z "$hash" "$keychain" >/dev/null; done
  fi
  (
    umask 077
    openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days "$days" \
      -subj "/CN=$name" \
      -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1" \
      -addext "basicConstraints=critical,CA:FALSE" \
      -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
      -addext "extendedKeyUsage=serverAuth" \
      -keyout "$key" -out "$cert" >/dev/null 2>&1
  )
  echo "Made $cert"
fi

if [ "$(uname)" = "Darwin" ]; then
  echo "macOS will ask for your password to trust it (Keychain: login)."
  security add-trusted-cert -r trustRoot -p ssl -k "$keychain" "$cert"
  security verify-cert -c "$cert" -p ssl -s localhost >/dev/null 2>&1 && echo "Trusted for https://localhost"
else
  echo "Trust $cert in your browser or system store, then restart Board Web."
fi
