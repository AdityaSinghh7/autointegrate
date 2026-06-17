// GraphQL adapter. POSTs {query, variables} to the single endpoint and normalizes
// into the envelope. The critical rule: a 200 response carrying a top-level
// errors[] is a FAILURE (ok:false), even though HTTP succeeded.

import type {
  ActiveApiConfig,
  TransportAdapter,
  TransportEnvelope,
  TransportRequest,
} from "./types.js";

export const graphqlAdapter: TransportAdapter = {
  kind: "graphql",
  async execute(req: TransportRequest, cfg: ActiveApiConfig): Promise<TransportEnvelope> {
    const t0 = performance.now();
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(cfg.defaultHeaders ?? {}),
    };
    if (cfg.auth && cfg.auth.mode !== "none") {
      const v = cfg.auth.valueRef ? process.env[cfg.auth.valueRef] : undefined;
      if (v) {
        if (cfg.auth.mode === "bearer") headers["authorization"] = `Bearer ${v}`;
        else if (cfg.auth.mode === "header" && cfg.auth.name) headers[cfg.auth.name] = v;
      }
    }
    const meta = {
      durationMs: 0,
      requestSummary: "graphql",
      apiSlug: cfg.apiSlug,
      customerSlug: req.customerSlug ?? null,
      graphqlErrors: undefined as unknown[] | undefined,
    };

    try {
      const res = await fetch(cfg.baseUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ query: req.gqlQuery ?? "", variables: req.variables ?? {} }),
      });
      const json: any = await res.json().catch(() => null);
      const gqlErrors: unknown[] | undefined = Array.isArray(json?.errors) ? json.errors : undefined;
      const httpOk = res.status >= 200 && res.status < 300;
      const ok = httpOk && !(gqlErrors && gqlErrors.length > 0);
      meta.durationMs = Math.round(performance.now() - t0);
      meta.graphqlErrors = gqlErrors;
      return {
        ok,
        transport: "graphql",
        status: res.status,
        body: json?.data ?? null,
        error: ok
          ? null
          : {
              kind: gqlErrors && gqlErrors.length ? "graphql_errors" : "http_status",
              message: gqlErrors && gqlErrors.length ? "GraphQL response contained errors[]" : `HTTP ${res.status}`,
              detail: gqlErrors ?? json,
            },
        meta,
      };
    } catch (e) {
      meta.durationMs = Math.round(performance.now() - t0);
      return {
        ok: false,
        transport: "graphql",
        status: null,
        body: null,
        error: { kind: "network", message: e instanceof Error ? e.message : String(e) },
        meta,
      };
    }
  },
};
