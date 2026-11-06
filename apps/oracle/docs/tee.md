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

- The registry (`registry.tredio.testnet`) still trusts the bootstrap key `ed25519:3vtthHwFoJBJQ48zkXxCU2Te4hHcDnVhg2zgVuEwebsr`, and the oracle service signs with it (`ORACLE_MODE=local`).
- The enclave cannot do the job yet: the API compiled into the build, `https://api.tredio.bid`, is not hosted, so a run gets no readings or candidates and its report carries only Hyperliquid marks.
- One run of the build is recorded in `deployments/testnet-proofs.json` (`outlayerRun`): tx `4WKiUBZ38SWfwT1ptEeHJNvWNX1ywRCK31Pa9gZp39D6`, wasm sha256 `434381e425292a8aaaf9edf0d74d27c0d8bfba3ad82794823e27e3959523b9ff`, built from commit `f2424fa` with rustc 1.98.1.
- The key OutLayer holds for that build, which signed that run's report, is `ed25519:8qDVQ9AySqUWeWdSJSUfLEpNkxtsrhDUjxyPDGFVWXsk`.
- The key is bound to the wasm hash, and the build already points at `https://api.tredio.bid`, so hosting the API needs no rebuild and keeps that key.
- Once the API answers and its token is stored as the build's OutLayer secret, the switch is one `set_oracle` transaction by the registry owner (`{"tee_signer": {"public_key": "ed25519:8qDV..."}}`), then `ORACLE_MODE=outlayer` on the service.
- `pnpm verify` prints which of the two keys the registry trusts.

## Verify a report yourself

1. Rebuild the enclave program with `apps/oracle/tee/build.sh`; its sources are the same as at the recorded commit `f2424fa`.
   `apps/oracle/tee/rust-toolchain.toml` pins rustc 1.98.1 with the `wasm32-wasip2` target, and rustup installs it on the first build.
   The script prints the toolchain, the compiled-in endpoints and the sha256, which for the recorded run is `434381e4...`.
2. Fetch OutLayer's attestation of the run: `GET https://testnet-api.outlayer.ai/attestations/by-tx/4WKiUBZ38SWfwT1ptEeHJNvWNX1ywRCK31Pa9gZp39D6`.
   Its `wasm_hash` and `executed_wasm_sha256` must equal your build's sha256.
   Its `output_hash` is the sha256 of the run's output, recorded as `enclaveOutput`, which holds the enclave key and a report signed with it.
   Check the TDX quote itself with `github.com/out-layer/outlayer-verify`.
3. Check whether the registry's `get_oracle` key is that enclave key; on testnet it is still the bootstrap key (see above).
4. For a later report, find the oracle's `submit_report` transaction on NearBlocks and the `request_execution` transaction just before it, and repeat step 2 with that hash.

`pnpm verify --build` runs steps 1 to 3: it fails unless your build's sha256 equals the attested one, checks the recorded output against the attestation and its signature against the key, and says which key the registry trusts.

## Cost

A run costs about 0.0013 NEAR in OutLayer fees plus gas for the two transactions, about 2.5 NEAR a day at one run a minute.
