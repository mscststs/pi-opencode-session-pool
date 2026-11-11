#!/usr/bin/env -S npx tsx
/**
 * Diagnose the current OpenCode routing behaviour with real probes.
 *
 * This is the script that caught the 2026-11-11 regression: the gateway began
 * answering fast requests with `chatcmpl-…` / plain ids instead of `gw-…`, so
 * `PI_OCPOOL_REQUIRE_GATEWAY_ID=1` rejected healthy candidates and a
 * synchronous probe budget of 4–6 s was burned on every turn.
 *
 * It sends one tiny completion per repetition, measures `server-timing`, and
 * checks two things the pool depends on:
 *
 *   1. Is a candidate's latency predictable from its id? The same id is probed
 *      several times; if the body-id prefixes and latencies change, OpenCode is
 *      load-balancing per request and a pool cannot pin a fast shard.
 *   2. Does the configured classifier reject a response that was actually fast?
 *      That is pure added TTFT and exits non-zero.
 *
 * Usage:
 *   npx tsx scripts/diagnose-routing.ts                 # 3 ids × 3 repeats
 *   npx tsx scripts/diagnose-routing.ts --count 5 --repeat 4
 *   PI_OCPOOL_REQUIRE_GATEWAY_ID=1 npx tsx scripts/diagnose-routing.ts
 *       # reproduce the legacy classifier's false rejections
 *
 * Auth: `OPENCODE_API_KEY`, or the `opencode` entry in ~/.pi/agent/auth.json.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readConfig } from "../lib/config.ts";
import {
  classifyProbe,
  extractBodyId,
  parseRetryAfter,
  parseServerTiming,
  type ClassifyInput,
} from "../lib/probe.ts";
import { EXTENSION_NAME, EXTENSION_VERSION } from "../lib/version.ts";

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

const count = Math.max(1, Number.parseInt(arg("count", "3") ?? "3", 10));
const repeat = Math.max(1, Number.parseInt(arg("repeat", "3") ?? "3", 10));
const model = arg("model", "deepseek-v4.1-flash") as string;
const baseUrl = arg("base-url", "https://opencode.ai/inference/go/openai/v1") as string;
const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
const timeoutMs = Math.max(1_000, Number.parseInt(arg("timeout", "15000") ?? "15000", 10));

async function resolveKey(): Promise<string | undefined> {
  if (process.env.OPENCODE_API_KEY) return process.env.OPENCODE_API_KEY;
  try {
    const auth = JSON.parse(await readFile(join(homedir(), ".pi", "agent", "auth.json"), "utf8"));
    const key = auth?.opencode?.key ?? auth?.["opencode-go"]?.key;
    return typeof key === "string" ? key : undefined;
  } catch {
    return undefined;
  }
}

interface Observation {
  id: string;
  status: number;
  wallMs: number;
  bodyId?: string;
  serverTiming: string | null;
  upstreamMs?: number;
  gatewayMs?: number;
  retryAfterMs?: number;
}

const apiKey = await resolveKey();
if (!apiKey) {
  console.error("no OpenCode API key: set OPENCODE_API_KEY or log in with pi");
  process.exit(2);
}

const config = readConfig();
const current = {
  probeTimeoutMs: timeoutMs,
  maxUpstreamMs: config.maxUpstreamMs,
  requireGatewayId: config.requireGatewayId,
};
const relaxed = { ...current, requireGatewayId: false };
const legacy = { ...current, requireGatewayId: true };

async function probeOnce(sessionId: string): Promise<Observation> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": `${EXTENSION_NAME}/${EXTENSION_VERSION} diagnose`,
    "x-opencode-client": "pi",
    "x-opencode-session": sessionId,
  };
  const startedAt = performance.now();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        stream: false,
        max_tokens: 1,
        messages: [{ role: "user", content: "OK" }],
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    const wallMs = Math.round(performance.now() - startedAt);
    const flat: Record<string, string | undefined> = {};
    response.headers.forEach((value, key) => {
      flat[key.toLowerCase()] = value;
    });
    const timing = parseServerTiming(response.headers.get("server-timing"));
    return {
      id: sessionId,
      status: response.status,
      wallMs,
      bodyId: extractBodyId(text),
      serverTiming: response.headers.get("server-timing"),
      upstreamMs: timing.upstreamMs,
      gatewayMs: timing.gatewayMs,
      retryAfterMs: parseRetryAfter(flat),
    };
  } catch (error) {
    const aborted = controller.signal.aborted || (error as { name?: string })?.name === "AbortError";
    return {
      id: sessionId,
      status: 0,
      wallMs: Math.round(performance.now() - startedAt),
      bodyId: undefined,
      serverTiming: aborted ? `aborted after ${timeoutMs}ms` : (error as Error)?.message ?? "network error",
    };
  } finally {
    clearTimeout(timer);
  }
}

function classify(observation: Observation, limits: typeof current) {
  const input: ClassifyInput = {
    status: observation.status,
    serverTiming: observation.serverTiming,
    bodyId: observation.bodyId,
    wallMs: observation.wallMs,
    retryAfterMs: observation.retryAfterMs,
  };
  return classifyProbe(input, limits);
}

function prefixOf(bodyId: string | undefined): string {
  if (!bodyId) return "-";
  // gw-<worker>-<sequence>: the worker segment is the useful signal.
  if (bodyId.startsWith("gw-")) {
    const cut = bodyId.lastIndexOf("-");
    return cut > 3 ? bodyId.slice(0, cut) : bodyId;
  }
  const cut = bodyId.indexOf("-");
  return cut > 0 ? bodyId.slice(0, cut) : bodyId.slice(0, 8);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2)
    : (sorted[middle] ?? 0);
}

console.log(`OpenCode routing diagnosis
  url              ${url}
  model            ${model}
  ids / repeats    ${count} / ${repeat}
  current config   maxUpstream=${current.maxUpstreamMs}ms requireGatewayId=${current.requireGatewayId}
  probe timeout    ${timeoutMs}ms
`);

const observations: Array<{ round: number; observation: Observation }> = [];
const fixedId = randomUUID();
for (let round = 0; round < count; round += 1) {
  // Round 0 repeats one identical id so the output answers "is routing sticky?".
  const sessionId = round === 0 ? fixedId : randomUUID();
  for (let pass = 0; pass < repeat; pass += 1) {
    const observation = await probeOnce(sessionId);
    observations.push({ round, observation });
    const verdict = classify(observation, current);
    console.log(
      `id=${sessionId.slice(0, 13)} pass=${pass + 1} wall=${String(observation.wallMs).padStart(5)}ms ` +
        `upstream=${String(observation.upstreamMs ?? "?").padStart(5)}ms status=${observation.status} ` +
        `body=${String(observation.bodyId ?? "-").padEnd(46)} -> ${verdict.reason}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
}

const healthyButRejected = observations.filter(({ observation }) => {
  const actual = classify(observation, relaxed);
  const configured = classify(observation, current);
  return actual.fast && !configured.fast;
});
const legacyFalseRejections = observations.filter(({ observation }) => {
  const actual = classify(observation, relaxed);
  const old = classify(observation, legacy);
  return actual.fast && !old.fast;
});

const byId = new Map<string, Observation[]>();
for (const { observation } of observations) {
  const list = byId.get(observation.id) ?? [];
  list.push(observation);
  byId.set(observation.id, list);
}

console.log("\nper-id summary (same-id spread answers 'is routing sticky?'):");
for (const [id, list] of byId) {
  const latencies = list.map((entry) => entry.upstreamMs ?? entry.wallMs);
  const prefixes = [...new Set(list.map((entry) => prefixOf(entry.bodyId)))];
  console.log(
    `  ${id.slice(0, 13)} n=${list.length} min=${Math.min(...latencies)}ms ` +
      `median=${median(latencies)}ms max=${Math.max(...latencies)}ms ` +
      `bodyPrefixes=${prefixes.join(",")} sticky=${prefixes.length === 1}`,
  );
}

const total = observations.length;
const fast = observations.filter(({ observation }) => classify(observation, relaxed).fast).length;
console.log(
  `\nsummary: ${fast}/${total} fast by latency, ` +
    `${healthyButRejected.length} healthy responses rejected by current config, ` +
    `${legacyFalseRejections.length} rejected by the legacy gw- heuristic`,
);

if (healthyButRejected.length > 0) {
  const reasons = [...new Set(healthyButRejected.map(({ observation }) => classify(observation, current).reason))];
  console.error(
    `\nFAIL: the configured classifier rejected ${healthyButRejected.length} fast response(s) ` +
      `(${reasons.join(", ")}). This is added TTFT, not a slow route.`,
  );
  process.exit(1);
}

if (legacyFalseRejections.length > 0 && !current.requireGatewayId) {
  console.log(
    `\nNote: PI_OCPOOL_REQUIRE_GATEWAY_ID=1 would have rejected all of those fast responses. ` +
      "Leave it off; the body-id prefix is no longer a route signal.",
  );
}

console.log("\nOK: no fast response was rejected by the current configuration.");
