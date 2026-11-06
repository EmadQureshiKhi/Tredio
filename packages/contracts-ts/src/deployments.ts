/**
 * Where the Tredio contracts live on each network. Testnet comes from deployments/testnet.json,
 * written by contracts/scripts/deploy-testnet.sh.
 */
import testnet from "../../../deployments/testnet.json" with { type: "json" };

export type Network = "testnet" | "mainnet";

export interface Deployment {
  network: Network;
  rpc: string;
  deployedAt: string;
  root: string;
  treasury: string;
  contracts: {
    usdc: string;
    registry: string;
    outcomes: string;
    book: string;
    perps: string;
    curation: string;
    coins: string;
    accounts: string;
  };
  external: { exchange: string; chainSignatures: string };
  /**
   * Global contract code hashes. `account` is the code accounts are born on (fixed once accounts
   * exist); `accountV2`, once published, is the code they upgrade to with their passkey.
   */
  globalCode: { coin: string; account: string; accountV2?: string };
  oracle: { mode: string; publicKey: string };
  params: {
    usdcDecimals: number;
    indexDecimals: number;
    coinDecimals: number;
    outcomeTestWindow: number;
    bookTakerFeeBps: number;
    maxOpenInterestPerSide: string;
    curveBaseVirtualQuote: string;
    curveGraduationReserve: string;
  };
}

const DEPLOYMENTS: Partial<Record<Network, Deployment>> = { testnet: testnet as Deployment };

/** Native USDC on NEAR mainnet (Circle), used instead of the testnet token. */
export const MAINNET_USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

export function deployment(network: Network = "testnet"): Deployment {
  const d = DEPLOYMENTS[network];
  if (!d) throw new Error(`no Tredio deployment on ${network} yet`);
  return d;
}

export const EXPLORERS: Record<Network, string> = {
  testnet: "https://testnet.nearblocks.io",
  mainnet: "https://nearblocks.io",
};

export const explorerTx = (network: Network, hash: string) => `${EXPLORERS[network]}/txns/${hash}`;
export const explorerAccount = (network: Network, account: string) => `${EXPLORERS[network]}/address/${account}`;
