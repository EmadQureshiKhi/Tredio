/**
 * Where the Tredio contracts live on each network: deployments/<network>.json, written by
 * contracts/scripts/deploy.sh. Mainnet's file is the plan until that script deploys it
 * (`status: "planned"`): the same ids and parameters the deploy will use, so every service and
 * the app switch networks with NEAR_NETWORK alone.
 */
import mainnet from "../../../deployments/mainnet.json" with { type: "json" };
import testnet from "../../../deployments/testnet.json" with { type: "json" };

export type Network = "testnet" | "mainnet";

export interface Deployment {
  network: Network;
  /** `planned` until the deploy script has run on this network; a missing status means live. */
  status?: "planned" | "live";
  rpc: string;
  deployedAt: string | null;
  /** The block before the first contract account was created, where the indexer starts. */
  startBlock?: number | null;
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
   * exist); `accountV2` and `accountV3`, once published, are the versions they upgrade to with their
   * passkey (the newest one named is the one offered).
   */
  globalCode: { coin: string; account: string; accountV2?: string; accountV3?: string };
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

const DEPLOYMENTS: Record<Network, Deployment> = { testnet: testnet as Deployment, mainnet: mainnet as Deployment };

/** Native USDC on NEAR mainnet (Circle), used instead of the testnet token. */
export const MAINNET_USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

/** True once the contracts are deployed on `network`. */
export const isDeployed = (network: Network): boolean => DEPLOYMENTS[network].status !== "planned";

/** The planned or live deployment, for tools that prepare a deploy (never for trading). */
export const deploymentPlan = (network: Network): Deployment => DEPLOYMENTS[network];

export function deployment(network: Network = "testnet"): Deployment {
  const d = DEPLOYMENTS[network];
  if (!isDeployed(network)) {
    throw new Error(`Tredio is not deployed on ${network} yet: deployments/${network}.json is the plan, and contracts/scripts/deploy.sh ${network} writes the live deployment`);
  }
  // #mainnet: Tredio settles in Circle's native USDC, never a token of its own.
  if (network === "mainnet" && d.contracts.usdc !== MAINNET_USDC) throw new Error(`deployments/mainnet.json names ${d.contracts.usdc} as USDC, not native USDC`);
  return d;
}

export const EXPLORERS: Record<Network, string> = {
  testnet: "https://testnet.nearblocks.io",
  mainnet: "https://nearblocks.io",
};

export const explorerTx = (network: Network, hash: string) => `${EXPLORERS[network]}/txns/${hash}`;
export const explorerAccount = (network: Network, account: string) => `${EXPLORERS[network]}/address/${account}`;
