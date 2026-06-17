// Builds the full Options object for the main conversational agent.

import { resolve } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { makeTransportServer } from "../tools/transportServer.js";
import { ingestServer } from "../tools/ingestServer.js";
import { memoryGuard } from "../memory/guard.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";

export function buildOptions(): Options {
  const model = process.env.AUTOINTEGRATE_MODEL ?? "claude-opus-4-8";
  const parsedBudget = Number(process.env.AUTOINTEGRATE_MAX_BUDGET_USD ?? "5");
  const maxBudgetUsd = Number.isFinite(parsedBudget) ? parsedBudget : 5;

  // The complete tool surface for the agent: read/search/edit of its memory plus
  // the transport tools. `tools` (below) makes this an exclusive whitelist.
  const AGENT_TOOLS = [
    "Read",
    "Grep",
    "Glob",
    "Edit",
    "Write",
    "mcp__transport__http_request",
    "mcp__transport__graphql_request",
    "mcp__transport__grpc_request",
    "mcp__ingest__ingest_spec",
  ];

  return {
    model,
    cwd: process.cwd(),
    additionalDirectories: [resolve(process.cwd(), "memory")],
    includePartialMessages: true,
    permissionMode: "bypassPermissions",
    maxBudgetUsd,
    // Hermetic build: ignore machine-local settings AND machine-global MCP servers
    // (claude.ai connectors, user/project .mcp.json) so the agent sees only our
    // transport server plus a tight built-in whitelist.
    settingSources: [],
    strictMcpConfig: true,
    systemPrompt: SYSTEM_PROMPT,
    // `tools` is a strict whitelist that REPLACES the default tool set: the agent
    // gets exactly memory read/search/edit + the transport tools. No Bash, no web,
    // no host tools.
    tools: AGENT_TOOLS,
    allowedTools: AGENT_TOOLS,
    mcpServers: { transport: makeTransportServer(), ingest: ingestServer },
    hooks: {
      // Protect memory files. Triggered self-correction is not a hook: it lives
      // inside the transport tool (see tools/transportServer.ts), which has the
      // live envelope + learned config in hand and appends the signal to its result.
      PreToolUse: [{ matcher: "Write|Edit", hooks: [memoryGuard] }],
    },
  };
}
