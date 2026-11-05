# The oracle in a TEE

The registry accepts a report only with an ed25519 signature, over SHA-256 of the report's exact JSON, by the one key it trusts (`get_oracle`).
In production that key lives inside an Intel TDX enclave run by OutLayer, so only one specific build of the oracle can produce a report the registry accepts.

## How a run works

1. The oracle service calls `request_execution` on the OutLayer contract with the build pinned by its sha256 (`WasmUrl { url, hash }`).
2. In the enclave, the build (`tee/`) reads the collector's readings and candidate queue from the Tredio API, the registry's live trends through NEAR RPC, and Hyperliquid's marks.
   The endpoints are compiled into the build, and the caller's input is ignored, so nothing a caller sends can change what the enclave reads.
3. It applies the index method (`docs/index-method.md`) and signs the report with a signing key OutLayer derives inside its keystore for exactly this build (`signing_keys`, `caller: "none"`, `bind: "wasm"`).
   Nobody, including Tredio, ever sees that key.
4. The service submits the signed report to the registry, which checks the signature against the key it trusts.

The API token the enclave uses is an OutLayer secret that only this build can decrypt.

## What this proves, and what it does not

- Proven: every accepted index value was computed by the published build, with the published method, from what the Tredio API, the registry and Hyperliquid returned at that moment.
- Proven: the code that ran is the build with that sha256; OutLayer attests each run with a TDX quote over the wasm hash, input and output.
- Not proven: that the collector's readings are what the original sources said; the collector runs on Tredio's server.
  Moving the keyed sources (Elfa, Nansen) into the enclave with OutLayer secrets would close that gap, at the cost of each run calling every source.
- Changing the code means a new build, a new key, and a `set_oracle` transaction by the registry owner, visible to anyone on chain.

## Verify a report yourself

1. Find the oracle's `submit_report` transaction on NearBlocks, and the `request_execution` transaction just before it.
2. Fetch OutLayer's attestation of that run: `GET https://testnet-api.outlayer.ai/attestations/by-tx/<request_execution tx hash>`; check its `wasm_hash` against the build and verify the quote with `github.com/out-layer/outlayer-verify`.
3. Rebuild the enclave program yourself (`tee/build.sh`) and compare the sha256.
4. Check that the registry's `get_oracle` key is the key that build printed in its output.

## Cost

A run costs about 0.0013 NEAR in OutLayer fees plus gas for the two transactions, about 2.5 NEAR a day at one run a minute.
