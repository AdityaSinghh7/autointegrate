# Autointegrate — Implementation Plan

## Context

This is a 3-hour engineering take-home ("Autointegrate", brief in `TAKEHOME.md`). We are building a local CLI chat agent on the **Claude Agent SDK (TypeScript)** that:
1. **Teaches** itself an unfamiliar API at runtime from documentation an operator pastes into chat.
2. **Uses** it in plain language (answers questions, performs actions) in a fresh session.
3. **Self-corrects** when the live API contradicts its spec.
4. **Stays fixed**: corrections persist across brand-new sessions.

It serves two customers (`acme`, `globex`) on one vendor API; learning must be **scoped** so customer-specific facts do not leak across tenants while integration-wide facts carry across both. The operator is non-technical; the intelligence lives in the system. Deliverables: a runnable repo, a **decision record** (the primary graded artifact), and a full uncurated trace.

The architecture was decided before planning and is summarized below; this plan turns it into a phase-ordered build. It was produced by three parallel planning agents (harness+memory, transport+correction+probing, validation+deliverables) whose seams are reconciled here.

## Architecture recap

- **Harness**: `@anthropic-ai/claude-agent-sdk` (TS), local subprocess. One `query()` in streaming-input mode = one SDK session per conversation. Durable knowledge lives only on disk, never SDK session resume, so a brand-new process works.
- **Memory** = filesystem markdown under `./memory` (the persistence layer). Agent reads with built-in Read/Grep/Glob, edits with Edit.
- **No-hardcoding firewall (graded)**: the code knows only two things, how to execute an API call over a pluggable transport, and how to manage markdown files. Endpoints, tenants, statuses, field names, counts, answers all arrive at runtime from the pasted spec.
- **Transport** is pluggable (not assumed HTTP): three thin tools (`http_request`, `graphql_request`, `grpc_request`) behind adapters, all normalizing to one envelope. REST and GraphQL both in scope and fully implemented; gRPC seam + stub.
- **Self-correction** has two layers: (1) a deterministic `PostToolUse`/`PostToolUseFailure` hook on the transport tools catches errors and structural contradictions of learned config; (2) the main agent's system prompt drives *semantic* self-correction so it can notice a result that looks wrong even when the call returned 2xx with no `errors[]` (implausible counts, empty-where-data-expected, values contradicting known facts, operator pushback) and re-investigate before answering.
- **Scoping**: corrections default to the customer's `profile.md`; promote to `integration.md` only when contract-level or corroborated across customers.
- **Probing**: first-contact ingestion runs a multi-agent fan-out to validate the spec against the live API.

## Repo layout

```
autointegrate/
  package.json            tsconfig.json  .env.example  .gitignore
  README.md  TAKEHOME.md  IMPLEMENTATION_PLAN.md  DECISION_RECORD.md
  src/
    index.ts                      # CLI entry + streaming-input chat loop
    agent/options.ts              # full Options object (mcpServers, hooks, perms, models)
    agent/systemPrompt.ts         # generic-integrator system prompt (zero sandbox specifics)
    memory/paths.ts               # slug + path helpers, heading/section constants (the seam)
    memory/guard.ts               # merged PreToolUse memory-write guard
    transport/types.ts            # TransportEnvelope + ActiveApiConfig + adapter interface
    transport/config.ts           # resolveActiveConfig(): parse ## Config from memory
    transport/rest.ts             # REST adapter
    transport/graphql.ts          # GraphQL adapter (Phase 2, in scope)
    transport/grpc.ts             # gRPC stub adapter
    tools/transportServer.ts      # createSdkMcpServer({name:"transport"}) with 3 tools
    tools/ingestServer.ts         # createSdkMcpServer({name:"ingest"}) with ingest_spec
    ingest/runIngestion.ts        # detect transport, draft config, fan out probers, synthesize
    ingest/probers.ts             # prober prompts + nested-query orchestration
    hooks/selfCorrect.ts          # PostToolUse(+Failure) analyzer + injection template
    correction/evaluate.ts        # per-transport structural checks
    instrumentation/costMeter.ts  # accumulate total_cost_usd/usage across loop + probers
    instrumentation/traceLogger.ts# serialize every SDKMessage to ./runs/<ts>.jsonl
  memory/
    INDEX.md                      # committed generic seed (manifest only)
    apis/.gitkeep                 # runtime-populated, tracked
  runs/.gitkeep                   # uncurated JSONL traces
  test/validate.ts                # non-hardcoding end-to-end checklist
```

## Cross-cutting contracts (reconciled seams)

These are frozen first because every phase binds to them.

**Memory paths (canonical):**
- `memory/INDEX.md` — small always-read manifest of known APIs + customers.
- `memory/apis/<api-slug>/integration.md` — integration-wide truth.
- `memory/apis/<api-slug>/customers/<customer-slug>/profile.md` — per-customer truth.
- `memory/apis/<api-slug>/corrections.md` — append-only, scope-tagged, evidence-bearing.

**Section headings (writers target these exact anchors):**
- `integration.md`: `## Config` (a single fenced ```yaml block, machine-readable, parsed by `resolveActiveConfig`), `## Transport`, `## Endpoints`, `## Conventions`, `## Open Questions`.
- `profile.md`: `## Customer Facts`, `## Verified Behaviors`, `## Config Overrides` (optional fenced yaml), `## Open Questions`.
- `corrections.md`: append-only list of `### <ISO-timestamp> — scope: <integration|customer:slug>` blocks with fixed keys (trigger, belief-before, reality-after, evidence, applied-to).

**The `## Config` YAML block** is the machine-readable source of truth for transport (generic keys, populated only from the pasted spec + probing): `transport`, `baseUrl`, `auth {mode,name,valueRef}`, `defaultHeaders`, `pathTemplates` (with `{customer}` placeholder), `statusEnum`, `enumFieldPath`, `alwaysPresentFields`, `expectedStatusCodes`. Secrets are never stored; `auth.valueRef` names an env var.

**Transport envelope** (the hook contract): `{ ok, transport, status, body, error{kind,message,detail}, meta{durationMs,requestSummary,apiSlug,customerSlug,graphqlErrors?} }`. REST `ok` = 2xx; GraphQL `ok` = 2xx AND no top-level `errors[]` (the critical rule lives in the adapter); gRPC `ok` = false (stub). Tools put the full envelope in `structuredContent` so the hook reads it cleanly.

**MCP servers / tool names:**
- Server `transport`: `mcp__transport__http_request`, `mcp__transport__graphql_request`, `mcp__transport__grpc_request`. The correction hook matcher is `mcp__transport__.*`.
- Server `ingest`: `mcp__ingest__ingest_spec`. Deliberately a separate server so the correction hook does NOT fire on ingestion.

**Probing model (reconciled):** probers are **non-destructive investigators** spawned as nested `query()` calls by the `ingest_spec` handler (not SDK `options.agents`, for determinism + cost attribution). They call the transport tools + Read and return a structured findings JSON in their final message; they never write memory (the **`ingest_spec` handler is the single memory writer**, which removes prober write-races and routes all writes through the one guard). Read-only API calls run automatically; any potentially-destructive API write is gated behind operator permission via the prober query's `canUseTool` callback (a prober-scoped `PreToolUse` hook auto-allows safe reads and returns `permissionDecision:"ask"` for writes, which the handler relays to the operator at the CLI). Sequential fallback = run probers in a loop instead of `Promise.all`.

**Hooks (one wiring):**
- `PreToolUse` matcher `Bash|Write|Edit` → `memoryGuard` (merged: deny destructive Bash inside `memory/`, deny `Write` clobber of `INDEX.md`/`integration.md`, deny writes escaping `memory/`, allow incremental Edits).
- `PostToolUse` and `PostToolUseFailure` matcher `mcp__transport__.*` → `selfCorrect`.

**Models:** main loop `claude-opus-4-8` (correctness matters in the live eval; override via `AUTOINTEGRATE_MODEL`); probers `claude-sonnet-4-6` (override via `AUTOINTEGRATE_PROBE_MODEL`). `maxBudgetUsd` cost cap (env `AUTOINTEGRATE_MAX_BUDGET_USD`, default ~5). `settingSources: []` so the build is hermetic (no machine-local `CLAUDE.md`/hooks leak in). `systemPrompt` is a custom string, not the `claude_code` preset. `includePartialMessages: true` for live text. `permissionMode: "bypassPermissions"` (safety via `disallowedTools` fencing destructive Bash + WebFetch/WebSearch off, plus the memory guard).

---

## Phase 0 — Scaffold

**Deliverables:** repo tree above; `package.json` (deps: `@anthropic-ai/claude-agent-sdk`, `zod`; dev: `typescript`, `tsx`, `@types/node`; scripts: `chat`, `typecheck`, `api:load`, `api:run`), `tsconfig.json` (NodeNext, ES2022, strict), `.env.example` (`ANTHROPIC_API_KEY`), `.gitignore` (ignore `node_modules`/`.env`/`*.tar`; **keep `memory/` tracked** with a comment so it is not "tidied away"; `runs/` tracked via `.gitkeep`), `README.md` (setup incl. the OrbStack precheck), generic `memory/INDEX.md` seed. Typed stubs for `transport/`, `ingest/`, `hooks/` so the harness compiles before later phases land.

**Key decisions:** each subsystem owns one `src/` folder; `options.ts` imports the others, so stubs de-risk parallel work.

**Checkpoint:** `npm run typecheck` passes; `npm run chat` boots, prints a banner, blocks on stdin (init `SystemMessage` received). No-hardcode grep clean: `grep -rIEi 'acme|globex|8787|orientation|hired|rejected|cdl|hazmat|APP-|/t/|driver_name' src/ memory/INDEX.md` returns nothing (wire as `pretest`).

## Phase 1 — Use loop (REST)

**Deliverables:**
- `src/index.ts`: stdin → `AsyncGenerator<SDKUserMessage>`; consume `query()` messages; stream `text_delta`s live; surface tool activity as plain one-liners ("checking the API…", "saving what I learned…"), never raw JSON; on `ResultMessage` accumulate `total_cost_usd` and print a running status line; `/exit` ends the generator; SIGINT calls `query.interrupt()` then exits.
- `src/agent/options.ts`: full Options wiring per the contracts above.
- `src/agent/systemPrompt.ts`: the main integration agent's system prompt. It is a **custom string** passed as `options.systemPrompt` (NOT the SDK `claude_code` preset, which carries coding-agent framing and dynamic sections we do not want). It must be generalizable across any API service and transport, and must cover:
  - **Identity and role.** An autonomous integration agent that learns and operates arbitrary third-party API services on behalf of a non-technical operator (an ops/recruiting coordinator). The intelligence lives in the system; never ask the operator for technical details, to read docs, or to write code.
  - **Transport-agnostic.** It knows an API only from memory + what the operator pasted; it must work for REST, GraphQL, or any learned transport. Always read the learned `transport` and config from memory before acting; never assume HTTP/REST.
  - **Memory protocol.** Read `INDEX.md` first; identify the API + customer in scope; read that API's `integration.md` and the customer's `profile.md` before answering or acting; construct calls only from learned config; record durable learnings via Edit.
  - **Scoping rule.** Default-write learnings/corrections to the customer's `profile.md`; promote to `integration.md` only when contract-level or corroborated across customers; never apply one customer's fact to another.
  - **Teaching.** When the operator pastes API documentation, call `ingest_spec` with the full text.
  - **Semantic self-correction (emphasized).** A 2xx response with no `errors[]` is NOT proof the answer is right. After every answer or action, sanity-check the result against learned facts and common sense, and treat any of these as a signal to re-investigate before responding: an implausible count (too low/high), an empty or suspiciously short result where data was expected, a total that disagrees with a separately derived count, a value that contradicts something already known, or a GraphQL/partial response that quietly dropped data. When a result looks wrong, do not just report it: re-investigate (re-query without an assumed filter, check pagination/limit, re-verify the field/enum/date logic, try an alternate endpoint/operation), find the real behavior, correct memory (scoped), then answer correctly.
  - **Operator pushback is authoritative.** If the operator says an answer looks wrong ("that's too low", "we hired a bunch"), treat it as evidence you are wrong, not something to defend; re-investigate and correct.
  - **Relationship to the hook.** The transport `PostToolUse` hook is a deterministic safety net for errors and structural contradictions and will inject a correction signal when it fires; semantic judgment is the agent's own responsibility and must fire even when the hook stays silent (the call succeeded).
  - **Honesty.** Never invent endpoints, fields, statuses, tenants, or counts; if memory lacks something, probe or ask; if a thing cannot be verified, say so. Answer in plain language; when an action changed state, confirm what changed.
  A no-hardcode check ensures the concrete prompt string names no vendor-specific endpoints/tenants/statuses/fields.
- `src/transport/types.ts`, `config.ts` (`resolveActiveConfig` parsing the `## Config` YAML), `rest.ts`, `tools/transportServer.ts` (all three tools registered; REST adapter real in Phase 1; GraphQL adapter real in Phase 2; gRPC stub), `memory/paths.ts`, `memory/guard.ts`.
- `instrumentation/costMeter.ts` + `traceLogger.ts` (cross-cutting plumbing lands here).

**Checkpoint (T1):** with a hand-seeded generic throwaway api config (not the sandbox), a plain question yields a streamed answer + cost line; debug shows the first tool call each turn is `Read` of `INDEX.md`; the memory guard denies a write outside `memory/` and a clobber of `integration.md`; a bad REST path returns `ok:false, error.kind:"http_status"`.

## Phase 2 — Teach / probe

**Deliverables:**
- `tools/ingestServer.ts`: `ingest_spec(spec, apiSlug?, customers?)`.
- `ingest/runIngestion.ts`: detect transport from spec shape (GraphQL SDL / `.proto` service defs / else REST); parse a **draft** `## Config` + draft `integration.md`; fan out probers; synthesize; write `integration.md` + per-customer `profile.md` + seed `corrections.md` with spec-vs-reality deltas; update `INDEX.md`. Single writer.
- `ingest/probers.ts`: the prober fleet, each a nested `query()` (model `claude-sonnet-4-6`, high effort, `maxTurns` cap, `permissionMode:"default"`, allowedTools = the transport tools + `Read`; NO `Edit`/`Write`, so probers never touch memory). Each prober returns a structured findings JSON that the handler merges. The fleet performs a **thorough end-to-end probe** of the API surface, divided into focused objectives:
  1. **Surface map** — from the draft config, enumerate every endpoint/operation and confirm each is reachable read-only (GET / GraphQL query / introspection).
  2. **Collection behavior** — pagination, default page size, max limit, whether totals require paging, available filter/sort params (this is the class of bug behind "the count looks too low").
  3. **Object schema reality** — fetch sample records; compare documented vs actual fields; note always-present vs optional, undocumented/extra fields, and types/nested shapes.
  4. **Enum/status reality** — collect the distinct observed values of any status-like field and compare to the documented set.
  5. **Tenancy** — enumerate customers/tenants, how tenancy is expressed (path/header/arg), and per-customer differences.
  6. **Conventions and errors** — date/time format + timezone, id/number formats, and the error-response contract (probe a deliberate bad id / malformed query, which is read-only and safe, to learn the 404/error shape).
  7. **Write capability (gated)** — identify create/update/delete (REST) or mutations (GraphQL) from the spec and record their contract; do NOT execute them by default (see permission gating below).
  Findings are merged by the `ingest_spec` handler; **sequential fallback** runs the probers in a loop instead of `Promise.all`.
- `transport/graphql.ts` (**real, in scope**) + `transport/grpc.ts` (stub) wired into their tools; ingestion recognizes and records gRPC (`.proto`/service defs) but the executor honestly declines. The GraphQL adapter POSTs `{query, variables}` to the single endpoint and applies the envelope's 200-with-`errors[]` rule so failed queries/mutations surface as `ok:false`. Because the provided sandbox is REST-only, GraphQL is verified against a small public no-auth GraphQL endpoint (the operator teaches it the same way: paste its schema/docs).

**Non-destructive probing + permission-gated writes** (grounded in the SDK's user-input / `canUseTool` flow, https://code.claude.com/docs/en/agent-sdk/user-input): every prober defaults to non-destructive. A prober-scoped `PreToolUse` hook classifies each transport call by method: safe reads (GET, GraphQL query, HEAD/OPTIONS) return `permissionDecision:"allow"` and run automatically; anything potentially destructive (POST/PATCH/PUT/DELETE, GraphQL mutation) returns `permissionDecision:"ask"`, which triggers the prober query's `canUseTool` callback. The handler relays that request to the operator at the CLI (showing the exact method + path/operation + body) and returns `{behavior:"allow", updatedInput}` or `{behavior:"deny", message}`. On allow, the prober prefers the most reversible operation and logs it verbatim; on deny (or in a non-interactive run, where the default is deny), it records the write contract from the spec as unverified under `## Open Questions` and moves on. Prober prompts also state explicitly: do not assume the sandbox resets; treat all writes as permanent. (We use `canUseTool`, not `AskUserQuestion`, because the docs note `AskUserQuestion` is unavailable in Agent-tool subagents; `canUseTool` works on our nested `query()` probers.)

**Checkpoint (T2):** pasting a spec → `ingest_spec` runs → `integration.md` has all sections incl. `## Config`, ≥1 `profile.md`, INDEX updated, any discovered delta seeded in `corrections.md`; re-teach is idempotent (same slug, edit-in-place); grep stays clean.

## Phase 3 — Self-correct

**Deliverables:**
- `correction/evaluate.ts`: per-transport structural checks. Deterministic flags: REST status outside learned `expectedStatusCodes`; GraphQL `errors[]`; response missing an `alwaysPresentFields` member; enum value at `enumFieldPath` not in learned `statusEnum`. Soft flag: suspiciously empty/short success body (low-confidence, gentle wording). Honest boundary: "count is semantically too low" is NOT structural, it is operator pushback.
- `hooks/selfCorrect.ts`: read the envelope from `tool_output.structuredContent`; if a finding, return `hookSpecificOutput.additionalContext` = the tight injection template (names the offending call + api/customer + observed-vs-expected + the specific memory file to update + the scope decision instruction + "re-attempt then answer"). The hook never writes memory; the model does, through the guarded Edit path.
- System-prompt lines (already in Phase 1 prompt) reinforce operator-pushback and agent-noticed drift handling with the same scoping language.

**Checkpoint (T3):** set a deliberately-narrow `statusEnum`; a call returning an out-of-set value fires the hook, the model appends a scoped `corrections.md` entry + updates config, re-answers; **kill the process, start fresh, ask again → correct on first try, no hook re-fire** (the stays-fixed gate); a correction on customer X does not change customer Y; guard blocks `Write` over `integration.md` and `rm memory/...`.

## Phase 4 — Polish and deliverables

**Deliverables:**
- `test/validate.ts`: the non-hardcoding end-to-end checklist (reads slugs/endpoints from `memory/`, derives expected answers by hitting the live API, compares to the agent's spoken answers; skips cleanly if memory not yet populated).
- Cost summary on exit (by phase: ingestion vs use; by model), feeding the decision record's rough cost figure.
- Trace: confirm `runs/*.jsonl` captures every `SDKMessage` uncurated; commit the headline self-correction run as evidence; also include a Claude Code `/export` of OUR build session per the deliverable.
- `DECISION_RECORD.md` (primary artifact): problem framing; what we built + how to run it; architecture + why; the 5 key tradeoffs to argue (filesystem memory over a DB; triggered hook correction over self-audit/cron; multi-agent probing only at first contact, amortized via memory; integration vs customer scoping; cheaper model for probers); what we cut + why; how-it-handles-being-wrong with a concrete walked example quoting a real `corrections.md` entry; cost/token usage; limitations + next steps.
- `README.md` finalize incl. the OrbStack precheck and trace pointer; wire the no-hardcode grep as `pretest`.

## Risk register and cut order

Top risks: OrbStack daemon stopped (README step 0: `open -a OrbStack` + `docker info` precheck); the pagination/limit trap may not be the real bug (the loop triggers on any contradiction or operator pushback, and the undocumented-field path is a backup self-correction demo); self-correction not finished in time (build teach+use+act first).

**Cut from the bottom up:** (1) gRPC beyond the stub (REST and GraphQL stay in scope); (2) prober-cost attribution (report total + estimate); (3) the automated multi-tenant scoping test (keep the behavior, drop the gated check); (4) date-bounded "this year" verification; (5) cheaper-prober optimization; (6) CLI polish (keep the JSONL trace + exit summary). **Never cut:** teach + basic counts, one self-correction, one action, the stays-fixed cross-session check.

## Verification (definition of done, tied to the brief's 4 steps)

A reviewer who clones the repo and follows the README can, against a freshly-restarted container:
- **DoD-0 Runs:** `open -a OrbStack` → `docker load -i driver-api.tar` → `docker run -p 8787:8787 driver-applications-api` → `npm install && npm run chat`.
- **DoD-1 Teach:** pasting Appendix A populates `memory/` (INDEX + integration + profile) at runtime, nothing pre-seeded.
- **DoD-2 Use:** a fresh session answers the Appendix-B count/list/filter/this-year questions matching the live API, and performs an action (move/add) then reports the corrected count.
- **DoD-3 Self-correct:** "that count is too low" → the agent re-investigates, re-answers correctly, writes a scoped `corrections.md` entry.
- **DoD-4 Stays fixed:** restart the **agent process** (not the container) → the same previously-wrong question is correct on first try.
- **DoD-5 Deliverables:** repo runs; `DECISION_RECORD.md` complete with a walked example + cost figure; `runs/*.jsonl` present; build-session `/export` included.

For the stays-fixed test, restart the agent process but keep the container running, so vendor data is unchanged and only memory persistence is exercised; keep write-then-requery checks within one container lifetime.

## Cost and models

Main loop `claude-opus-4-8`, probers `claude-sonnet-4-6`, both env-overridable; `maxBudgetUsd` cap. Report a rough full-cycle cost (teach + ~6 questions + one correction + one action + cross-session re-check) by summing `total_cost_usd` across all `query()` runs, noting prompt-cache reads lower repeat-turn cost and the prober-model lever.
