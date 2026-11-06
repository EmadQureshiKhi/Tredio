#!/usr/bin/env bash
# Builds the oracle's enclave program and prints its sha256, the hash the registry's key is bound to.
# rust-toolchain.toml pins the compiler and paths are remapped, so the same commit gives the same bytes on any machine.
# The endpoints are compiled in and covered by the hash: change one and you build a different program.
# So is every source line, even reformatting: panic locations carry line numbers into the wasm.
set -euo pipefail
cd "$(dirname "$0")"
# NEAR_NETWORK picks the defaults (testnet unless set): a mainnet build is a different program with its own hash.
case "${NEAR_NETWORK:-testnet}" in
  testnet) rpc=https://test.rpc.fastnear.com hyperliquid=https://api.hyperliquid-testnet.xyz ;;
  mainnet) rpc=https://rpc.mainnet.fastnear.com hyperliquid=https://api.hyperliquid.xyz ;; # #mainnet
  *) echo "NEAR_NETWORK must be testnet or mainnet" >&2; exit 1 ;;
esac
registry="$(sed -n 's/^ *"registry": "\(.*\)",*$/\1/p' "../../../deployments/${NEAR_NETWORK:-testnet}.json")"
export TREDIO_BACKEND_URL="${TREDIO_BACKEND_URL:-https://api.tredio.bid}"
export TREDIO_RPC_URL="${TREDIO_RPC_URL:-$rpc}"
export TREDIO_REGISTRY="${TREDIO_REGISTRY:-$registry}"
export TREDIO_HYPERLIQUID_URL="${TREDIO_HYPERLIQUID_URL:-$hyperliquid}"
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
