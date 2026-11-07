#!/usr/bin/env -S npx tsx
/**
 * Live check: probe OpenCode candidates with the real prober from `lib/`.
 *
 * This is a development tool, not part of the extension. It proves that the
 * request shape, headers and `server-timing` parsing work against the real
 * gateway, and can optionally seed the pool file.
 *
 * Usage:
 *   npx tsx scripts/live-check.ts                # 2 candidates, no writes
 *   npx tsx scripts/live-check.ts --count 4
 *   npx tsx scripts/live-check.ts --seed         # append fast ids to the pool
 *   npx tsx scripts/live-check.ts --model deepseek-v4.1-flash \
 *       --base-url https://opencode.ai/inference/go/openai/v1
 *
 * Auth: `OPENCODE_API_KEY`, or the `opencode` entry in `~/.pi/agent/auth.json`.
 */
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createProber } from "../lib/probe.ts";
import type { ProbeTarget } from "../lib/types.ts";

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

const count = Number.parseInt(arg("count", "2") ?? "2", 10);
const model = arg("model", "deepseek-v4.1-flash") as string;
const baseUrl = arg("base-url", "https://opencode.ai/inference/go/openai/v1") as string;
const seed = process.argv.includes("--seed");
const poolPath =
  process.env.PI_OCPOOL_STATE_PATH?.trim() || join(homedir(), ".pi", "opencode-session-pool.json");

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

const apiKey = await resolveKey();
if (!apiKey) {
  console.error("no OpenCode API key: set OPENCODE_API_KEY or log in with pi");
  process.exit(1);
}

const target: ProbeTarget = {
  provider: "opencode-go",
  model,
  url: `${baseUrl.replace(/\/+$/, "")}/chat/completions`,
  apiKey,
};

const prober = createProber({
  config: { probeTimeoutMs: 15_000, maxUpstreamMs: 2_500, requireGatewayId: true },
  log: { debug: (message) => console.error(`  ${message}`) },
});

console.log(`probing ${count} candidate(s) against ${target.url}\n`);
const fast: Array<{ id: string; upstreamMs: number }> = [];
for (let index = 0; index < count; index += 1) {
  const id = randomUUID();
  const result = await prober.probe(id, target);
  const verdict = result.fast ? "FAST" : "SLOW";
  console.log(
    `${verdict}  upstream=${String(result.upstreamMs ?? "?").padStart(6)}ms  ` +
      `gateway=${String(result.gatewayMs ?? "?").padStart(4)}ms  id=${result.bodyId ?? "-"}\n` +
      `       session=${id}  reason=${result.reason}`,
  );
  if (result.fast) fast.push({ id, upstreamMs: result.upstreamMs ?? 0 });
  await new Promise((resolve) => setTimeout(resolve, 750));
}

if (seed && fast.length > 0) {
  let state = { version: 1, entries: [], bindings: {} } as {
    version: number;
    entries: unknown[];
    bindings: Record<string, unknown>;
  };
  try {
    state = JSON.parse(await readFile(poolPath, "utf8"));
  } catch {
    // start from an empty document
  }
  const now = Date.now();
  for (const { id, upstreamMs } of fast) {
    state.entries.push({
      id,
      provider: target.provider,
      model: target.model,
      upstreamMs,
      verifiedAt: now,
      createdAt: now,
    });
  }
  await mkdir(dirname(poolPath), { recursive: true });
  await writeFile(poolPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  console.log(`\nseeded ${fast.length} id(s) into ${poolPath}`);
}
