/**
 * Configuration for pi-opencode-session-pool.
 *
 * All knobs are environment variables, matching the sibling extensions in this
 * repo (`pi-provider-gzip`). The single master switch is `PI_OCPOOL`.
 *
 * The defaults are chosen so that the extension is useful out of the box:
 * a small pool, a short probe timeout (slow ids take tens of seconds, so there
 * is no reason to wait for them), and a startup budget that keeps `pi` from
 * feeling stuck on first launch.
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** How many verified-fast ids to keep warm per provider+model pair. */
export const DEFAULT_POOL_SIZE = 3;

/** A pooled id older than this is re-verified before reuse. */
export const DEFAULT_TTL_MS = 30 * 60_000;

/** An upstream slower than this is not considered "fast". */
export const DEFAULT_MAX_UPSTREAM_MS = 2_500;

/** Abort a probe after this long: anything slower is already disqualified. */
export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

/** Max time `session_start` may spend filling the pool. */
export const DEFAULT_STARTUP_BUDGET_MS = 6_000;

/** Max time the first provider request may spend filling the pool. */
export const DEFAULT_REQUEST_BUDGET_MS = 4_000;

/** Background refresh cadence. */
export const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60_000;

/** Minimum gap between two probe requests, to stay well clear of rate limits. */
export const DEFAULT_MIN_PROBE_INTERVAL_MS = 750;

/** A binding with no activity for this long stops reserving its id. */
export const DEFAULT_LEASE_TTL_MS = 8 * 60 * 60_000;

/** Evict an entry after this many consecutive slow observations. */
export const DEFAULT_QUARANTINE_FAILURES = 2;

/**
 * Real-request upstream latency that counts as one strike.
 *
 * Higher than the probe ceiling on purpose: a real request includes prompt
 * prefill, so a healthy id can legitimately report a few seconds on a long
 * conversation. Only a clearly pathological value earns a strike.
 */
export const DEFAULT_DEGRADE_MS = 6_000;

/** Upstream latency that immediately quarantines an entry, regardless of history. */
export const DEFAULT_QUARANTINE_MS = 8_000;

/** Cap stored bindings so the state file cannot grow without bound. */
export const DEFAULT_MAX_BINDINGS = 256;

/** OpenCode routes requests by this header; pi already sends it, we override it. */
export const SESSION_HEADER = "x-opencode-session";

/** Attribution header OpenCode expects from agent clients. */
export const CLIENT_HEADER = "x-opencode-client";

export interface PoolConfig {
  /** Master switch (`PI_OCPOOL=0` disables the extension). */
  enabled: boolean;
  /** Verified-fast ids kept per provider+model. */
  size: number;
  /** Re-verify a pooled id after this long. */
  ttlMs: number;
  /** Upstream latency ceiling for a "fast" id. */
  maxUpstreamMs: number;
  /** Per-probe abort timeout. */
  probeTimeoutMs: number;
  /** Budget for filling the pool during `session_start`. */
  startupBudgetMs: number;
  /** Budget for filling the pool on the first provider request. */
  requestBudgetMs: number;
  /** Background refresh interval (`0` disables the timer). */
  refreshIntervalMs: number;
  /** Minimum spacing between probe requests. */
  minProbeIntervalMs: number;
  /** Idle time after which a binding stops reserving its routed id. */
  leaseTtlMs: number;
  /** Consecutive slow observations before quarantine. */
  quarantineFailures: number;
  /** Real-request upstream latency that counts as one strike. */
  degradeMs: number;
  /** Single-observation latency that quarantines immediately. */
  quarantineMs: number;
  /** Maximum number of persisted bindings. */
  maxBindings: number;
  /** Only accept ids whose response `id` starts with `gw-`. */
  requireGatewayId: boolean;
  /** State file path. */
  statePath: string;
  /** Verbose stderr logging. */
  debug: boolean;
}

type Env = Record<string, string | undefined>;

function parseInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isFalsy(value: string | undefined): boolean {
  return value === "0" || value === "false" || value === "no";
}

/**
 * Read the extension configuration from the process environment.
 *
 * | Variable                          | Default                     | Meaning                                     |
 * | --------------------------------- | --------------------------- | ------------------------------------------- |
 * | `PI_OCPOOL`                       | `1`                         | Master switch; `0` disables the extension.  |
 * | `PI_OCPOOL_SIZE`                  | `3`                         | Fast ids kept per provider+model.           |
 * | `PI_OCPOOL_TTL_MS`                | `1800000`                   | Re-verify ids older than this.              |
 * | `PI_OCPOOL_MAX_UPSTREAM_MS`       | `2500`                      | Latency ceiling for "fast".                 |
 * | `PI_OCPOOL_PROBE_TIMEOUT_MS`      | `10000`                     | Abort a probe after this long.              |
 * | `PI_OCPOOL_STARTUP_BUDGET_MS`     | `6000`                      | Pool-fill budget on session start.          |
 * | `PI_OCPOOL_REQUEST_BUDGET_MS`     | `4000`                      | Pool-fill budget on first request.          |
 * | `PI_OCPOOL_REFRESH_INTERVAL_MS`   | `300000`                    | Background refresh cadence; `0` disables.   |
 * | `PI_OCPOOL_MIN_PROBE_INTERVAL_MS` | `750`                       | Minimum spacing between probes.             |
 * | `PI_OCPOOL_LEASE_TTL_MS`          | `28800000`                  | Idle time before a binding releases its id. |
 * | `PI_OCPOOL_QUARANTINE_FAILURES`   | `2`                         | Slow hits before an id is evicted.          |
 * | `PI_OCPOOL_DEGRADE_MS`            | `6000`                      | Real upstream latency that counts as a hit. |
 * | `PI_OCPOOL_QUARANTINE_MS`         | `8000`                      | One-shot latency that evicts immediately.   |
 * | `PI_OCPOOL_MAX_BINDINGS`          | `256`                       | Cap on persisted bindings.                  |
 * | `PI_OCPOOL_REQUIRE_GATEWAY_ID`    | `1`                         | Require `id` starting with `gw-`.           |
 * | `PI_OCPOOL_STATE_PATH`            | `~/.pi/opencode-session-pool.json` | State file location.                 |
 * | `PI_OCPOOL_DEBUG`                 | `0`                         | Verbose stderr logging.                     |
 */
export function readConfig(env: Env = process.env, home: string = homedir()): PoolConfig {
  return {
    enabled: !isFalsy(env.PI_OCPOOL),
    size: clamp(parseInteger(env.PI_OCPOOL_SIZE, DEFAULT_POOL_SIZE), 1, 16),
    ttlMs: Math.max(60_000, parseInteger(env.PI_OCPOOL_TTL_MS, DEFAULT_TTL_MS)),
    maxUpstreamMs: Math.max(250, parseInteger(env.PI_OCPOOL_MAX_UPSTREAM_MS, DEFAULT_MAX_UPSTREAM_MS)),
    probeTimeoutMs: Math.max(
      500,
      parseInteger(env.PI_OCPOOL_PROBE_TIMEOUT_MS, DEFAULT_PROBE_TIMEOUT_MS),
    ),
    startupBudgetMs: Math.max(
      0,
      parseInteger(env.PI_OCPOOL_STARTUP_BUDGET_MS, DEFAULT_STARTUP_BUDGET_MS),
    ),
    requestBudgetMs: Math.max(
      0,
      parseInteger(env.PI_OCPOOL_REQUEST_BUDGET_MS, DEFAULT_REQUEST_BUDGET_MS),
    ),
    refreshIntervalMs: Math.max(
      0,
      parseInteger(env.PI_OCPOOL_REFRESH_INTERVAL_MS, DEFAULT_REFRESH_INTERVAL_MS),
    ),
    minProbeIntervalMs: Math.max(
      0,
      parseInteger(env.PI_OCPOOL_MIN_PROBE_INTERVAL_MS, DEFAULT_MIN_PROBE_INTERVAL_MS),
    ),
    leaseTtlMs: Math.max(60_000, parseInteger(env.PI_OCPOOL_LEASE_TTL_MS, DEFAULT_LEASE_TTL_MS)),
    quarantineFailures: clamp(
      parseInteger(env.PI_OCPOOL_QUARANTINE_FAILURES, DEFAULT_QUARANTINE_FAILURES),
      1,
      10,
    ),
    degradeMs: Math.max(1_000, parseInteger(env.PI_OCPOOL_DEGRADE_MS, DEFAULT_DEGRADE_MS)),
    quarantineMs: Math.max(
      1_000,
      parseInteger(env.PI_OCPOOL_QUARANTINE_MS, DEFAULT_QUARANTINE_MS),
    ),
    maxBindings: Math.max(8, parseInteger(env.PI_OCPOOL_MAX_BINDINGS, DEFAULT_MAX_BINDINGS)),
    requireGatewayId: !isFalsy(env.PI_OCPOOL_REQUIRE_GATEWAY_ID),
    statePath:
      env.PI_OCPOOL_STATE_PATH?.trim() || join(home, ".pi", "opencode-session-pool.json"),
    debug: env.PI_OCPOOL_DEBUG === "1",
  };
}
