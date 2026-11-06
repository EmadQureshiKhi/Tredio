#!/usr/bin/env bash
# Builds the oracle's enclave program and prints its sha256, the hash the registry's key is bound to.
# rust-toolchain.toml pins the compiler and paths are remapped, so the same commit gives the same bytes on any machine.
# The endpoints are compiled in and covered by the hash: change one and you build a different program.
# So is every source line, even reformatting: panic locations carry line numbers into the wasm.
set -euo pipefail
cd "$(dirname "$0")"
export TREDIO_BACKEND_URL="${TREDIO_BACKEND_URL:-https://api.tredio.bid}"
export TREDIO_RPC_URL="${TREDIO_RPC_URL:-https://test.rpc.fastnear.com}"
export TREDIO_REGISTRY="${TREDIO_REGISTRY:-registry.tredio.testnet}"
export TREDIO_HYPERLIQUID_URL="${TREDIO_HYPERLIQUID_URL:-https://api.hyperliquid-testnet.xyz}"
# Nothing from the caller's environment may pick another toolchain, flags or output directory.
unset RUSTUP_TOOLCHAIN CARGO_TARGET_DIR CARGO_ENCODED_RUSTFLAGS CARGO_BUILD_RUSTFLAGS
pinned="$(sed -n 's/^channel = "\(.*\)"$/\1/p' rust-toolchain.toml)"
if command -v rustup >/dev/null; then rustup toolchain install --no-self-update >/dev/null; fi
rustc_version="$(rustc -V)"
case "$rustc_version" in
  "rustc $pinned "*) ;;
  *) echo "warning: rust-toolchain.toml pins $pinned but this is $rustc_version; the hash will not match the attested build" >&2 ;;
esac
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
RUSTFLAGS="--remap-path-prefix=$(pwd)=/build --remap-path-prefix=$cargo_home=/cargo" cargo build --locked --target wasm32-wasip2 --release
echo "toolchain: $rustc_version, $(cargo -V), target wasm32-wasip2"
echo "TREDIO_BACKEND_URL=$TREDIO_BACKEND_URL"
echo "TREDIO_RPC_URL=$TREDIO_RPC_URL"
echo "TREDIO_REGISTRY=$TREDIO_REGISTRY"
echo "TREDIO_HYPERLIQUID_URL=$TREDIO_HYPERLIQUID_URL"
shasum -a 256 target/wasm32-wasip2/release/tredio-oracle-tee.wasm
