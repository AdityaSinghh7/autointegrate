// Writes an uncurated JSONL log of every SDK message to ./runs/<timestamp>.jsonl.
// This is our equivalent of an exported session log (the brief's trace deliverable).

import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { resolve } from "node:path";

export interface TraceLogger {
  log(msg: unknown): void;
  path: string;
}

export function createTraceLogger(): TraceLogger {
  const dir = resolve(process.cwd(), "runs");
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const path = resolve(dir, `${ts}.jsonl`);
  const stream: WriteStream = createWriteStream(path, { flags: "a" });
  return {
    path,
    log(msg: unknown): void {
      try {
        stream.write(JSON.stringify(msg) + "\n");
      } catch {
        // best-effort tracing; never crash the agent over a log write
      }
    },
  };
}
