// Per-transport structural checks. Given a normalized envelope and the learned
// config, decide whether the result deterministically contradicts what we believe.
// These are the HARD/STRUCTURAL triggers; semantic "this looks wrong" judgement is
// the agent's own job (driven by the system prompt) and operator pushback.

import type { ActiveApiConfig, TransportEnvelope } from "../transport/types.js";

export interface Finding {
  severity: "contradiction" | "possible";
  summary: string;
}

function getPath(obj: any, path: string): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  return path.split(".").reduce<any>((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

// Pull record objects out of a body generically: a bare array, the first
// array-of-objects property of an envelope object, or a single record object.
function extractRecords(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return body.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  if (body && typeof body === "object") {
    for (const v of Object.values(body as Record<string, unknown>)) {
      if (Array.isArray(v) && v.some((x) => x && typeof x === "object")) {
        return (v as any[]).filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
      }
    }
    return [body as Record<string, unknown>];
  }
  return [];
}

export function evaluate(env: TransportEnvelope, cfg: ActiveApiConfig | null): Finding | null {
  if (!env) return null;

  // A failed call is already visible to the agent in the envelope (ok:false + error)
  // and is frequently expected (e.g. a 404 for a non-existent id), so we do NOT nag
  // on failures. The hook's deterministic value is catching SUCCESSFUL responses
  // that contradict learned config.
  if (!env.ok) return null;

  if (!cfg) return null;
  const records = extractRecords(env.body);

  // 2) Unexpected HTTP status code (soft: a new-but-valid code like 201 is common).
  if (
    env.transport === "rest" &&
    env.status != null &&
    Array.isArray(cfg.expectedStatusCodes) &&
    cfg.expectedStatusCodes.length > 0 &&
    !cfg.expectedStatusCodes.includes(env.status)
  ) {
    return {
      severity: "possible",
      summary: `HTTP ${env.status} is not in the learned expected status codes [${cfg.expectedStatusCodes.join(", ")}]`,
    };
  }

  // 3) A documented-always-present field is missing.
  if (cfg.alwaysPresentFields?.length && records.length) {
    for (const f of cfg.alwaysPresentFields) {
      if (records.some((r) => !(f in r))) {
        return {
          severity: "possible",
          summary: `field "${f}" is recorded as always-present but is missing from at least one returned record`,
        };
      }
    }
  }

  // 4) The categorical/status field returned a value outside the learned set.
  if (cfg.statusEnum?.length && cfg.enumFieldPath && records.length) {
    const unknown = new Set<string>();
    for (const r of records) {
      const v = getPath(r, cfg.enumFieldPath);
      if (typeof v === "string" && !cfg.statusEnum.includes(v)) unknown.add(v);
    }
    if (unknown.size) {
      return {
        severity: "contradiction",
        summary: `field "${cfg.enumFieldPath}" returned value(s) not in the learned set: ${[...unknown].join(", ")} (known: ${cfg.statusEnum.join(", ")})`,
      };
    }
  }

  return null;
}

// The correction instruction appended to a transport result when a finding fires.
// Names the offending result, the scope rule, and the exact files to update.
export function buildSignal(
  finding: Finding,
  apiSlug: string,
  customerSlug: string | null,
  requestSummary: string,
): string {
  const fileHint = customerSlug
    ? `the customer profile memory/apis/${apiSlug}/customers/${customerSlug}/profile.md (default), or memory/apis/${apiSlug}/integration.md if it holds for every customer`
    : `memory/apis/${apiSlug}/integration.md`;
  const verb = finding.severity === "contradiction" ? "contradicts" : "may not match";
  return (
    `[SELF-CORRECTION SIGNAL] This result ${verb} your learned knowledge: ${finding.summary}. ` +
    `Before answering the operator, investigate the real behavior with additional calls, then record a dated, scope-tagged entry in memory/apis/${apiSlug}/corrections.md and update ${fileHint} ` +
    `(default to the customer scope unless the behavior is clearly contract-level). Then re-attempt with the corrected understanding. [call: ${requestSummary}]`
  );
}
