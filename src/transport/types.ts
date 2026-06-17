// The transport contract. Every adapter returns a TransportEnvelope; the
// correction hook (Phase 3) reads exactly these fields. Connection details come
// from the learned ## Config block (ActiveApiConfig), never from code.

export type TransportKind = "rest" | "graphql" | "grpc";

export interface TransportError {
  kind: "http_status" | "graphql_errors" | "network" | "not_implemented" | "bad_input";
  message: string;
  detail?: unknown;
}

export interface TransportEnvelope {
  ok: boolean;
  transport: TransportKind;
  status: number | null;
  body: unknown;
  error: TransportError | null;
  meta: {
    durationMs: number;
    requestSummary: string;
    apiSlug: string | null;
    customerSlug: string | null;
    graphqlErrors?: unknown[];
  };
}

export interface AuthConfig {
  mode: "none" | "header" | "bearer" | "query";
  name?: string; // header or query-param name (for "header"/"query")
  valueRef?: string; // env var name holding the secret; never the secret itself
}

export interface ActiveApiConfig {
  apiSlug: string;
  transport: TransportKind;
  baseUrl: string;
  auth?: AuthConfig;
  defaultHeaders?: Record<string, string>;
  pathTemplates?: Record<string, string>;
  // Learned hints the correction hook uses (populated from spec + probing, not code):
  statusEnum?: string[];
  enumFieldPath?: string;
  alwaysPresentFields?: string[];
  expectedStatusCodes?: number[];
}

export interface TransportRequest {
  // REST
  method?: string;
  path?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  // GraphQL
  gqlQuery?: string;
  variables?: Record<string, unknown>;
  // gRPC (seam)
  service?: string;
  rpc?: string;
  message?: unknown;
  // common
  customerSlug?: string;
}

export interface TransportAdapter {
  kind: TransportKind;
  execute(req: TransportRequest, cfg: ActiveApiConfig): Promise<TransportEnvelope>;
}
