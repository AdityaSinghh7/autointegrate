// The single in-process MCP server "transport" exposing three thin tools. The
// agent picks the tool matching the learned transport; runTransport resolves the
// active config from memory, guards against a transport mismatch, calls the
// adapter, and returns the normalized envelope (also in structuredContent so the
// correction hook can read it directly).

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { resolveActiveConfig } from "../transport/config.js";
import { restAdapter } from "../transport/rest.js";
import { graphqlAdapter } from "../transport/graphql.js";
import { grpcAdapter } from "../transport/grpc.js";
import type {
  ActiveApiConfig,
  TransportAdapter,
  TransportEnvelope,
  TransportKind,
  TransportRequest,
} from "../transport/types.js";
import { evaluate, buildSignal } from "../correction/evaluate.js";

const adapters: Record<TransportKind, TransportAdapter> = {
  rest: restAdapter,
  graphql: graphqlAdapter,
  grpc: grpcAdapter,
};

async function runTransport(
  kind: TransportKind,
  req: TransportRequest,
  apiSlug?: string,
  customerSlug?: string,
) {
  let envelope: TransportEnvelope;
  let cfg: ActiveApiConfig | null = null;
  try {
    cfg = await resolveActiveConfig(apiSlug, customerSlug);
    if (cfg.transport !== kind) {
      envelope = {
        ok: false,
        transport: kind,
        status: null,
        body: null,
        error: {
          kind: "bad_input",
          message: `Active API "${cfg.apiSlug}" uses transport "${cfg.transport}", not "${kind}". Use the ${cfg.transport}_request tool.`,
        },
        meta: { durationMs: 0, requestSummary: kind, apiSlug: cfg.apiSlug, customerSlug: customerSlug ?? null },
      };
    } else {
      envelope = await adapters[kind].execute({ ...req, customerSlug }, cfg);
    }
  } catch (e) {
    envelope = {
      ok: false,
      transport: kind,
      status: null,
      body: null,
      error: { kind: "bad_input", message: e instanceof Error ? e.message : String(e) },
      meta: { durationMs: 0, requestSummary: kind, apiSlug: apiSlug ?? null, customerSlug: customerSlug ?? null },
    };
  }

  // Triggered self-correction lives HERE in the tool, not in a PostToolUse hook:
  // the handler already holds both the live envelope and the learned config, so it
  // appends a correction signal directly to the result the model reads. (Hooks only
  // receive the result as a re-serialized `tool_response` string, never the
  // structured envelope, which made this unreliable from a hook.)
  const finding = evaluate(envelope, cfg);
  let text = JSON.stringify(envelope);
  if (finding) {
    const slug = cfg?.apiSlug ?? apiSlug ?? "the active API";
    text += "\n\n" + buildSignal(finding, slug, customerSlug ?? null, envelope.meta.requestSummary);
    if (process.env.AUTOINTEGRATE_DEBUG_HOOK) {
      process.stderr.write(`[selfCorrect] ${finding.severity}: ${finding.summary}\n`);
    }
  }

  return {
    content: [{ type: "text" as const, text }],
    isError: false,
  };
}

const httpTool = tool(
  "http_request",
  "Execute one REST/HTTP request against the active learned API. Base URL, auth, and default headers come from learned memory config; provide method + path (with any path placeholders already filled).",
  {
    method: z.string().describe("HTTP method, e.g. GET, POST, PATCH, DELETE"),
    path: z.string().describe("Path appended to the learned base URL, e.g. /things or /things/123"),
    query: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional()
      .describe("Query-string parameters"),
    body: z.unknown().optional().describe("Request body (JSON-serializable) for writes"),
    headers: z.record(z.string(), z.string()).optional().describe("Extra request headers"),
    apiSlug: z.string().optional().describe("Which learned API to call; omit if only one is known"),
    customerSlug: z.string().optional().describe("Tenant/customer context, if the call is customer-specific"),
  },
  async (a) =>
    runTransport(
      "rest",
      { method: a.method, path: a.path, query: a.query, body: a.body, headers: a.headers },
      a.apiSlug,
      a.customerSlug,
    ),
);

const graphqlTool = tool(
  "graphql_request",
  "Execute one GraphQL operation (query or mutation) against the active learned API's single endpoint.",
  {
    query: z.string().describe("GraphQL query or mutation document"),
    variables: z.record(z.string(), z.unknown()).optional().describe("Operation variables"),
    apiSlug: z.string().optional().describe("Which learned API to call; omit if only one is known"),
    customerSlug: z.string().optional().describe("Tenant/customer context, if the call is customer-specific"),
  },
  async (a) =>
    runTransport(
      "graphql",
      { gqlQuery: a.query, variables: a.variables },
      a.apiSlug,
      a.customerSlug,
    ),
);

const grpcTool = tool(
  "grpc_request",
  "Execute one gRPC call against the active learned API (v0: returns a not-implemented envelope).",
  {
    service: z.string().describe("Fully-qualified gRPC service name"),
    rpc: z.string().describe("RPC method name"),
    message: z.unknown().optional().describe("Request message payload"),
    apiSlug: z.string().optional().describe("Which learned API to call; omit if only one is known"),
    customerSlug: z.string().optional().describe("Tenant/customer context, if the call is customer-specific"),
  },
  async (a) =>
    runTransport(
      "grpc",
      { service: a.service, rpc: a.rpc, message: a.message },
      a.apiSlug,
      a.customerSlug,
    ),
);

export const TRANSPORT_SERVER_NAME = "transport";

// Factory: build a FRESH in-process MCP server per query() session. Sharing one
// instance across concurrent/nested sessions (main agent + parallel probers) can
// leave some sessions unable to connect to it, so each query gets its own.
export function makeTransportServer() {
  return createSdkMcpServer({
    name: TRANSPORT_SERVER_NAME,
    version: "0.1.0",
    tools: [httpTool, graphqlTool, grpcTool],
  });
}
