import { DEFAULT_RPCS, publicKeyOf } from "@tredio/chain";
import { type Deployment, deployment as deploymentOf } from "@tredio/contracts";
import { z } from "zod";

const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const optional = <T extends z.ZodType>(inner: T) => z.preprocess((v) => (v === "" ? undefined : v), inner.optional());
const near = (v: string) => BigInt(Math.round(Number(v) * 1e6)) * 10n ** 18n;
const nearAmount = z.string().regex(/^\d+(\.\d{1,6})?$/).transform(near);

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(4400),
  NEAR_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  NEAR_RPC_URLS: optional(z.string()),
  DEPLOYMENT_JSON: optional(z.string()),
  /** The backend's database: the executor reads and writes its Autopilot tables (the backend owns the schema). */
  DATABASE_URL: z.string().min(1),
  /** The relayer, which tops up session gas keys (`POST /v1/sessions/fund`). */
  RELAYER_URL: z.string().url().default("http://localhost:4100"),
  /** Opens the grants the app sealed to this executor (base64url PKCS#8 P-256). Without it, only the bot trades. */
  AUTOPILOT_SEAL_PRIVATE_KEY: optional(z.string().regex(/^[A-Za-z0-9_-]{100,400}$/, "a base64url PKCS#8 key")),
  /** The Tredio bot: its own Tredio account, and the secret of that account's Autopilot session key. */
  AUTOPILOT_BOT_ACCOUNT: optional(z.string().regex(/^[a-z0-9._-]{2,64}$/)),
  AUTOPILOT_BOT_SESSION_KEY: optional(z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,90}$/, "an ed25519:<base58> secret key")),
  TICK_SEC: z.coerce.number().int().min(5).default(15),
  /**
   * Worst fill accepted, basis points from the mark. At most 1%: the account's order guard refuses
   * session orders more than 2% from Tredio's mark, which can be up to two minutes old (five on v2 account code).
   */
  SLIPPAGE_BPS: z.coerce.number().int().min(5).max(100).default(50),
  /** Pause a rule after this many failed orders in a row. */
  MAX_CONSECUTIVE_FAILURES: z.coerce.number().int().positive().default(3),
  /** How old a Nansen smart-money reading may be and still count. */
  NETFLOW_MAX_AGE_SEC: z.coerce.number().int().positive().default(12 * 3600),
  /** Hyperliquid's base taker fee, charged in the books when a fill's own fee is not visible yet. */
  HL_TAKER_FEE_BPS: z.coerce.number().nonnegative().default(4.5),
  /** Ask the relayer to top up a session gas key below this (its own minimum). */
  SESSION_GAS_MIN_NEAR: nearAmount.default(near("0.31")),
  /** Any value halts openings from the environment, on top of the admin kill switch. */
  KILL_SWITCH: optional(z.string()),
});

export type Config = z.infer<typeof schema> & {
  deployment: Deployment;
  rpcUrls: string[];
  bot: { account: string; secretKey: string; sessionKey: string } | null;
};

export function loadConfig(env: Record<string, string | undefined>): Config {
  const c = schema.parse(env);
  const deployment = c.DEPLOYMENT_JSON ? (JSON.parse(c.DEPLOYMENT_JSON) as Deployment) : deploymentOf(c.NEAR_NETWORK);
  const rpcUrls = list(c.NEAR_RPC_URLS).length > 0 ? list(c.NEAR_RPC_URLS) : DEFAULT_RPCS[c.NEAR_NETWORK];
  if (Boolean(c.AUTOPILOT_BOT_ACCOUNT) !== Boolean(c.AUTOPILOT_BOT_SESSION_KEY)) throw new Error("set AUTOPILOT_BOT_ACCOUNT and AUTOPILOT_BOT_SESSION_KEY together");
  const bot = c.AUTOPILOT_BOT_ACCOUNT && c.AUTOPILOT_BOT_SESSION_KEY ? { account: c.AUTOPILOT_BOT_ACCOUNT, secretKey: c.AUTOPILOT_BOT_SESSION_KEY, sessionKey: publicKeyOf(c.AUTOPILOT_BOT_SESSION_KEY) } : null;
  return { ...c, deployment, rpcUrls, bot };
}
