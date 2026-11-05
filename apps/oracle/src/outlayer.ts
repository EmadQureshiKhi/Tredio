import { returnValue, type Sender, type Viewer } from "@tredio/chain";

/**
 * Runs the oracle inside an OutLayer TEE (apps/oracle/tee): `request_execution` on the OutLayer
 * contract with the exact build pinned by its sha256, then the enclave's output. The enclave
 * reads the collector, the registry and Hyperliquid itself, computes the report and signs it with
 * a key bound to that build, so the registry (which trusts only that key) accepts only reports
 * this build computed. Each run is also attested by OutLayer (Intel TDX quote with the wasm hash,
 * input and output hashes): GET <api>/attestations/by-tx/<tx hash>.
 */

export interface EnclaveOutput {
  report_json: string | null;
  signature?: string;
  public_key?: string;
  observed_at?: number;
  warnings?: string[];
  error?: string;
}

export interface OutLayerOptions {
  contract: string;
  wasmUrl: string;
  /** sha256 of the build, lowercase hex: the request pins it, so no other code can run. */
  wasmHash: string;
  maxSeconds: number;
  /** Where the enclave's secrets live (the API token), as OutLayer's `secrets_ref`. */
  secrets: { profile: string; account_id: string } | null;
}

export class OutLayerRunner {
  constructor(
    private readonly sender: Sender,
    private readonly viewer: Viewer,
    private readonly o: OutLayerOptions,
  ) {}

  async run(): Promise<{ output: EnclaveOutput; tx: string | null }> {
    const limits = { max_instructions: 20_000_000_000, max_memory_mb: 256, max_execution_seconds: this.o.maxSeconds };
    const deposit = await this.viewer.view<string>(this.o.contract, "estimate_execution_cost", { resource_limits: limits });
    const outcome = await this.sender.sendOutcome({
      receiverId: this.o.contract,
      methodName: "request_execution",
      args: {
        source: { WasmUrl: { url: this.o.wasmUrl, hash: this.o.wasmHash, build_target: "wasm32-wasip2" } },
        resource_limits: limits,
        input_data: "{}",
        secrets_ref: this.o.secrets,
        response_format: "Json",
        payer_account_id: null,
        params: null,
      },
      deposit,
      gas: (300n * 10n ** 12n).toString(),
    });
    const output = returnValue<EnclaveOutput | null>(outcome);
    if (!output) {
      const failure = outcome.receipts_outcome?.flatMap((r) => r.outcome.logs).find((l) => l.startsWith("Execution failed")) ?? "the enclave returned nothing";
      return { output: { report_json: null, error: failure.slice(0, 300) }, tx: outcome.transaction?.hash ?? null };
    }
    return { output, tx: outcome.transaction?.hash ?? null };
  }
}
