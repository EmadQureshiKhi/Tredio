/**
 * On-chain checks behind the API's proofs (the proofs themselves are verified by @tredio/chain):
 * which keys an account holds, with what permission.
 */

export { base58Decode, base58Encode, nep413Hash, ownerKeyHex, type Nep413Proof, type PasskeyAssertion, verifyNep413Signature, verifyPasskey } from "@tredio/chain";

export type KeyPermission =
  | { kind: "full" }
  | { kind: "function_call"; receiverId: string; methodNames: string[]; gasKey: boolean };

/** Reads an account's access key over RPC: its permission, or null when the account does not hold it. */
export type AccessKeyReader = (accountId: string, publicKey: string) => Promise<KeyPermission | null>;

type RpcCall = <T>(method: string, params: unknown) => Promise<T>;

export function accessKeyReader(rpc: RpcCall): AccessKeyReader {
  return async (accountId, publicKey) => {
    let r: { permission: unknown };
    try {
      r = await rpc<{ permission: unknown }>("query", { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey });
    } catch (e) {
      if (/UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT|does not exist/i.test(String((e as Error).message))) return null;
      throw e;
    }
    const perm = r.permission;
    if (perm === "FullAccess" || (typeof perm === "object" && perm !== null && "GasKeyFullAccess" in perm)) return { kind: "full" };
    const fc = (perm as Record<string, { receiver_id: string; method_names: string[] }>)?.FunctionCall ??
      (perm as Record<string, { receiver_id: string; method_names: string[] }>)?.GasKeyFunctionCall;
    if (fc) return { kind: "function_call", receiverId: fc.receiver_id, methodNames: fc.method_names, gasKey: "GasKeyFunctionCall" in (perm as object) };
    return null;
  };
}

