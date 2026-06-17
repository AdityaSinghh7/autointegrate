# Autointegrate — Decision Record

This is the document to read. The code behaves a little differently each run; the
reasoning below should not.

## 1. The problem

Connecting a new system to a product is normally manual: an engineer reads the
vendor's docs, writes a client, maps fields, and keeps it working as the vendor
drifts. The cost grows per customer and per system. The goal here is an agent that
can take an API it has never seen, learn it from the docs an operator pastes, use it
in plain language, and get *more* reliable as it is used rather than needing constant
maintenance, while serving more than one customer on the same integration without
letting one customer's quirks bleed into another.

Concretely the system must: (1) **teach** itself an API from pasted docs, (2) **use**
it in a fresh session (answer questions, take actions), (3) **self-correct** when the
API behaves differently from its docs, and (4) **stay fixed** so corrections persist
across brand-new sessions.

## 2. What it does and how to run it

A local CLI chat agent built on the **Claude Agent SDK (TypeScript)**. The operator
pastes a vendor's documentation; the agent ingests and probes the live API, then
answers questions and performs actions in plain language. Everything it learns is
written as Markdown under `./memory`, which is the persistence layer.

```
npm install
cp .env.example .env          # set ANTHROPIC_API_KEY (or use an ambient Claude login)
# bring up the sandbox vendor API:
open -a OrbStack && docker load -i driver-api.tar && docker run --rm -p 8787:8787 driver-applications-api
npm run chat                  # then paste docs between /teach and /end, or just ask
```

See `IMPLEMENTATION_PLAN.md` for the phase-by-phase build and `README.md` for setup.

## 3. Architecture at a glance

```
 operator (CLI)
   │  streamed replies; dim, deduped activity notes; live ingestion progress
   ▼
 main agent  ── query() streaming-input loop, ONE session per conversation
   │   custom system prompt (generic integrator), bypassPermissions
   ├── memory tools (Read/Grep/Glob/Edit) over ./memory  ← guarded by a PreToolUse hook
   ├── transport tools: http_request / graphql_request / grpc_request   (server "transport")
   │      └── each call: resolve learned config → execute → normalize to one envelope
   │                     → run structural check → APPEND a [SELF-CORRECTION SIGNAL] if it
   │                       contradicts learned config  ← self-correction lives HERE
   └── ingest_spec (separate server "ingest"): on a pasted spec, runs the probing pipeline
          draft config → write draft memory → fan out read-only probers → synthesize
 ./memory/  INDEX.md  +  apis/<api>/integration.md  +  customers/<cust>/profile.md  +  corrections.md
```

The code knows only two things: how to execute an API call over a transport, and how
to manage Markdown files. Everything specific to any API is learned at runtime.

## 4. Key decisions and why

### Harness, language, runtime
- **Claude Agent SDK, TypeScript, local subprocess (not containerized).** The SDK
  ships the built-in filesystem tools (Read/Edit/Grep/Glob), an interactive
  streaming loop, custom in-process tools, and permission controls, which is exactly
  the surface this needs. TypeScript over Python: it bundles the engine binary
  (clone-and-run with no separate CLI install) and is what we want to drive live.
  Local subprocess so the `./memory` filesystem persists across runs.

### Why not containerize the agent (and what production would do)

v0 runs as a plain local subprocess, not in a container, for two reasons.

First, persistence. The point of the memory is that it survives across separate sessions,
and a local subprocess gets that for free: `./memory` is just files on disk. A container's
filesystem is ephemeral, so the same guarantee would require mounting a persistent volume.
To be precise, it is not that a container *cannot* persist memory (it can, with a mounted
volume); it is that a subprocess gives it for free with nothing extra to maintain for a
local, single-operator tool.

Second, and more importantly, containerization is really a production concern, and in
production the persistence story changes shape. A real deployment runs on distributed,
ephemeral compute (autoscaled workers, serverless, CI runners) where no two hosts share a
local disk, so the local filesystem stops being a reliable source of truth. Two distinct
things then have to be externalized, and they are not the same thing:

- **The agent's learned knowledge** (the `./memory` markdown) would live on shared,
  durable storage mounted as a POSIX filesystem: AWS EFS (NFS), Mountpoint-for-S3 or
  s3fs, or a managed S3-backed POSIX filesystem such as Archil. Because the agent reads
  and writes memory through ordinary file tools, mounting any of these at the memory path
  makes the knowledge durable and shared across replicas with no code change. (A custom
  storage backend behind the file tools is the cleaner long-term answer; a mounted POSIX
  filesystem is the lowest-friction one.)
- **The conversation/session transcripts** (the SDK's own session state) would use the
  SDK's `SessionStore` interface, which exists for exactly this: it mirrors session
  transcripts to S3, Redis, or a database so any host can resume them, and the docs name
  "local containers are ephemeral" and "autoscaled workers don't share a filesystem" as
  the motivating cases. The SDK ships reference S3/Redis/Postgres adapters.

One precision worth stating: `SessionStore` persists *conversation transcripts*, not the
agent's knowledge memory. We keep those concerns separate on purpose (durable knowledge
lives in `./memory` and is re-read each session; conversation state is the SDK's session),
so in production they map to two different stores, not one.

### Memory is the filesystem, in Markdown
- Learned knowledge is Markdown under `./memory`, read with Grep/Glob/Read and edited
  with Edit. Chosen over a database or vector store because it is **human-readable and
  diffable** (a reviewer can literally read what the agent learned), it persists across
  sessions for free, and the agent edits it with the same tools it already has, which is
  exactly what current frontier models are most reliable at: POSIX-style file tools
  (Read/Grep/Glob/Edit) are the substrate Claude Code and Anthropic's own file-based
  memory tool are built on, so a Markdown filesystem plays to the model's strengths
  instead of fighting them. At this scale a query engine is unnecessary; a small
  always-read `INDEX.md` manifest plus per-API files keeps the always-on context small
  and avoids context rot.
- **Fresh sessions work because knowledge is on disk, not SDK session resume.** Each
  process reads `INDEX.md` first, then the relevant `integration.md` + customer
  `profile.md`. That is the whole "stays fixed" guarantee: a new process behaves like
  the last one because it re-reads the same files.

### No hardcoding (the graded constraint)
- Nothing about a specific API appears in code, prompts, tools, or seed memory. A
  `npm run nohardcode` grep over `src` + the seed `INDEX.md` enforces it. The committed
  memory ships as a generic seed; the populated `driver-applications` memory is produced
  entirely at runtime from the pasted docs.

### Pluggable transport (REST + GraphQL in scope; gRPC seam)
- Transport is not assumed to be HTTP. Three thin tools (`http_request`,
  `graphql_request`, `grpc_request`) sit behind adapters that all normalize to one
  envelope `{ ok, transport, status, body, error, meta }`. REST and GraphQL are fully
  implemented (GraphQL applies the subtle rule that a 200 response carrying
  `errors[]` is a failure). gRPC is a recognized-and-stubbed seam: ingestion can detect
  it, but the executor honestly declines in v0 (no proto/reflection runtime, and no test
  target). Transport is detected at ingestion and recorded in the learned config; the
  agent selects the matching tool from memory.

### Multi-tenant scoping
- Corrections default to the **customer's** `profile.md` (narrow blast radius). They are
  promoted to the integration-wide `integration.md` only when the fact is clearly
  contract-level or corroborated across customers. This is exactly the brief's rule:
  per-customer quirks stay scoped; contract facts carry across both. It showed up
  concretely: the API's status codes are per-customer (`H/O/N/R` for one tenant,
  `HIR/SCR/APP/...` for the other), so those live in the customer profiles, while the
  pagination/response-shape behavior is integration-wide.

### Teaching: the `/teach` affordance vs. the ingestion trigger

Worth making explicit for anyone reading the code: `/teach` is a CLI input convenience,
not the thing that runs ingestion.

`/teach … /end` lives entirely in the CLI input loop (`src/index.ts`). It collects every
line the operator pastes between the two markers into one buffer and delivers it to the
agent as a single message ("Here is a new system I want you to use. Learn it: …"). It
exists only because the CLI reads stdin line by line, so a raw multi-line paste would
otherwise arrive as one turn per line and fragment the spec. `/teach` itself calls no tool
and runs no pipeline.

What actually runs ingestion is the **agent**: the system prompt tells it that when the
operator pastes something that looks like API documentation, it should call the
`ingest_spec` tool with the full text, and that tool's handler runs the
draft → probe → synthesize pipeline. The trigger is the agent recognizing the content as
docs, which is decoupled from the `/teach` token.

So ingestion is **not gated on `/teach`**. It also fires when a spec arrives as a single
coherent message (a short spec, a bracketed terminal paste, or piped input), or when the
operator just asks in plain language to learn an API and includes the docs; and
`ingest_spec` is an ordinary tool that can be invoked programmatically. The only reason to
use `/teach` is the multi-line-paste fragmentation above, which a production CLI would
instead handle with bracketed-paste detection so the fence is optional.

### First-contact probing
- When a spec is pasted, `ingest_spec` runs a deterministic pipeline: an extraction
  step drafts a config; the handler writes draft memory; a small fan-out of **read-only
  prober** `query()`s investigates the live API; a synthesis step reconciles findings
  into memory and logs spec-vs-reality deltas to `corrections.md`.
- **Probers are read-only and non-destructive.** A prober-scoped check classifies each
  transport call: reads run automatically; any potentially-destructive write is gated
  behind operator permission via `canUseTool` (grounded in the SDK's user-input flow),
  defaulting to deny when non-interactive. So probing never mutates vendor state unless
  the operator approves.
- **Prober prompts are generic.** They state the investigation goal ("determine whether
  a single request returns the complete set or a subset") without naming the answer
  (no "look for `next_cursor`", no "codes vs words"), so the probers discover behavior
  unbiased rather than being led to it.
- **The handler/synth is the single memory writer.** Probers return findings JSON and
  never touch memory, which removes write races and routes all writes through one
  guarded path.

### Triggered self-correction, and why it moved out of a PostToolUse hook
- Self-correction is **triggered and deterministic**, not left to model discretion and
  not a cron job: it must fire in the same turn, before the operator sees the answer,
  and it must not depend on the model remembering to be suspicious.
- It was originally designed as a `PostToolUse`/`PostToolUseFailure` **hook** on the
  transport tools. Testing showed that does not work cleanly: the SDK does not pass a
  tool's structured result to hooks. On success the hook receives only `tool_response`
  (the result re-serialized as a JSON *string*); on failure it receives just `error` +
  the tool input, with no result at all. Recovering the structured envelope from a
  hook was therefore unreliable (and silently produced zero corrections at first).
- So self-correction **moved into the transport tool itself** (`runTransport`). The
  handler already holds both the live envelope and the learned config, so it runs the
  structural check (`correction/evaluate.ts`) and appends a `[SELF-CORRECTION SIGNAL]`
  directly to the result the model reads. This removed the dependency on hook field
  names, the need to re-parse a stringified result, and the question of whether hooks
  fire for in-process MCP tools at all. The tool now returns `isError: false` always
  (the call completed; the envelope's `ok` describes the outcome) and the unused
  `structuredContent` was dropped.
- The check fires **only on successful responses** that contradict learned config: an
  unknown value at the learned enum field (contradiction), a missing always-present
  field, or an unexpected status code (possible). Failures are deliberately not flagged
  because a failed call is already visible to the agent in the envelope and is often
  expected (a 404 for a missing id), so flagging it would be a false positive that
  pollutes memory. Semantic "this looks wrong even though it succeeded" judgement and
  operator pushback are handled by the system prompt, layered on top of this
  deterministic trigger.

### Hermetic build
- The agent runs with `strictMcpConfig: true` + an explicit `tools` whitelist +
  `settingSources: []`, so it sees only our transport/ingest servers and a tight
  built-in set. Without this, the spawned agent inherited the host machine's globally
  configured MCP servers and tools, which both broke reproducibility and confused the
  model. `bypassPermissions` keeps a non-technical operator from seeing tool prompts;
  safety comes from the whitelist plus the memory-write guard.

## 5. How it handles being wrong (a walked example)

The Driver Applications API's docs are wrong in several ways, and the agent finds this
out by probing rather than trusting the spec. None of it is hardcoded; these are the
deltas it discovered and wrote to `corrections.md`:

- The list endpoint returns `{ data: [...], next_cursor }`, not the documented bare
  array, and is paginated at 20 per page, so a naive count reads far too low. The agent
  learns to page to a true total.
- The `?status` filter is silently ignored and returns the full list, so the agent
  learns to filter by status client-side.
- The status values are per-customer codes (`H`, `O`, ...) not the documented words
  (`hired`, ...), with a separate human-readable label field.
- `created_at` is an import date for hired records, not the application date; the real
  date is an undocumented per-customer field.

A second, reactive example on a write: adding an applicant returns HTTP **201**, which
is outside the learned `expectedStatusCodes: [200]`. The in-tool check appended a
self-correction signal; the agent investigated, logged a `corrections.md` entry, and
updated the config's `expectedStatusCodes` to `[200, 201]`, so it will not re-flag.
Across a process restart the corrected files drive correct answers on the first try.

## 6. What I cut and why

- **gRPC beyond a stub.** REST and GraphQL are in scope; the sandbox is REST-only and
  gRPC needs proto tooling and a test target, so it is a documented seam, not an impl.
- **Automated end-to-end test harness (`test/validate.ts`) is minimal.** Verification
  was done by driving the live CLI and checking memory + ground truth, rather than a
  full assertion suite, given the time budget.
- **Write-probing during ingestion** stays off by default (read-only); the write
  contracts are learned the first time the operator asks for an action.
- **Concurrency/locking on memory files** is out of scope (single operator, v0).

## 7. Cost and token usage

Cost is read from each `query()`'s `total_cost_usd` and accumulated in one shared meter;
ingestion's nested-query cost (draft + probers + synth) is folded into the same total so
the on-screen figure is honest. Rough figures (vary with model and pagination depth):

- A full **teach** (draft + 3 parallel probers + synthesis) is the expensive,
  one-time-per-API step: roughly **$1–2**.
- Steady-state **questions** are cheap: roughly **$0.04 for a point lookup**, up to
  **~$0.5–0.7** for a question that pages the entire dataset (the observed teach run
  cost ~$1.84 for ingestion and ~$0.55 for the follow-up "count all of acme").
- Prompt caching matters a lot: repeat turns read hundreds of thousands of cached tokens
  at ~0.1x, so the loaded memory + system prompt are nearly free on subsequent turns.
- Lever: probers run on a cheaper model than the main loop (`AUTOINTEGRATE_PROBE_MODEL`,
  default Sonnet) since discovery tolerates it.

## 8. Limitations and what I would do next

- The deterministic trigger catches structural contradictions on success; genuinely
  unexpected *failures* (a documented endpoint that suddenly 404s) currently rely on the
  agent's semantic judgement, not the deterministic check. A narrow rule could
  distinguish "expected lookup miss" from "endpoint contradicts learned config."
- **Memory architecture.** The filesystem substrate is deliberately simple and the right
  starting point (models are strongest at file tools, and it is transparent and free to
  persist), but it has real limits: retrieval is exact or regex match via grep and glob,
  not semantic; and conflict handling is shallow. A correction edits the live file and is
  logged append-only, but there is no rigorous mechanism to detect when a new correction
  contradicts an older recorded one and supersede it so the memory stays internally
  consistent and current. The 2026 consensus direction is hybrid: keep the self-correcting
  filesystem as the human-readable substrate, add a vector index for semantic retrieval
  (surface relevant prior learnings without exact keyword matches), and add a temporal
  knowledge graph (the Graphiti/Zep approach, where each fact is a node or edge carrying
  bi-temporal validity intervals) so contradictory corrections invalidate rather than
  blindly overwrite prior facts, leaving the store reflecting the latest true state with
  an auditable history. That three-way hybrid (files for transparency, vectors for
  semantic recall, a temporal graph for relationships and conflict resolution) is what I
  would build next; Zep/Graphiti and mem0 are the current reference points.
- No auth/rate-limit/retry handling on the transport layer beyond what the vendor needs
  here; `auth.valueRef` reads a secret from an env var but is otherwise untested.
- gRPC is unexercised; GraphQL is implemented but verified only against a public endpoint
  since the sandbox is REST.
- A proper validation suite and a multi-tenant non-leak regression test would be next.

## 9. Bugs found during testing (and fixed)

These are recorded because the brief asks how the system behaves under surprise, and the
same surprises apply to building it:

- **Host config leaked into the agent.** `settingSources: []` alone did not stop the
  machine's global MCP servers/tools from loading; fixed with `strictMcpConfig` + a
  `tools` whitelist.
- **Probers intermittently could not reach the transport server** when sharing one
  in-process MCP instance across parallel nested sessions; fixed with a per-`query()`
  server factory.
- **The synthesis agent fabricated a spurious correction** by reading the run trace and
  misreading it; fixed by restricting it to the findings JSON and forbidding it from
  reading `./runs` or narrating the probe mechanism.
- **The self-correction hook silently never fired** because the SDK delivers tool
  results to hooks as a stringified `tool_response`, not the structured object; fixed by
  moving the check into the tool (see §4).
- **Failures were briefly flagged as contradictions**, which would have logged a bogus
  correction for an ordinary 404; fixed by only flagging successful-but-wrong responses.
