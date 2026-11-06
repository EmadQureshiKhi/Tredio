import type { Block, ReceiptOutcome } from "../../src/neardata";

/** Which transaction a receipt belongs to and who signed it; default: its own, signed by its executor. */
export type Grouping = (height: number, r: ReceiptOutcome) => { tx: string; signer?: string } | undefined;

interface FakeReceipt {
  id: string;
  height: number;
  time: string;
  index: number;
  executor: string;
  logs: string[];
  status: unknown;
}

interface FakeTx {
  hash: string;
  signer: string;
  receipts: FakeReceipt[];
}

/**
 * A FastNEAR transactions API stand-in serving the receipts of neardata-shaped `blocks`, as the
 * real one would at head `tip()`: a transaction shows up once included, with only the receipts
 * executed by then, and in an account's listing once a receipt touched the account (or the
 * account signed it). Block times go out as bare JSON integers, as the real API sends them.
 */
export function fakeTxApi(blocks: Map<number, Block | null>, tip: () => number, opts: { group?: Grouping; extraHeights?: number[] } = {}) {
  const produced: Array<{ height: number; time: string }> = [];
  const txs = new Map<string, FakeTx>();
  const heights = [...blocks.keys()].sort((a, b) => a - b);
  let lastTime = 0n;
  for (const h of heights) {
    const b = blocks.get(h);
    if (!b) continue;
    const time = b.block.header.timestamp_nanosec!;
    lastTime = BigInt(time);
    produced.push({ height: h, time });
    let index = 0;
    for (const shard of b.shards) {
      for (const r of shard.receipt_execution_outcomes) {
        const id = r.receipt?.receipt_id ?? r.execution_outcome.id;
        const g = opts.group?.(h, r);
        const hash = g?.tx ?? r.tx_hash ?? `TX-${id}`;
        const tx = txs.get(hash) ?? { hash, signer: g?.signer ?? r.execution_outcome.outcome.executor_id, receipts: [] };
        tx.receipts.push({
          id,
          height: h,
          time,
          index: index++,
          executor: r.execution_outcome.outcome.executor_id,
          logs: r.execution_outcome.outcome.logs,
          status: r.execution_outcome.outcome.status,
        });
        txs.set(hash, tx);
      }
    }
  }
  for (const h of opts.extraHeights ?? []) {
    lastTime += 1_000_000_000n;
    produced.push({ height: h, time: lastTime.toString() });
  }
  const included = (tx: FakeTx) => tx.receipts[0]!.height;
  const order = [...txs.values()].sort((a, b) => included(a) - included(b));
  const touched = (tx: FakeTx, account: string, head: number) =>
    tx.signer === account || tx.receipts.some((r) => r.height <= head && r.executor === account);

  const paths: string[] = [];
  /** Every hash asked of `/v0/transactions`, in order. */
  const requested: string[] = [];
  const out = (body: unknown) =>
    new Response(JSON.stringify(body).replace(/"block_timestamp":"(\d+)"/g, '"block_timestamp":$1'), { headers: { "content-type": "application/json" } });

  const outcome = (r: FakeReceipt, next: string[]) => ({
    id: r.id,
    block_height: r.height,
    block_hash: `H${r.height}`,
    block_timestamp: r.time,
    index: r.index,
    outcome: { executor_id: r.executor, logs: r.logs, status: r.status, receipt_ids: next, gas_burnt: 1, tokens_burnt: "0" },
  });

  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    const body = JSON.parse(String(init?.body ?? "{}"));
    const head = tip();
    if (url.pathname === "/v0/blocks") {
      const to = Math.min(head, body.to_block_height ?? Infinity);
      const list = produced.filter((b) => b.height <= to).reverse().slice(0, body.limit ?? 100);
      return out({ blocks: list.map((b) => ({ block_height: b.height, block_timestamp: b.time })) });
    }
    if (url.pathname === "/v0/account") {
      const from = body.from_tx_block_height ?? 0;
      const to = body.to_tx_block_height ?? Infinity;
      const all = order.filter((tx) => included(tx) <= head && included(tx) >= from && included(tx) <= to && touched(tx, body.account_id, head));
      const start = body.resume_token ? Number(body.resume_token) : 0;
      const limit = body.limit ?? 200;
      const page = all.slice(start, start + limit);
      return out({
        account_txs: page.map((tx) => ({ account_id: body.account_id, transaction_hash: tx.hash, tx_block_height: included(tx), tx_index: 0 })),
        ...(start + limit < all.length ? { resume_token: String(start + limit) } : {}),
      });
    }
    if (url.pathname === "/v0/transactions") {
      requested.push(...(body.tx_hashes as string[]));
      const list = (body.tx_hashes as string[]).flatMap((hash) => {
        const tx = txs.get(hash);
        if (!tx || included(tx) > head) return [];
        const done = tx.receipts.filter((r) => r.height <= head);
        return [
          {
            transaction: { hash, signer_id: tx.signer, receiver_id: tx.receipts[0]!.executor },
            execution_outcome: outcome({ ...tx.receipts[0]!, id: hash, executor: tx.signer, logs: [] }, [tx.receipts[0]!.id]),
            receipts: done.map((r) => {
              const i = tx.receipts.indexOf(r);
              const next = tx.receipts[i + 1];
              return { receipt: { receipt_id: r.id, receiver_id: r.executor, predecessor_id: tx.signer }, execution_outcome: outcome(r, next ? [next.id] : []) };
            }),
            data_receipts: [],
          },
        ];
      });
      return out({ transactions: list });
    }
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;

  return { fetch, paths, requested, txs };
}
