// gRPC adapter seam. The transport abstraction recognizes gRPC and routes here,
// but the executor honestly declines in v0 (no proto/reflection runtime). Ingestion
// can still record that an API is gRPC; calls return a clear not-implemented envelope.

import type { TransportAdapter, TransportEnvelope, TransportRequest, ActiveApiConfig } from "./types.js";

export const grpcAdapter: TransportAdapter = {
  kind: "grpc",
  async execute(req: TransportRequest, cfg: ActiveApiConfig): Promise<TransportEnvelope> {
    return {
      ok: false,
      transport: "grpc",
      status: null,
      body: null,
      error: {
        kind: "not_implemented",
        message:
          "gRPC transport is recognized but not executable in v0. The service/RPC was parsed; wire a proto-loader/reflection client to enable it.",
      },
      meta: {
        durationMs: 0,
        requestSummary: `${req.service ?? ""}/${req.rpc ?? ""}`,
        apiSlug: cfg.apiSlug,
        customerSlug: req.customerSlug ?? null,
      },
    };
  },
};
