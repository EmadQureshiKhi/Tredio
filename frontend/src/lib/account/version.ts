import { useQuery } from "@tanstack/react-query";
import { AccountVersions, type AccountVersion } from "@tredio/contracts";
import { view } from "@/lib/chain/client";

/**
 * Which account code a passkey account runs: v1 (testnet's accounts today, no `version` view) or
 * v2. Read once per account and shared by the session sender, the tickets and Settings; anything
 * uncertain reads as v1, which is safe on v2 too.
 */
export const accountVersions = new AccountVersions((account) => view<number>(account, "version"));

export const accountVersion = (account: string): Promise<AccountVersion> => accountVersions.of(account);

/** The account's code version, or undefined while it is read. */
export function useAccountVersion(account: string | null | undefined) {
  return useQuery({ queryKey: ["account-version", account], enabled: Boolean(account), queryFn: () => accountVersion(account!), staleTime: 600_000 });
}
