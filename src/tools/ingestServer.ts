// The "ingest" MCP server (separate from "transport" so the Phase 3 correction
// hook, which matches mcp__transport__.*, never fires on ingestion). Exposes the
// ingest_spec tool the agent calls when the operator pastes API documentation.

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { runIngestion } from "../ingest/runIngestion.js";

const ingestTool = tool(
  "ingest_spec",
  "Ingest pasted API documentation: detect the transport, draft a config, probe the live API to learn its real behavior, and write everything to memory. Call this when the operator pastes API docs to teach a new system.",
  {
    spec: z.string().describe("The full pasted API documentation / spec text"),
    customers: z
      .array(z.string())
      .optional()
      .describe("Known customer/tenant names, if the operator named any"),
  },
  async (a) => {
    try {
      const summary = await runIngestion(a.spec, a.customers);
      return { content: [{ type: "text" as const, text: summary }] };
    } catch (e) {
      return {
        content: [
          { type: "text" as const, text: `Ingestion failed: ${e instanceof Error ? e.message : String(e)}` },
        ],
        isError: true,
      };
    }
  },
);

export const INGEST_SERVER_NAME = "ingest";

export const ingestServer = createSdkMcpServer({
  name: INGEST_SERVER_NAME,
  version: "0.1.0",
  tools: [ingestTool],
});
