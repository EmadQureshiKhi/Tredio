#!/usr/bin/env bash
# Builds every contract to wasm under contracts/target/near/<crate>/<crate>.wasm.
set -euo pipefail
cd "$(dirname "$0")/.."
for c in usdc registry outcomes book perps curation coin coins account accounts tests/publisher; do
  (cd "$c" && cargo near build non-reproducible-wasm --no-abi --locked >/dev/null 2>&1) || {
    echo "build failed: $c" >&2
    (cd "$c" && cargo near build non-reproducible-wasm --no-abi --locked)
    exit 1
  }
  echo "built $c"
done
ls -la target/near/*/*.wasm | awk '{print $5, $9}'
