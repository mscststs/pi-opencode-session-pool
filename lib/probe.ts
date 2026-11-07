/**
 * Probe one candidate session id.
 *
 * A probe is a real (but tiny) chat completion: `max_tokens: 1`, a one-word
 * prompt, and the candidate id in `x-opencode-session`. OpenCode answers with
 * `server-timing: gateway;dur=..., upstream;dur=..., total;dur=...`, which turns
 * the response into a direct measurement of the upstream shard the id maps to:
 *
 *   - fast shard:       upstream ≈ 0.8-2.0 s, body `id` starts with `gw-`
 *   - overloaded shard: upstream ≈ 10-43 s, body `id` starts with `chatcmpl-`
 *
 * Slow ids stay slow for the whole conversation and for many minutes, so one
 * probe is enough to decide. The probe also warms the routed path for the real
 * request that follows.
 */
import type { ProbeResult, ProbeTarget, ServerTiming } from "./types.ts";
import { silentLogger, type Logger } from "./logger.ts";
import { CLIENT_HEADER, SESSION_HEADER } from "./config.ts";
import { EXTENSION_NAME, EXTENSION_VERSION } from "./version.ts";

export interface ProberConfig {
  /** Abort a probe after this long; slower ids are already disqualified. */
  probeTimeoutMs: number;
  /** Upstream latency ceiling for a "fast" id. */
  maxUpstreamMs: number;
  /** Require the response body id to start with `gw-`. */
  requireGatewayId: boolean;
}

export interface ProberOptions {
  config: ProberConfig;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: Logger;
}

export interface Prober {
  /**
   * Measure `id` against `target`.
   *
   * @param timeoutMs optional override, used to respect the caller's time budget
   */
  probe(id: string, target: ProbeTarget, timeoutMs?: number): Promise<ProbeResult>;
}

/** Parse an RFC 9110 `server-timing` header into millisecond durations. */
export function parseServerTiming(header: string | null | undefined): ServerTiming {
  const timing: ServerTiming = {};
  if (!header) return timing;
  for (const part of header.split(",")) {
    const [rawName, ...params] = part.split(";");
    const name = rawName.trim().toLowerCase();
    let value: number | undefined;
    for (const param of params) {
      const [key, rawValue] = param.split("=");
      if (key?.trim().toLowerCase() !== "dur") continue;
      const parsed = Number.parseFloat(rawValue?.replace(/"/g, "") ?? "");
      if (Number.isFinite(parsed) && parsed >= 0) value = parsed;
    }
    if (value === undefined) continue;
    if (name === "gateway") timing.gatewayMs = value;
    else if (name === "upstream") timing.upstreamMs = value;
    else if (name === "total") timing.totalMs = value;
  }
  return timing;
}

/** Parse `retry-after-ms` (OpenCode) or `Retry-After` (seconds) into millis. */
export function parseRetryAfter(headers: Record<string, string | undefined>): number | undefined {
  const rawMs = headers["retry-after-ms"];
  if (rawMs !== undefined) {
    const parsed = Number.parseFloat(rawMs);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.ceil(parsed);
  }
  const raw = headers["retry-after"];
  if (raw === undefined) return undefined;
  const seconds = Number.parseFloat(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(raw);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

export interface ClassifyInput {
  status: number;
  serverTiming: string | null;
  bodyId?: string;
  wallMs: number;
  retryAfterMs?: number;
}

/**
 * Turn one HTTP response into a fast/slow verdict.
 *
 * `upstream;dur` is authoritative. If the gateway omits `server-timing` (a
 * proxy stripped it, for example), the wall-clock duration stands in.
 */
export function classifyProbe(input: ClassifyInput, config: ProberConfig): ProbeResult {
  const timing = parseServerTiming(input.serverTiming);
  const base = {
    status: input.status,
    upstreamMs: timing.upstreamMs,
    gatewayMs: timing.gatewayMs,
    bodyId: input.bodyId,
    retryAfterMs: input.retryAfterMs,
  };

  if (input.status === 429) {
    return { ...base, fast: false, reason: "overloaded" };
  }
  if (input.status === 401 || input.status === 403) {
    return { ...base, fast: false, reason: "unauthorized" };
  }
  if (input.status >= 400) {
    return { ...base, fast: false, reason: "http-error" };
  }
  if (input.status !== 200) {
    return { ...base, fast: false, reason: "rejected" };
  }

  const measured = timing.upstreamMs ?? input.wallMs;
  if (measured > config.maxUpstreamMs) {
    return { ...base, upstreamMs: measured, fast: false, reason: "slow" };
  }
  if (config.requireGatewayId && !input.bodyId?.startsWith("gw-")) {
    return { ...base, fast: false, reason: "gateway-id-mismatch" };
  }
  return { ...base, upstreamMs: measured, fast: true, reason: "fast" };
}

/** Extract the top-level `id` from an OpenCode response body. */
export function extractBodyId(body: string): string | undefined {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null) {
        const id = (parsed as Record<string, unknown>).id;
        if (typeof id === "string") return id;
      }
    } catch {
      // Fall through: a truncated body still carries the id.
    }
  }
  const match = /"id"\s*:\s*"([^"]+)"/.exec(trimmed);
  return match?.[1];
}

/** Build a prober bound to one config/fetch/clock triple. */
export function createProber(options: ProberOptions): Prober {
  const config = options.config;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const log = options.log ?? silentLogger;

  return {
    async probe(id, target, timeoutMs) {
      const budget = Math.max(250, Math.min(timeoutMs ?? config.probeTimeoutMs, config.probeTimeoutMs));
      const controller = new AbortController();
      // Not unref'd on purpose: the abort must fire even when nothing else
      // keeps the event loop alive (otherwise a probe can hang forever).
      const timer = setTimeout(() => controller.abort(), budget);

      const headers = new Headers({
        Authorization: `Bearer ${target.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": `${EXTENSION_NAME}/${EXTENSION_VERSION}`,
        [CLIENT_HEADER]: "pi",
        [SESSION_HEADER]: id,
      });
      for (const [key, value] of Object.entries(target.headers ?? {})) headers.set(key, value);

      const body = JSON.stringify({
        model: target.model,
        stream: false,
        max_tokens: 1,
        messages: [{ role: "user", content: "OK" }],
      });

      const startedAt = now();
      try {
        const response = await fetchImpl(target.url, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        });
        const text = await response.text();
        const wallMs = now() - startedAt;
        const flat: Record<string, string | undefined> = {};
        response.headers.forEach((value, key) => {
          flat[key.toLowerCase()] = value;
        });

        const result = classifyProbe(
          {
            status: response.status,
            serverTiming: response.headers.get("server-timing"),
            bodyId: extractBodyId(text),
            wallMs,
            retryAfterMs: parseRetryAfter(flat),
          },
          config,
        );

        log.debug(
          `probe ${target.provider}/${target.model} id=${id} status=${result.status} ` +
            `upstream=${result.upstreamMs ?? "?"}ms gateway=${result.gatewayMs ?? "?"}ms ` +
            `id=${result.bodyId ?? "-"} -> ${result.reason}`,
        );
        return result;
      } catch (error) {
        const wallMs = now() - startedAt;
        const aborted = controller.signal.aborted || (error as { name?: string })?.name === "AbortError";
        const result: ProbeResult = {
          fast: false,
          status: 0,
          reason: aborted ? "timeout" : "network-error",
        };
        log.debug(
          `probe ${target.provider}/${target.model} id=${id} failed after ${wallMs}ms -> ${result.reason}` +
            (aborted ? ` (${budget}ms budget)` : `: ${(error as Error)?.message ?? String(error)}`),
        );
        return result;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Read `server-timing` from a header bag, tolerating case differences.
 *
 * pi normalizes response header names, but a defensive lookup costs nothing and
 * keeps the extension working if that ever changes.
 */
export function timingFromHeaders(headers: Record<string, string | undefined>): ServerTiming {
  const direct = headers["server-timing"];
  if (direct !== undefined) return parseServerTiming(direct);
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "server-timing") return parseServerTiming(value);
  }
  return {};
}
