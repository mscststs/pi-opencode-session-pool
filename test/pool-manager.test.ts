import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readConfig, type PoolConfig } from "../lib/config.ts";
import { PoolManager } from "../lib/pool-manager.ts";
import { PoolStore } from "../lib/pool-store.ts";
import type { Prober } from "../lib/probe.ts";
import { bindingKey } from "../lib/targets.ts";
import type { Binding, PoolEntry, PoolState, ProbeReason, ProbeResult, ProbeTarget } from "../lib/types.ts";

const target: ProbeTarget = {
  provider: "opencode-go",
  model: "deepseek-v4.1-flash",
  url: "https://opencode.ai/inference/go/openai/v1/chat/completions",
  apiKey: "sk-test",
};

const NOW = 1_000_000;
const key = (session: string) => bindingKey(session, target.provider, target.model);

function makeConfig(overrides: Partial<PoolConfig> = {}): PoolConfig {
  return {
    ...readConfig({}, "/home/tester"),
    minProbeIntervalMs: 0,
    refreshIntervalMs: 0,
    refillDelayMs: 0,
    ...overrides,
  };
}

interface PlanStep {
  fast?: boolean;
  upstreamMs?: number;
  reason?: ProbeReason;
  status?: number;
  retryAfterMs?: number;
  advanceMs?: number;
}

interface Harness {
  manager: PoolManager;
  store: PoolStore;
  calls: string[];
  clock: { value: number };
  sleeps: number[];
  timers: Array<{ delayMs: number; run: () => void }>;
}

async function harness(
  options: {
    plan?: PlanStep[];
    state?: PoolState;
    config?: Partial<PoolConfig>;
    advanceOnCall?: number;
    prober?: Prober;
  } = {},
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "pi-ocpool-manager-"));
  const clock = { value: NOW };
  const now = () => clock.value;
  const store = new PoolStore({ path: join(dir, "state.json"), now });
  if (options.state) await store.save(options.state);

  const plan = [...(options.plan ?? [])];
  const calls: string[] = [];
  const prober: Prober =
    options.prober ??
    {
      async probe(id): Promise<ProbeResult> {
        calls.push(id);
        const step = plan.shift() ?? { fast: false, reason: "slow" as ProbeReason };
        clock.value += step.advanceMs ?? options.advanceOnCall ?? 1_000;
        const fast = step.fast ?? false;
        return {
          fast,
          status: step.status ?? (step.reason === "overloaded" ? 429 : 200),
          reason: step.reason ?? (fast ? "fast" : "slow"),
          upstreamMs: step.upstreamMs ?? (fast ? 900 : 20_000),
          retryAfterMs: step.retryAfterMs,
        };
      },
    };

  let counter = 0;
  const sleeps: number[] = [];
  const timers: Harness["timers"] = [];
  const manager = new PoolManager({
    config: makeConfig(options.config),
    store,
    prober,
    now,
    randomId: () => `cand-${++counter}`,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.value += ms;
    },
    setTimeoutImpl: ((fn: () => void, delayMs?: number) => {
      timers.push({ delayMs: Number(delayMs ?? 0), run: fn });
      return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeoutImpl: (() => {}) as typeof clearTimeout,
  });

  return { manager, store, calls, clock, sleeps, timers };
}

const spare = (id: string, overrides: Partial<PoolEntry> = {}): PoolEntry => ({
  id,
  provider: target.provider,
  model: target.model,
  upstreamMs: 900,
  verifiedAt: NOW,
  createdAt: NOW,
  ...overrides,
});

const owned = (id: string, overrides: Partial<Binding> = {}): Binding => ({
  routedId: id,
  provider: target.provider,
  model: target.model,
  boundAt: NOW,
  lastSeenAt: NOW,
  upstreamMs: 900,
  verifiedAt: NOW,
  failures: 0,
  ...overrides,
});

function stateWith(spares: PoolEntry[], bindings: PoolState["bindings"] = {}): PoolState {
  return { version: 1, entries: spares, bindings };
}

test("takes a fresh spare without probing, and it leaves the pool", async () => {
  const { manager, store } = await harness({ state: stateWith([spare("spare-1")]) });

  assert.equal(await manager.bind(key("s1"), target, 0), "spare-1");
  assert.equal(manager.peek(key("s1")), "spare-1");

  const persisted = await store.load();
  assert.deepEqual(persisted.entries, [], "the spare is consumed");
  assert.equal(persisted.bindings[key("s1")]?.routedId, "spare-1");
});

test("a resumed conversation keeps its own id", async () => {
  const { manager, calls } = await harness({
    state: stateWith([], {
      [key("s1")]: owned("own-1", { lastSeenAt: NOW - 5 * 60_000 }),
    }),
  });

  assert.equal(await manager.bind(key("s1"), target, 0), "own-1");
  assert.deepEqual(calls, []);
});

test("two conversations never share an id", async () => {
  const { manager, calls } = await harness({
    plan: [{ fast: true }],
    state: stateWith([spare("spare-1"), spare("spare-2", { upstreamMs: 1_200 })]),
  });

  assert.equal(await manager.bind(key("s1"), target, 0), "spare-1");
  assert.equal(await manager.bind(key("s2"), target, 0), "spare-2");
  assert.deepEqual(calls, []);

  // Pool is empty now: a third conversation probes a new id.
  assert.equal(await manager.bind(key("s3"), target, 5_000), "cand-1");
  assert.deepEqual(calls, ["cand-1"]);
});

test("an id whose conversation is gone is retired, never reused", async () => {
  const { manager, calls } = await harness({
    plan: [{ fast: true }],
    state: stateWith([], {
      [key("old")]: owned("old-1", { lastSeenAt: NOW - 9 * 60 * 60_000 }),
    }),
  });

  assert.equal(await manager.bind(key("new"), target, 5_000), "cand-1");
  assert.deepEqual(calls, ["cand-1"], "the retired id is not offered to a new conversation");
});

test("probes candidates until one is fast", async () => {
  const { manager, calls, store } = await harness({
    plan: [{ fast: false, reason: "slow" }, { fast: true, upstreamMs: 870 }],
  });

  assert.equal(await manager.bind(key("s1"), target, 5_000), "cand-2");
  assert.deepEqual(calls, ["cand-1", "cand-2"]);

  const persisted = await store.load();
  assert.deepEqual(persisted.entries, [], "a probed id goes straight to its conversation");
  assert.equal(persisted.bindings[key("s1")]?.upstreamMs, 870);
});

test("returns undefined and keeps pi's id when the budget is too small", async () => {
  const { manager, calls } = await harness();
  assert.equal(await manager.bind(key("s1"), target, 0), undefined);
  assert.equal(await manager.bind(key("s1"), target, 1_499), undefined);
  assert.deepEqual(calls, []);
  assert.equal(manager.peek(key("s1")), undefined);
});

test("gives up when the budget runs out without a fast candidate", async () => {
  const { manager, calls } = await harness({ advanceOnCall: 400 });
  assert.equal(await manager.bind(key("s1"), target, 2_000), undefined);
  assert.ok(calls.length >= 2, `expected several probes, got ${calls.length}`);
});

test("a stale spare is re-verified and taken", async () => {
  const { manager, calls } = await harness({
    plan: [{ fast: true, upstreamMs: 800 }],
    state: stateWith([spare("spare-1", { verifiedAt: NOW - 60 * 60_000 })]),
    config: { ttlMs: 30 * 60_000 },
  });

  assert.equal(await manager.bind(key("s1"), target, 5_000), "spare-1");
  assert.deepEqual(calls, ["spare-1"], "the known id is verified instead of a random one");
});

test("a stale spare that turned slow is dropped and replaced", async () => {
  const { manager, calls, store } = await harness({
    plan: [{ fast: false, reason: "slow" }, { fast: true }],
    state: stateWith([spare("spare-1", { verifiedAt: NOW - 60 * 60_000 })]),
    config: { ttlMs: 30 * 60_000 },
  });

  assert.equal(await manager.bind(key("s1"), target, 10_000), "cand-1");
  assert.deepEqual(calls, ["spare-1", "cand-1"]);

  const persisted = await store.load();
  assert.deepEqual(persisted.entries, [], "the slow spare is gone");
});

test("a slow observation retires the conversation's id", async () => {
  const { manager, store } = await harness({ state: stateWith([], { [key("s1")]: owned("own-1") }) });

  await manager.observe(key("s1"), { "server-timing": "gateway;dur=10, upstream;dur=20000" }, 200);

  assert.equal(manager.peek(key("s1")), undefined);
  const persisted = await store.load();
  assert.deepEqual(Object.keys(persisted.bindings), []);
  assert.deepEqual(persisted.entries, [], "a retired id never returns to the pool");
});

test("a fast observation refreshes stats and the lease", async () => {
  const { manager, store, clock } = await harness({
    state: stateWith([], { [key("s1")]: owned("own-1", { upstreamMs: 2_000, lastSeenAt: NOW - 60_000 }) }),
  });

  clock.value += 10_000;
  await manager.observe(key("s1"), { "server-timing": "upstream;dur=910" }, 200);

  const persisted = await store.load();
  assert.equal(persisted.bindings[key("s1")]?.upstreamMs, 910);
  assert.equal(persisted.bindings[key("s1")]?.failures, 0);
  assert.equal(persisted.bindings[key("s1")]?.lastSeenAt, clock.value);
});

test("one degraded observation is tolerated, the second retires", async () => {
  const { manager } = await harness({
    state: stateWith([], { [key("s1")]: owned("own-1") }),
    config: { quarantineFailures: 2, degradeMs: 6_000, quarantineMs: 20_000 },
  });

  await manager.observe(key("s1"), { "server-timing": "upstream;dur=7000" }, 200);
  assert.equal(manager.peek(key("s1")), "own-1", "7000ms is a strike but not catastrophic");

  await manager.observe(key("s1"), { "server-timing": "upstream;dur=7100" }, 200);
  assert.equal(manager.peek(key("s1")), undefined);
});

test("ordinary prefill latency is not a strike", async () => {
  const { manager } = await harness({
    state: stateWith([], { [key("s1")]: owned("own-1") }),
    config: { degradeMs: 6_000, quarantineMs: 8_000, quarantineFailures: 2 },
  });

  for (const upstream of [2600, 3400, 5100]) {
    await manager.observe(key("s1"), { "server-timing": `upstream;dur=${upstream}` }, 200);
    assert.equal(manager.peek(key("s1")), "own-1", `${upstream}ms is normal prefill`);
  }

  await manager.observe(key("s1"), { "server-timing": "upstream;dur=9000" }, 200);
  assert.equal(manager.peek(key("s1")), undefined, "9000ms is catastrophic");
});

test("an overloaded (429) response retires immediately", async () => {
  const { manager } = await harness({ state: stateWith([], { [key("s1")]: owned("own-1") }) });

  await manager.observe(key("s1"), { "retry-after-ms": "2303" }, 429);
  assert.equal(manager.peek(key("s1")), undefined);
});

test("taking a spare schedules a refill", async () => {
  const { manager, timers } = await harness({
    state: stateWith([spare("spare-1")]),
    config: { refillDelayMs: 15_000 },
  });

  await manager.bind(key("s1"), target, 0);
  assert.equal(timers.length, 1);
  assert.equal(timers[0]?.delayMs, 15_000);
});

test("refresh retires expired conversations", async () => {
  const { manager, store } = await harness({
    state: stateWith([], { [key("dead")]: owned("old-1", { lastSeenAt: NOW - 9 * 60 * 60_000 }) }),
    config: { leaseTtlMs: 8 * 60 * 60_000 },
  });
  manager.registerTarget(target);

  await manager.refresh();

  const persisted = await store.load();
  assert.deepEqual(Object.keys(persisted.bindings), []);
});

test("refresh re-verifies stale spares and drops slow ones", async () => {
  const { manager, store, calls } = await harness({
    plan: [{ fast: false, reason: "slow" }],
    state: stateWith([spare("spare-1", { verifiedAt: NOW - 60 * 60_000 })]),
    config: { size: 1, ttlMs: 30 * 60_000 },
  });
  manager.registerTarget(target);

  await manager.refresh();

  assert.equal(calls[0], "spare-1", "spares are re-verified by id");
  const persisted = await store.load();
  assert.deepEqual(persisted.entries, []);
});

test("refresh never re-probes an id owned by a conversation", async () => {
  const { manager, store, calls } = await harness({
    plan: [{ fast: false, reason: "slow" }],
    state: stateWith(
      [spare("spare-1", { verifiedAt: NOW - 60 * 60_000 })],
      { [key("s1")]: owned("own-1", { lastSeenAt: NOW - 60 * 60_000 }) },
    ),
    config: { size: 1, ttlMs: 30 * 60_000, leaseTtlMs: 8 * 60 * 60_000 },
  });
  manager.registerTarget(target);

  await manager.refresh();

  assert.ok(!calls.includes("own-1"), `owned ids are not probed (calls: ${calls.join(",")})`);
  const persisted = await store.load();
  assert.equal(persisted.bindings[key("s1")]?.routedId, "own-1");
});

test("refresh tops the spare pool up to its configured size", async () => {
  const { manager, store, calls } = await harness({
    plan: [{ fast: true }, { fast: true }, { fast: true }],
    config: { size: 3 },
  });
  manager.registerTarget(target);

  await manager.refresh();

  assert.deepEqual(calls, ["cand-1", "cand-2", "cand-3"]);
  const persisted = await store.load();
  assert.equal(persisted.entries.length, 3);
  assert.deepEqual(Object.keys(persisted.bindings), []);
});

test("honours 429 retry-after before the next probe", async () => {
  const { manager, sleeps, calls } = await harness({
    plan: [{ reason: "overloaded", status: 429, retryAfterMs: 5_000 }, { fast: true }],
  });

  assert.equal(await manager.bind(key("s1"), target, 10_000), "cand-2");
  assert.deepEqual(calls, ["cand-1", "cand-2"]);
  assert.deepEqual(sleeps, [5_000]);
});

test("never probes during a 429 backoff that outlives the budget", async () => {
  const { manager, calls } = await harness({
    plan: [{ reason: "overloaded", status: 429, retryAfterMs: 9_000 }, { fast: true }],
  });

  assert.equal(await manager.bind(key("s1"), target, 5_000), undefined);
  assert.deepEqual(calls, ["cand-1"], "no probing after Retry-After exceeds the budget");
});

test("stops probing when the gateway rejects the credentials", async () => {
  const { manager, calls } = await harness({
    plan: [{ reason: "unauthorized", status: 401 }, { fast: true }],
  });

  assert.equal(await manager.bind(key("s1"), target, 10_000), undefined);
  assert.deepEqual(calls, ["cand-1"]);
});

test("concurrent binds share a single acquisition", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: string[] = [];
  const prober: Prober = {
    async probe(id) {
      calls.push(id);
      await gate;
      return { fast: true, status: 200, reason: "fast", upstreamMs: 800 };
    },
  };
  const { manager } = await harness({ prober });

  const first = manager.bind(key("s1"), target, 5_000);
  const second = manager.bind(key("s1"), target, 5_000);
  release?.();

  assert.deepEqual(await Promise.all([first, second]), ["cand-1", "cand-1"]);
  assert.deepEqual(calls, ["cand-1"]);
});

test("bind never rejects even when storage explodes", async () => {
  const { manager } = await harness({ plan: [{ fast: true }] });
  (manager as unknown as { store: { load: () => Promise<never> } }).store.load = async () => {
    throw new Error("disk on fire");
  };

  assert.equal(await manager.bind(key("s1"), target, 5_000), undefined);
});
