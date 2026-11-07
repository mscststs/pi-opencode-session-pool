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
  /** Absolute chat-completions URL. */
  url: string;
  /** Bearer token used for probe requests. Never persisted. */
  apiKey: string;
  /** Extra provider headers (auth overrides, attribution, ...). Never persisted. */
  headers?: Record<string, string>;
}

/**
 * One **spare** verified id sitting in the pool, waiting to be taken.
 *
 * The pool never recycles ids: when a conversation takes an entry the entry
 * leaves `entries` and becomes part of a {@link Binding}. When that
 * conversation is gone the id is retired, not returned.
 */
export interface PoolEntry {
  id: string;
  provider: string;
  model: string;
  /** `server-timing: upstream;dur=...` from the verification probe. */
  upstreamMs: number;
  /** Epoch millis of the verification probe. */
  verifiedAt: number;
  /** Epoch millis the id was accepted into the pool. */
  createdAt: number;
}

/**
 * A routed id owned by exactly one conversation.
 *
 * The key is `piSessionId|provider|model`, so switching model mid-conversation
 * gets its own (still exclusive) routed id. The binding carries its own
 * measurements: it is the only record of the id once it leaves the pool.
 */
export interface Binding {
  routedId: string;
  provider: string;
  model: string;
  boundAt: number;
  /** Refreshed by every real response; drives lease expiry. */
  lastSeenAt: number;
  /** Last `upstream;dur` observed on a real request. */
  upstreamMs: number;
  /** Epoch millis of the last real observation. */
  verifiedAt: number;
  /** Consecutive degraded observations. */
  failures: number;
}

/**
 * On-disk pool state. Contains no secrets and no base URLs.
 *
 * Invariants:
 *  - `entries` holds only unowned (spare) ids.
 *  - every `bindings[*].routedId` is absent from `entries`.
 *  - an id is never handed to a second conversation.
 */
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
  /** Response `id` (`gw-...` for OpenCode's workers, `chatcmpl-...` for the overloaded relay). */
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
