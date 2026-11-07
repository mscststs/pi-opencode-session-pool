/**
 * Shared types for pi-opencode-session-pool.
 *
 * Everything in `lib/` is deliberately free of `@earendil-works/pi-*` imports so
 * the routing logic can be unit-tested with plain `node --test`. The extension
 * entry point adapts pi's runtime objects to these shapes.
 */

/**
 * The subset of a pi model the pool needs.
 *
 * `provider`/`baseUrl`/`api` decide whether the model is routed by OpenCode's
 * `x-opencode-session` gateway; `id` is the model name used for probe requests.
 */
export interface ModelLike {
  id: string;
  provider: string;
  api: string;
  baseUrl: string;
}

/** A resolved, ready-to-probe OpenCode target. */
export interface ProbeTarget {
  /** pi provider id, e.g. `opencode` or `opencode-go`. */
  provider: string;
  /** Model id, e.g. `deepseek-v4.1-flash`. */
  model: string;
  /** Absolute chat-completions URL, e.g. `https://opencode.ai/inference/go/openai/v1/chat/completions`. */
  url: string;
  /** Bearer token used for probe requests. Never persisted. */
  apiKey: string;
  /** Extra provider headers (auth overrides, attribution, ...). Never persisted. */
  headers?: Record<string, string>;
}

/**
 * A session id that was measured to be fast.
 *
 * Entries are scoped to a `provider|model` pair because the upstream a session
 * id maps to can differ per model. `upstreamMs`/`verifiedAt` describe the most
 * recent successful measurement.
 */
export interface PoolEntry {
  id: string;
  provider: string;
  model: string;
  /** `server-timing: upstream;dur=...` from the last measurement. */
  upstreamMs: number;
  /** Epoch millis of the last successful measurement. */
  verifiedAt: number;
  /** Epoch millis the id was first accepted into the pool. */
  createdAt: number;
  /** Consecutive slow/overloaded observations; quarantine at `quarantineFailures`. */
  failures: number;
}

/**
 * Sticky mapping from a pi conversation to one pooled session id.
 *
 * The key is `piSessionId|provider|model`, so switching model mid-conversation
 * gets its own (still sticky) routed id.
 */
export interface Binding {
  routedId: string;
  provider: string;
  model: string;
  boundAt: number;
  /** Refreshed on every acquire, used for lease expiry. */
  lastSeenAt: number;
}

/** On-disk pool state. Contains no secrets and no base URLs. */
export interface PoolState {
  version: 1;
  entries: PoolEntry[];
  bindings: Record<string, Binding>;
}

/** Parsed `server-timing` response header. */
export interface ServerTiming {
  gatewayMs?: number;
  upstreamMs?: number;
  totalMs?: number;
}

/** Outcome of one probe request. */
export interface ProbeResult {
  /** True when the id routed to a fast upstream. */
  fast: boolean;
  /** HTTP status, or `0` when the request never produced a response. */
  status: number;
  upstreamMs?: number;
  gatewayMs?: number;
  /** Response `id` (`gw-...` for OpenCode's own workers, `chatcmpl-...` for the slow relay). */
  bodyId?: string;
  /** Machine-readable reason, used for debug logs. */
  reason: ProbeReason;
  /** `retry-after-ms` / `Retry-After` when the gateway asked us to back off. */
  retryAfterMs?: number;
}

export type ProbeReason =
  | "fast"
  | "slow"
  | "gateway-id-mismatch"
  | "timeout"
  | "overloaded"
  | "unauthorized"
  | "rejected"
  | "http-error"
  | "network-error";
