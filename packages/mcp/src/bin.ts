#!/usr/bin/env bun
/**
 * `tredio-mcp`: the Tredio MCP server on stdio. Configuration is env only (see serverFromEnv in
 * index.ts); stdout carries the protocol, so diagnostics go to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_API, serverFromEnv } from "./index";

try {
  const server = serverFromEnv(process.env);
  await server.connect(new StdioServerTransport());
  const network = process.env.NEAR_NETWORK === "mainnet" ? "mainnet" : "testnet";
  console.error(`tredio-mcp ready (${network}, API ${process.env.TREDIO_API_URL || DEFAULT_API[network]})`);
} catch (e) {
  console.error(`tredio-mcp: ${String((e as Error).message ?? e)}`);
  process.exit(1);
}
