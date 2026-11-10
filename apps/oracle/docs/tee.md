# The oracle in a TEE

The registry accepts a report only with an ed25519 signature, over SHA-256 of the report's exact JSON, by the one key it trusts (`get_oracle`).
In production that key lives inside an Intel TDX enclave run by OutLayer, so only one specific build of the oracle can produce a report the registry accepts.

## How a run works

1. The oracle service calls `request_execution` on the OutLayer contract with the build pinned by its sha256 (`WasmUrl { url, hash }`).
2. In the enclave, the build (`tee/`) reads the collector's readings and candidate queue from the Tredio API, the registry's live trends through NEAR RPC, and Hyperliquid's marks.
   The endpoints are compiled into the build (`build.sh` prints them), and the caller's input is ignored, so nothing a caller sends can change what the enclave reads.
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

## Status on testnet

- Since 2026-11-10 the registry (`registry.tredio.testnet`) trusts only the enclave's key `ed25519:8qDVQ9AySqUWeWdSJSUfLEpNkxtsrhDUjxyPDGFVWXsk` (`set_oracle` `4hTjCm4NNoHMKqXpwNbow1FQao645KXJjN5ABbNHZ1Qv`), and the oracle service runs every report through OutLayer (`ORACLE_MODE=outlayer`), once a minute.
  Before that it trusted a bootstrap key the team held, `ed25519:3vtthHwFoJBJQ48zkXxCU2Te4hHcDnVhg2zgVuEwebsr`.
- The build is wasm sha256 `434381e425292a8aaaf9edf0d74d27c0d8bfba3ad82794823e27e3959523b9ff`, built from commit `f2424fa` with rustc 1.98.1; the key is bound to that hash.
- The enclave's API token is the OutLayer secret `tredio.testnet/oracle`, bound to that wasm hash and readable only in runs `tredio-oracle.testnet` signs.
- The service's first run after the switch is recorded in `deployments/testnet-proofs.json` (`outlayerRun`): OutLayer run `DPDbwyk9X3uXwTooQUjMqTGp88ySZMbYCeR4HqCneHbV` measured all 12 live trends, and the registry accepted its report in `C3KeBVLXUT1u5wubr2WDjpo3QEUFrDX8P3zS4bW4jsZ5`.

## When OutLayer fails

- A failed run is tried again inside its minute, after 3 and then 10 seconds; OutLayer refunds a run that fails before it executes.
- Runs that still fail raise the oracle's `enclave` alert ("runs failing on OutLayer"), which the status page and the admin console show.
- No other key signs in the meantime: an automatic fallback to a key outside the enclave would let whoever runs the service sign any value whenever it chose to call the enclave "down".
  The index waits for OutLayer instead; series settle late and the Hyperliquid guard refuses orders until marks are fresh again.
- OutLayer caches the build by its hash, so the download URL going away does not stop runs.
- The break-glass is public: the registry owner can move the registry back to the bootstrap key with one `set_oracle` (`bun scripts/switch-oracle-key.ts --rollback`), visible on chain as `oracle_changed`, and forward again with `--send` once OutLayer recovers.

## Verify a report yourself

1. Rebuild the enclave program with `apps/oracle/tee/build.sh`; its sources are the same as at the recorded commit `f2424fa`.
   `apps/oracle/tee/rust-toolchain.toml` pins rustc 1.98.1 with the `wasm32-wasip2` target, and rustup installs it on the first build.
   The script prints the toolchain, the compiled-in endpoints and the sha256, which for the recorded run is `434381e4...`.
2. Fetch OutLayer's attestation of the run: `GET https://testnet-api.outlayer.ai/attestations/by-tx/DPDbwyk9X3uXwTooQUjMqTGp88ySZMbYCeR4HqCneHbV`.
   Its `wasm_hash` and `executed_wasm_sha256` must equal your build's sha256.
   Its `output_hash` is the sha256 of the run's output, recorded as `enclaveOutput`, which holds the enclave key and a report signed with it.
   Check the TDX quote itself with `github.com/out-layer/outlayer-verify`.
3. Check that the registry's `get_oracle` key is that enclave key, and that the registry transaction `C3KeBVLX...` carries the very `report_json` the run printed.
4. For a later report, find the oracle's `submit_report` transaction on NearBlocks and the `request_execution` transaction just before it, and repeat step 2 with that hash.

`pnpm verify --build` runs steps 1 to 3: it fails unless your build's sha256 equals the attested one, checks the recorded output against the attestation and its signature against the key, checks that the registry accepted that report, and says which key the registry trusts.

## Cost

A run costs about 0.0013 NEAR in OutLayer fees plus gas for the two transactions, about 2.5 NEAR a day at one run a minute.
