#!/usr/bin/env bun
/**
 * `tredio-mcp`: the Tredio MCP server on stdio. Configuration is env only (see serverFromEnv in
 * index.ts); stdout carries the protocol, so diagnostics go to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { serverFromEnv } from "./index";

try {
  const server = serverFromEnv(process.env);
  await server.connect(new StdioServerTransport());
  console.error(`tredio-mcp ready (${process.env.NEAR_NETWORK || "testnet"}, API ${process.env.TREDIO_API_URL || "http://localhost:4000"})`);
} catch (e) {
  console.error(`tredio-mcp: ${String((e as Error).message ?? e)}`);
  process.exit(1);
}
