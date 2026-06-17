// Ingestion orchestration: draft a config from the pasted spec (LLM), write draft
// memory (the handler is the sole writer here), fan out read-only probers against
// the live API, then a synthesis agent reconciles findings into the final memory
// and seeds corrections. Each step is a nested query(); cost is summed and
// reported back to the operator.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stringify as yamlStringify } from "yaml";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import {
  INDEX_PATH,
  apiDir,
  correctionsPath,
  customerDir,
  integrationPath,
  profilePath,
  slugify,
} from "../memory/paths.js";
import { memoryGuard } from "../memory/guard.js";
import { runOneShot, parseJsonBlock } from "./util.js";
import { runProbers } from "./probers.js";
import { report } from "../reporter.js";
import { costMeter } from "../instrumentation/costMeter.js";

const PROBE_MODEL = process.env.AUTOINTEGRATE_PROBE_MODEL ?? "claude-sonnet-4-6";

function buildDraftOptions(): Options {
  return {
    model: PROBE_MODEL,
    cwd: process.cwd(),
    permissionMode: "bypassPermissions",
    settingSources: [],
    strictMcpConfig: true,
    tools: [],
    mcpServers: {},
    systemPrompt:
      "You extract a structured integration config from API documentation. Respond with ONLY a single fenced ```json block and no other text.",
    maxTurns: 1,
  };
}

function buildSynthOptions(): Options {
  return {
    model: PROBE_MODEL,
    cwd: process.cwd(),
    additionalDirectories: [resolve(process.cwd(), "memory")],
    permissionMode: "bypassPermissions",
    settingSources: [],
    strictMcpConfig: true,
    tools: ["Read", "Grep", "Glob", "Edit", "Write"],
    allowedTools: ["Read", "Grep", "Glob", "Edit", "Write"],
    mcpServers: {},
    hooks: { PreToolUse: [{ matcher: "Write|Edit", hooks: [memoryGuard] }] },
    systemPrompt:
      "You finalize an API's learned memory by reconciling probe findings with the drafted files. You edit Markdown memory files only, in place.",
    maxTurns: 60,
  };
}

const DRAFT_SHAPE = `{
  "apiSlug": "<short-kebab-case name>",
  "transport": "rest" | "graphql" | "grpc",
  "baseUrl": "<exactly as the docs state>",
  "customers": ["<tenant>", ...],
  "pathTemplates": { "<name>": "<path with {placeholders}>" },
  "statusEnum": ["<documented value>", ...] or null,
  "enumFieldPath": "<field name of the status/state enum>" or null,
  "alwaysPresentFields": ["<field>", ...],
  "expectedStatusCodes": [200, 201, ...],
  "endpoints": [{ "method": "<verb or omit>", "path": "<path or operation>", "purpose": "<short>" }],
  "writeOps": [{ "method": "<verb>", "path": "<path>", "purpose": "<short>" }],
  "conventions": "<one short paragraph: dates, ids, filtering, anything notable>"
}`;

async function draftConfig(spec: string): Promise<{ draft: any; cost: number }> {
  const prompt = `Extract a draft integration config from the following API documentation. Respond with ONLY a fenced \`\`\`json block matching this shape:

${DRAFT_SHAPE}

Use ONLY what the docs state; do not invent a baseUrl. Derive a short apiSlug. List any named tenants/customers. If the docs document a status/state enum, capture it (it may later prove wrong).

DOCUMENTATION:
${spec}`;
  const { text, costUsd } = await runOneShot(prompt, buildDraftOptions());
  const draft = parseJsonBlock(text);
  return { draft, cost: costUsd };
}

async function writeDraftMemory(apiSlug: string, draft: any, customers: string[]): Promise<void> {
  await mkdir(apiDir(apiSlug), { recursive: true });

  const config: Record<string, unknown> = {
    transport: draft.transport,
    baseUrl: draft.baseUrl,
  };
  if (draft.pathTemplates) config.pathTemplates = draft.pathTemplates;
  if (draft.statusEnum) config.statusEnum = draft.statusEnum;
  if (draft.enumFieldPath) config.enumFieldPath = draft.enumFieldPath;
  if (draft.alwaysPresentFields) config.alwaysPresentFields = draft.alwaysPresentFields;
  config.expectedStatusCodes = draft.expectedStatusCodes ?? [200, 201];

  const endpoints = Array.isArray(draft.endpoints) ? draft.endpoints : [];
  const writeOps = Array.isArray(draft.writeOps) ? draft.writeOps : [];
  const endpointLines =
    endpoints
      .map((e: any) => `- ${e.method ? `${e.method} ` : ""}${e.path ?? e.operation ?? ""} — ${e.purpose ?? ""}`)
      .join("\n") || "(none parsed)";
  const openQ = [
    "Drafted from documentation and NOT yet verified against the live API.",
    ...writeOps.map(
      (w: any) => `Write contract (unverified): ${w.method ? `${w.method} ` : ""}${w.path ?? ""} — ${w.purpose ?? ""}`,
    ),
  ]
    .map((l) => `- ${l}`)
    .join("\n");

  const integration = `# Integration: ${apiSlug}

## Config

\`\`\`yaml
${yamlStringify(config).trim()}
\`\`\`

## Transport

${String(draft.transport).toUpperCase()} API. Base: ${draft.baseUrl}

## Endpoints

${endpointLines}

## Conventions

${draft.conventions ?? "(none parsed)"}

## Open Questions

${openQ}
`;
  await writeFile(integrationPath(apiSlug), integration, "utf8");

  await writeFile(
    correctionsPath(apiSlug),
    `# Corrections: ${apiSlug}\n\nAppend-only. Newest at the bottom. Each entry records a contradiction between belief and reality and where the fix landed.\n`,
    "utf8",
  );

  for (const c of customers) {
    await mkdir(customerDir(apiSlug, c), { recursive: true });
    await writeFile(
      profilePath(apiSlug, c),
      `# Customer: ${c} (API: ${apiSlug})

Facts true of THIS customer only. Default destination for new learnings.

## Customer Facts

(to be verified)

## Verified Behaviors

(none yet)

## Open Questions

(none)
`,
      "utf8",
    );
  }

  // INDEX manifest (handler writes via fs; not subject to the agent's guard).
  let index = "";
  try {
    index = await readFile(INDEX_PATH, "utf8");
  } catch {
    index = "# Autointegrate Memory Index\n\n## Known APIs\n\n_(none learned yet)_\n";
  }
  const entry = `### ${apiSlug}\n- Purpose: learned at runtime\n- Transport: ${draft.transport}\n- Details: apis/${apiSlug}/integration.md\n- Customers: ${customers.join(", ") || "(none named)"}\n- Last updated: draft (pre-probe)`;
  if (index.includes("_(none learned yet)_")) {
    index = index.replace("_(none learned yet)_", entry);
  } else if (!index.includes(`### ${apiSlug}\n`)) {
    index = index.replace(/(##\s*Known APIs\s*\n)/, `$1\n${entry}\n`);
  }
  await writeFile(INDEX_PATH, index, "utf8");
}

function buildSynthPrompt(
  apiSlug: string,
  customers: string[],
  findings: Record<string, any>,
  nowIso: string,
): string {
  const customerFiles = customers
    .map((c) => `- memory/apis/${apiSlug}/customers/${c}/profile.md`)
    .join("\n");
  return `Probers have investigated the live API "${apiSlug}". Reconcile their findings with the drafted memory and finalize it. Work ONLY within ./memory.

Ground rules:
- Use ONLY the PROBE FINDINGS below plus the drafted memory files. Do NOT read anything under ./runs, and do NOT speculate about how the findings were gathered, tool availability, or the probing process itself.
- corrections.md records ONLY contradictions between the DOCUMENTATION and the API's REAL behavior (content deltas). Never write a correction about the ingestion mechanism, tooling, or connectivity.
- If something is uncertain or was not verified, put it under "## Open Questions"; do not assert it, and do not invent a failure narrative.

Read these first:
- memory/apis/${apiSlug}/integration.md (draft; edit it incrementally)
- memory/apis/${apiSlug}/corrections.md (append-only)
${customerFiles || "(no customer profiles)"}
- memory/INDEX.md

Then do all of the following:
1. Make integration.md reflect REALITY:
   - Fix the "## Config" yaml where probing contradicts the draft. If the real value set of any categorical field differs from the documented one, set "statusEnum" to the REAL values and "enumFieldPath" to that field. Set "alwaysPresentFields" from fields actually always present and "expectedStatusCodes" from observed codes. Keep the yaml valid.
   - Put verified, API-wide facts (response shape, pagination/cursor behavior, how to get a true total, real field names, date conventions) into "## Conventions".
   - Resolve items in "## Open Questions" that probing answered; keep the rest.
   - Keep the exact headings: ## Config, ## Transport, ## Endpoints, ## Conventions, ## Open Questions. Use Edit (do not overwrite the whole file with Write).
2. For each customer, update their profile.md "## Verified Behaviors" with that customer's verified facts. Facts true of ALL customers belong in integration.md, not per customer.
3. For each spec-vs-reality contradiction, append an entry to corrections.md in EXACTLY this format:

### ${nowIso} — scope: integration
- trigger: ingestion-probe
- belief (before): <what the docs claimed>
- reality (after): <what probing observed>
- evidence: <the call(s)/values observed>
- applied to: <file/section you updated>

(Use scope: customer:<slug> when the fact is customer-specific.)
4. Update memory/INDEX.md: change the entry's "Last updated" to a current date and ensure customers are listed.

PROBE FINDINGS (JSON):
${JSON.stringify(findings, null, 2)}
`;
}

export async function runIngestion(spec: string, customersHint?: string[]): Promise<string> {
  let cost = 0;

  report("reading the documentation and drafting a config…");
  const { draft, cost: draftCost } = await draftConfig(spec);
  cost += draftCost;
  if (!draft || !draft.transport || !draft.baseUrl) {
    throw new Error("Could not extract a transport + baseUrl from the pasted documentation.");
  }
  const apiSlug = slugify(String(draft.apiSlug || "api")) || "api";
  const customers = (customersHint?.length ? customersHint : (draft.customers ?? []))
    .map((c: string) => slugify(c))
    .filter(Boolean);

  await writeDraftMemory(apiSlug, draft, customers);
  report(`drafted "${apiSlug}" (${draft.transport})${customers.length ? `, customers: ${customers.join(", ")}` : ""}`);

  const probe = await runProbers(apiSlug, spec, customers);
  cost += probe.cost;

  report("reconciling findings into memory…");
  const synth = await runOneShot(
    buildSynthPrompt(apiSlug, customers, probe.results, new Date().toISOString()),
    buildSynthOptions(),
  );
  cost += synth.costUsd;

  costMeter.addUsd(cost); // fold ingestion's nested-query cost into the session total
  report(`learned "${apiSlug}" — ingestion cost ~$${cost.toFixed(3)}`);

  return `Learned "${apiSlug}" (transport: ${draft.transport}; customers: ${customers.join(", ") || "none named"}). Probed ${probe.count} aspects of the live API and reconciled the findings into memory. Ingestion cost ~$${cost.toFixed(3)}.`;
}
