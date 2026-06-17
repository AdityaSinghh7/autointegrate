// REST adapter. Maps a generic {method, path, query, body, headers} request onto
// the learned base URL + auth, and normalizes the response into a TransportEnvelope.

import type {
  ActiveApiConfig,
  AuthConfig,
  TransportAdapter,
  TransportEnvelope,
  TransportRequest,
} from "./types.js";

function applyAuth(
  headers: Record<string, string>,
  query: Record<string, string>,
  auth?: AuthConfig,
): void {
  if (!auth || auth.mode === "none") return;
  const value = auth.valueRef ? process.env[auth.valueRef] : undefined;
  if (!value) return; // learned APIs may be open; proceed unauthenticated
  if (auth.mode === "bearer") headers["authorization"] = `Bearer ${value}`;
  else if (auth.mode === "header" && auth.name) headers[auth.name] = value;
  else if (auth.mode === "query" && auth.name) query[auth.name] = value;
}

function buildUrl(
  baseUrl: string,
  path: string | undefined,
  query: TransportRequest["query"],
  extraQuery: Record<string, string>,
): string {
  const base = baseUrl.replace(/\/+$/, "");
  const p = path ? (path.startsWith("/") ? path : `/${path}`) : "";
  const url = new URL(base + p);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  for (const [k, v] of Object.entries(extraQuery)) url.searchParams.set(k, v);
  return url.toString();
}

function looksJson(s: string): boolean {
  const t = s.trimStart();
  return t.startsWith("{") || t.startsWith("[");
}

export const restAdapter: TransportAdapter = {
  kind: "rest",
  async execute(req: TransportRequest, cfg: ActiveApiConfig): Promise<TransportEnvelope> {
    const t0 = performance.now();
    const method = (req.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = { ...(cfg.defaultHeaders ?? {}), ...(req.headers ?? {}) };
    const extraQuery: Record<string, string> = {};
    applyAuth(headers, extraQuery, cfg.auth);
    const url = buildUrl(cfg.baseUrl, req.path, req.query, extraQuery);
    const summary = `${method} ${req.path ?? ""}`.trim();

    let bodyInit: string | undefined;
    if (req.body !== undefined && method !== "GET" && method !== "HEAD") {
      bodyInit = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
        headers["content-type"] = "application/json";
      }
    }

    const meta = {
      durationMs: 0,
      requestSummary: summary,
      apiSlug: cfg.apiSlug,
      customerSlug: req.customerSlug ?? null,
    };

    try {
      const res = await fetch(url, { method, headers, body: bodyInit });
      const text = await res.text();
      let parsed: unknown = text;
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("json") || looksJson(text)) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      const ok = res.status >= 200 && res.status < 300;
      meta.durationMs = Math.round(performance.now() - t0);
      return {
        ok,
        transport: "rest",
        status: res.status,
        body: ok ? parsed : null,
        error: ok ? null : { kind: "http_status", message: `HTTP ${res.status}`, detail: parsed },
        meta,
      };
    } catch (e) {
      meta.durationMs = Math.round(performance.now() - t0);
      return {
        ok: false,
        transport: "rest",
        status: null,
        body: null,
        error: { kind: "network", message: e instanceof Error ? e.message : String(e) },
        meta,
      };
    }
  },
};
