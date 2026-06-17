// Helpers for ingestion: run a one-shot query() and collect its final text + cost,
// and pull a JSON object out of an agent's (possibly fenced) text response.

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

export async function runOneShot(
  prompt: string,
  options: Options,
): Promise<{ text: string; costUsd: number }> {
  let text = "";
  let costUsd = 0;
  for await (const msg of query({ prompt, options })) {
    const m: any = msg;
    if (m.type === "result") {
      costUsd += m.total_cost_usd ?? 0;
      if (typeof m.result === "string" && m.result.length) text = m.result;
    } else if (m.type === "assistant") {
      // Fallback: capture the last text block in case result.result is absent.
      const blocks = m.message?.content ?? [];
      for (const b of blocks) {
        if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) text = b.text;
      }
    }
  }
  return { text, costUsd };
}

export function parseJsonBlock(text: string): any | null {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const candidate = (fence ? fence[1] : text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    // fall through to a bracket scan
  }
  const start = candidate.search(/[{[]/);
  if (start >= 0) {
    for (let end = candidate.length; end > start; end--) {
      const slice = candidate.slice(start, end);
      if (!/[}\]]$/.test(slice)) continue;
      try {
        return JSON.parse(slice);
      } catch {
        // keep shrinking
      }
    }
  }
  return null;
}
