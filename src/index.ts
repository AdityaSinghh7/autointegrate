// CLI entrypoint: one streaming-input query() session per conversation.
//
// A single readline owns stdin and routes each line to either a pending
// operator-permission prompt (so ingestion probers can ask without fighting for
// stdin) or the operator-turn queue feeding the agent. Pasting a multi-line spec
// is supported via a /teach ... /end block.
//
// Rendering: the main model's text is streamed live; tool activity shows as dim,
// deduplicated one-liners (repeats collapse to progress dots); ingestion/probe
// progress arrives through the reporter while the model is paused on the tool. All
// output goes through w(), which tracks line position so notes always start fresh.

import "./env.js";
import * as readline from "node:readline";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { buildOptions } from "./agent/options.js";
import { costMeter } from "./instrumentation/costMeter.js";
import { createTraceLogger } from "./instrumentation/traceLogger.js";
import { setReporter } from "./reporter.js";
import { setAsker } from "./permissionBroker.js";

const useColor = process.stdout.isTTY ?? false;
const dim = (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s);
const PROMPT = "\n› ";

// Map a tool call to a short, plain-language activity label (or null to stay quiet).
function activityLabel(name: string, input: any): string | null {
  if (typeof name !== "string") return null;
  if (name.startsWith("mcp__ingest__")) return "learning the API";
  if (name.startsWith("mcp__transport__")) return "calling the API";
  if (name === "Edit" || name === "Write") {
    if (String(input?.file_path ?? "").includes("/memory/")) return "updating memory";
    return null;
  }
  if (name === "Read" || name === "Grep" || name === "Glob") return "reading memory";
  return null;
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin });
  const trace = createTraceLogger();

  // --- single-readline line router ---
  const lineQueue: string[] = [];
  let lineWaiter: ((v: string | null) => void) | null = null;
  let pendingPermission: ((line: string) => void) | null = null;
  let closed = false;

  rl.on("line", (raw) => {
    if (pendingPermission) {
      const r = pendingPermission;
      pendingPermission = null;
      r(raw);
      return;
    }
    if (lineWaiter) {
      const w2 = lineWaiter;
      lineWaiter = null;
      w2(raw);
    } else {
      lineQueue.push(raw);
    }
  });
  rl.on("close", () => {
    closed = true;
    if (pendingPermission) {
      const r = pendingPermission;
      pendingPermission = null;
      r("");
    }
    if (lineWaiter) {
      const w2 = lineWaiter;
      lineWaiter = null;
      w2(null);
    }
  });

  function nextLine(): Promise<string | null> {
    if (lineQueue.length) return Promise.resolve(lineQueue.shift()!);
    if (closed) return Promise.resolve(null);
    return new Promise((res) => {
      lineWaiter = res;
    });
  }

  // --- output helpers (track line position so notes/progress start on a fresh line) ---
  let noteOpen = false; // currently on a "· activity …" line
  let lastNote: string | null = null;
  let atLineStart = true;
  const w = (s: string) => {
    if (!s) return;
    process.stdout.write(s);
    atLineStart = s.endsWith("\n");
  };
  const freshLine = () => {
    if (!atLineStart) w("\n");
  };
  const endNote = () => {
    if (noteOpen) {
      w("\n");
      noteOpen = false;
    }
  };

  // Progress from ingestion/probers (the model is paused on the tool, so stdout is free).
  setReporter((line) => {
    endNote();
    freshLine();
    w(dim(`   ${line}`) + "\n");
  });

  // Operator-permission prompts, routed through the single readline.
  setAsker(
    (question: string) =>
      new Promise<boolean>((resolve) => {
        if (closed) {
          resolve(false);
          return;
        }
        endNote();
        freshLine();
        w(`${question} [y/N]: `);
        pendingPermission = (line) => resolve(line.trim().toLowerCase().startsWith("y"));
      }),
  );

  async function* operatorTurns(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      const line = await nextLine();
      if (line === null) return;
      const text = line.trim();
      if (text === "/exit") return;

      if (text === "/teach" || text === "/paste") {
        const buf: string[] = [];
        while (true) {
          const l = await nextLine();
          if (l === null) break;
          if (l.trim() === "/end") break;
          buf.push(l);
        }
        const content = buf.join("\n").trim();
        if (content) {
          yield {
            type: "user",
            message: { role: "user", content: `Here is a new system I want you to use. Learn it:\n\n${content}` },
            parent_tool_use_id: null,
          } as SDKUserMessage;
        }
        continue;
      }

      if (text.length === 0) continue;
      yield {
        type: "user",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
      } as SDKUserMessage;
    }
  }

  w(
    bold("Autointegrate") +
      " — teach an API by pasting its docs between /teach and /end, or just ask in plain language. /exit to quit." +
      PROMPT,
  );

  const q = query({ prompt: operatorTurns(), options: buildOptions() });

  let interruptedOnce = false;
  process.on("SIGINT", () => {
    if (interruptedOnce) process.exit(0);
    interruptedOnce = true;
    endNote();
    freshLine();
    w("(^C again to force-quit, or type /exit)" + PROMPT);
    try {
      (q as any).interrupt?.();
    } catch {
      /* ignore */
    }
  });

  for await (const msg of q) {
    const m: any = msg;
    trace.log(msg);

    if (m.type === "stream_event") {
      const ev = m.event;
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        endNote();
        w(ev.delta.text);
      }
    } else if (m.type === "assistant") {
      for (const b of m.message?.content ?? []) {
        if (b?.type !== "tool_use") continue;
        const note = activityLabel(b.name, b.input);
        if (!note) continue;
        if (noteOpen && note === lastNote) {
          w(dim("·")); // repeat -> progress dot
        } else {
          endNote();
          freshLine();
          w(dim(`   · ${note} `));
          noteOpen = true;
          lastNote = note;
        }
      }
    } else if (m.type === "result") {
      costMeter.add(m);
      endNote();
      freshLine();
      w("\n" + dim(`   [${costMeter.statusLine()}]`) + PROMPT);
      lastNote = null;
      interruptedOnce = false;
    }
  }

  endNote();
  rl.close();
  w("\n" + dim(`Goodbye. Session cost: $${costMeter.totalUsd.toFixed(4)}. Trace: ${trace.path}`) + "\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
