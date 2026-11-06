import { Sender, Viewer } from "@tredio/chain";
import { loadConfig } from "./config";
import { Relayer } from "./relayer";
import { createServer } from "./server";

const cfg = loadConfig(process.env);
const viewer = new Viewer(cfg.NEAR_NETWORK, cfg.rpcUrls);
const sender = new Sender({ network: cfg.NEAR_NETWORK, accountId: cfg.RELAYER_ACCOUNT_ID, privateKey: cfg.RELAYER_PRIVATE_KEY, gasKeyLanes: cfg.RELAYER_GAS_KEY_LANES, rpcUrls: cfg.rpcUrls });
const relayer = new Relayer({
  sender,
  viewer,
  deployment: cfg.deployment,
  ticketSigner: cfg.ACTIVATION_TICKET_SIGNER ?? null,
  createDeposit: cfg.CREATE_DEPOSIT_NEAR,
  sessionGasTarget: cfg.SESSION_GAS_TARGET_NEAR,
  sessionGasMin: cfg.SESSION_GAS_MIN_NEAR,
  sessionStorageMin: cfg.SESSION_STORAGE_MIN_NEAR,
  sessionStorageTarget: cfg.SESSION_STORAGE_TARGET_NEAR,
  limits: {
    accountsPerHour: cfg.ACCOUNTS_PER_HOUR,
    accountsPerDay: cfg.ACCOUNTS_PER_DAY,
    ownerCallsPerAccountPerHour: cfg.OWNER_CALLS_PER_ACCOUNT_PER_HOUR,
    topupsPerSessionPerDay: cfg.TOPUPS_PER_SESSION_PER_DAY,
    topupsPerAccountPerDay: cfg.TOPUPS_PER_ACCOUNT_PER_DAY,
    storageTopupsPerAccountPerDay: cfg.STORAGE_TOPUPS_PER_ACCOUNT_PER_DAY,
    metaPerAccountPerHour: cfg.META_TX_PER_ACCOUNT_PER_HOUR,
    nearPerHour: cfg.NEAR_PER_HOUR,
  },
});
const app = createServer({ relayer, sender, viewer, network: cfg.NEAR_NETWORK, origins: cfg.origins, minBalance: cfg.MIN_BALANCE_NEAR, startedAt: Date.now() });
const server = Bun.serve({ port: cfg.PORT, fetch: app.fetch });
console.log(JSON.stringify({ msg: "relayer listening", port: server.port, network: cfg.NEAR_NETWORK, account: sender.accountId, key: sender.publicKey, gasKeyLanes: cfg.RELAYER_GAS_KEY_LANES, tickets: Boolean(cfg.ACTIVATION_TICKET_SIGNER) }));
