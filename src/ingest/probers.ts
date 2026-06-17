// The prober fleet. Each prober is a read-only nested query() that investigates
// the live API and returns a strict JSON findings block. Probers never write
// memory (the synthesis step is the single writer). Reads run automatically; any
// potentially-destructive write is gated: a PreToolUse hook auto-allows safe reads
// and returns "ask" for writes, which routes to canUseTool -> the operator.

import { resolve } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { makeTransportServer } from "../tools/transportServer.js";
import { askOperator } from "../permissionBroker.js";
import { runOneShot, parseJsonBlock } from "./util.js";
import { report } from "../reporter.js";

const PROBE_MODEL = process.env.AUTOINTEGRATE_PROBE_MODEL ?? "claude-sonnet-4-6";
const READ_TOOLS = ["Read", "Grep", "Glob"];
const TRANSPORT_TOOLS = [
  "mcp__transport__http_request",
  "mcp__transport__graphql_request",
  "mcp__transport__grpc_request",
];

async function proberWriteGate(input: any): Promise<any> {
  const tool: string = input?.tool_name ?? "";
  const ti = input?.tool_input ?? {};
  let isWrite = false;
  if (tool === "mcp__transport__http_request") {
    const m = String(ti.method ?? "GET").toUpperCase();
    isWrite = !["GET", "HEAD", "OPTIONS"].includes(m);
  } else if (tool === "mcp__transport__graphql_request") {
    isWrite = /\bmutation\b/i.test(String(ti.query ?? ""));
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: isWrite ? "ask" : "allow",
    },
  };
}

async function proberCanUseTool(toolName: string, input: any): Promise<any> {
  // Only writes reach here; reads are auto-allowed by the gate.
  let summary = toolName;
  if (toolName === "mcp__transport__http_request") {
    summary = `${String(input?.method ?? "").toUpperCase()} ${input?.path ?? ""}`.trim();
  } else if (toolName === "mcp__transport__graphql_request") {
    summary = "a GraphQL mutation";
  }
  const approved = await askOperator(
    `A prober wants to perform a potentially-destructive write (${summary}). Allow?`,
  );
  if (approved) return { behavior: "allow", updatedInput: input };
  return {
    behavior: "deny",
    message:
      "Operator did not approve this write. Do not retry; record the write contract from the documentation under Open Questions instead.",
  };
}

function buildProbeOptions(): Options {
  return {
    model: PROBE_MODEL,
    cwd: process.cwd(),
    additionalDirectories: [resolve(process.cwd(), "memory")],
    permissionMode: "default",
    settingSources: [],
    strictMcpConfig: true,
    systemPrompt: "You probe live APIs and report only verified findings, as strict JSON.",
    tools: [...READ_TOOLS, ...TRANSPORT_TOOLS],
    // Reads auto-approved; transport calls are classified by the PreToolUse gate.
    allowedTools: READ_TOOLS,
    mcpServers: { transport: makeTransportServer() },
    hooks: { PreToolUse: [{ matcher: "mcp__transport__.*", hooks: [proberWriteGate] }] },
    canUseTool: proberCanUseTool,
    maxTurns: 30,
  };
}

interface ProbeSpec {
  key: string;
  label: string;
  objective: string;
}

const PROBE_SPECS: ProbeSpec[] = [
  {
    key: "collection_pagination",
    label: "collection & pagination",
    objective: `Investigate the API's primary collection/list endpoint(s). Establish the exact structure of a list response, and determine whether a single request returns the COMPLETE set of records or only a partial subset. If it is partial, work out how to retrieve the full set and how to compute an accurate total. Identify which query parameters the endpoint accepts and test whether each behaves the way the documentation describes. Confirm everything by making real calls; do not trust the documentation.`,
  },
  {
    key: "schema_enums",
    label: "fields & values",
    objective: `Fetch several list responses and several individual records. For each field the documentation describes, verify whether it is actually present and whether its type/shape matches the description; note documented fields that are missing and any fields that appear but are not documented. For any field that takes one of a small set of categorical values, collect the distinct values that actually occur in the data and compare them against whatever the documentation claims those values are.`,
  },
  {
    key: "tenancy",
    label: "tenancy",
    objective: `For each customer/tenant provided, confirm its endpoint is reachable and fetch a small sample. Determine how tenancy is expressed in requests, and note any differences you observe between customers (for example in record counts or which categories of records appear). Read-only.`,
  },
];

export async function runProbers(
  apiSlug: string,
  spec: string,
  customers: string[],
): Promise<{ results: Record<string, any>; cost: number; count: number }> {
  const customerLine = customers.length
    ? `Known customers/tenants: ${customers.join(", ")}.`
    : "No specific customers were named.";

  const buildPrompt = (objective: string) =>
    `You are a careful API prober. Your job is to discover how a live API REALLY behaves, which may differ from its documentation.

The API has slug "${apiSlug}". Its drafted config is in memory at memory/apis/${apiSlug}/integration.md (read it first). When calling the transport tools, pass apiSlug: "${apiSlug}"; for customer-scoped paths pass customerSlug. ${customerLine}

Probing is READ-ONLY. Do not execute writes (POST/PATCH/PUT/DELETE, or GraphQL mutations). If verifying a write would materially help, you may attempt ONE minimal, most-reversible write, which requires operator approval; otherwise record the write contract from the documentation. Never assume the documentation is correct; verify by calling the API.

Your objective:
${objective}

Report ONLY your final, verified findings. Do not narrate transient errors, retries, or tool-availability problems; if you genuinely could not verify something, leave it out or state it as unverified in a finding.

When finished, respond with ONLY a single fenced \`\`\`json block of this shape:
{ "findings": ["concise factual statement", ...], "specVsReality": [{ "claim": "what the docs say", "reality": "what you observed", "scope": "integration" }, ...], "perCustomer": { "<slug>": ["fact", ...] } }
Omit keys that do not apply. Be concrete (real field names, values, counts you observed).

DOCUMENTATION (verify against reality):
${spec}`;

  report(`probing the live API — ${PROBE_SPECS.length} aspects in parallel…`);

  // Run probers concurrently; report a one-line summary as each finishes.
  const settled = await Promise.all(
    PROBE_SPECS.map((p) =>
      runOneShot(buildPrompt(p.objective), buildProbeOptions())
        .then((r) => {
          const parsed = parseJsonBlock(r.text);
          const n = Array.isArray(parsed?.findings) ? parsed.findings.length : 0;
          const d = Array.isArray(parsed?.specVsReality) ? parsed.specVsReality.length : 0;
          report(`  ✓ ${p.label}: ${n} finding${n === 1 ? "" : "s"}${d ? `, ${d} spec-vs-reality` : ""}`);
          return { key: p.key, parsed: parsed ?? { raw: r.text.slice(0, 2000) }, cost: r.costUsd };
        })
        .catch((e) => {
          report(`  ✗ ${p.label}: ${e instanceof Error ? e.message : "failed"}`);
          return { key: p.key, parsed: { error: String(e) }, cost: 0 };
        }),
    ),
  );

  const results: Record<string, any> = {};
  let cost = 0;
  for (const s of settled) {
    results[s.key] = s.parsed;
    cost += s.cost;
  }
  return { results, cost, count: settled.length };
}
