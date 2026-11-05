#!/usr/bin/env bash
# Builds the oracle's enclave program and prints its sha256, the hash the registry's key is bound to.
# Paths are remapped so the same source and toolchain give the same bytes on any machine.
set -euo pipefail
cd "$(dirname "$0")"
export TREDIO_BACKEND_URL="${TREDIO_BACKEND_URL:-https://api.tredio.bid}"
export TREDIO_RPC_URL="${TREDIO_RPC_URL:-https://test.rpc.fastnear.com}"
export TREDIO_REGISTRY="${TREDIO_REGISTRY:-registry.tredio.testnet}"
export TREDIO_HYPERLIQUID_URL="${TREDIO_HYPERLIQUID_URL:-https://api.hyperliquid-testnet.xyz}"
RUSTFLAGS="--remap-path-prefix=$(pwd)=/build --remap-path-prefix=$HOME/.cargo=/cargo" cargo build --locked --target wasm32-wasip2 --release
shasum -a 256 target/wasm32-wasip2/release/tredio-oracle-tee.wasm
