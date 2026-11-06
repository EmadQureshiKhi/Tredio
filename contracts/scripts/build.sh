#!/usr/bin/env bash
# Builds every contract to wasm.
#
#   scripts/build.sh                        with the local toolchain, to target/near/<crate>/<crate>.wasm:
#                                           fast, and byte for byte the same only with the rustc and
#                                           cargo-near versions SECURITY.md records
#   scripts/build.sh --reproducible [rev]   in SourceScan's pinned Docker image (each crate's
#                                           [package.metadata.near.reproducible_build]) from commit
#                                           `rev` (HEAD), to target/near-reproducible/<commit>/<crate>.wasm;
#                                           the wasm records the repository and the commit (NEP-330), so
#                                           NearBlocks verifies it from the public source. #mainnet deploys use these.
#
# A reproducible build checks the commit out in a temporary git worktree, so uncommitted changes
# never reach it and the local build in target/near stays as it is. It needs Docker.
set -euo pipefail
cd "$(dirname "$0")/.."

DEPLOYABLE=(usdc registry outcomes book perps curation coin coins account accounts)

build() { # crate dir
  (cd "$1" && cargo near build non-reproducible-wasm --no-abi --locked >/dev/null 2>&1) || {
    echo "build failed: $1" >&2
    (cd "$1" && cargo near build non-reproducible-wasm --no-abi --locked)
    exit 1
  }
  echo "built $1"
}

case "${1:-}" in
  "")
    for c in "${DEPLOYABLE[@]}" tests/publisher; do build "$c"; done
    ls -la target/near/*/*.wasm | awk '{print $5, $9}'
    ;;
  --reproducible)
    rev=$(git rev-parse "${2:-HEAD}^{commit}")
    out="target/near-reproducible/$rev"
    tree=$(mktemp -d "${TMPDIR:-/tmp}/tredio-build.XXXXXX")
    git worktree add --detach "$tree" "$rev" >/dev/null
    trap 'git worktree remove --force "$tree" >/dev/null 2>&1 || true' EXIT
    mkdir -p "$out"
    for c in "${DEPLOYABLE[@]}"; do
      # cargo-near takes the build command (and its --no-abi) from the manifest's container_build_command.
      (cd "$tree/contracts/$c" && cargo near build reproducible-wasm >"$tree/build-$c.log" 2>&1) || {
        echo "build failed: $c" >&2
        tail -40 "$tree/build-$c.log" >&2
        exit 1
      }
      cp "$tree/contracts/target/near/tredio_$c/tredio_$c.wasm" "$out/"
      echo "built $c at ${rev:0:12}"
    done
    ls -la "$out"/*.wasm | awk '{print $5, $9}'
    ;;
  *) echo "usage: scripts/build.sh [--reproducible [rev]]" >&2; exit 1 ;;
esac
