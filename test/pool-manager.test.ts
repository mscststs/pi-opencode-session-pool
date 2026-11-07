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
import type { PoolEntry, PoolState, ProbeReason, ProbeResult, ProbeTarget } from "../lib/types.ts";

const target: ProbeTarget = {
  provider: "opencode-go",
  model: "deepseek-v4.1-flash",
  url: "https://opencode.ai/inference/go/openai/v1/chat/completions",
  apiKey: "sk-test",
};

const key = (session: string) => bindingKey(session, target.provider, target.model);

function makeConfig(overrides: Partial<PoolConfig> = {}): PoolConfig {
  return {
    ...readConfig({}, "/home/tester"),
    minProbeIntervalMs: 0,
    refreshIntervalMs: 0,
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
  const clock = { value: 1_000_000 };
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
  });

  return { manager, store, calls, clock, sleeps };
}

function entry(id: string, overrides: Partial<PoolEntry> = {}): PoolEntry {
  return {
    id,
    provider: target.provider,
    model: target.model,
    upstreamMs: 900,
    verifiedAt: 1_000_000,
    createdAt: 1_000_000,
    failures: 0,
    ...overrides,
  };
}

function stateWith(entries: PoolEntry[], bindings: PoolState["bindings"] = {}): PoolState {
  return { version: 1, entries, bindings };
}

test("adopts a fresh pooled id without probing", async () => {
  const { manager, calls } = await harness({ state: stateWith([entry("good-1")]) });

  assert.equal(await manager.bind(key("s1"), target, 0), "good-1");
  assert.deepEqual(calls, []);
  assert.equal(manager.peek(key("s1")), "good-1");
});

test("probes candidates until one is fast", async () => {
  const { manager, calls, store } = await harness({
    plan: [{ fast: false, reason: "slow" }, { fast: true, upstreamMs: 870 }],
  });

  assert.equal(await manager.bind(key("s1"), target, 5_000), "cand-2");
  assert.deepEqual(calls, ["cand-1", "cand-2"]);

  const persisted = await store.load();
  assert.deepEqual(persisted.entries.map((item) => item.id), ["cand-2"]);
  assert.equal(persisted.entries[0]?.upstreamMs, 870);
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

test("a bound conversation is sticky and never re-probes", async () => {
  const { manager, calls } = await harness({ plan: [{ fast: true }] });
  const first = await manager.bind(key("s1"), target, 5_000);
  const second = await manager.bind(key("s1"), target, 5_000);

  assert.equal(first, "cand-1");
  assert.equal(second, "cand-1");
  assert.deepEqual(calls, ["cand-1"]);
});

test("two live conversations never share one id", async () => {
  const { manager, calls } = await harness({
    state: stateWith([entry("good-1"), entry("good-2", { upstreamMs: 1_200 })]),
    plan: [{ fast: true }],
  });

  assert.equal(await manager.bind(key("s1"), target, 0), "good-1");
  assert.equal(await manager.bind(key("s2"), target, 0), "good-2");
  assert.deepEqual(calls, []);

  // Both pooled ids are leased now, so a third conversation has to probe.
  assert.equal(await manager.bind(key("s3"), target, 5_000), "cand-1");
  assert.deepEqual(calls, ["cand-1"]);
});

test("an expired lease frees its id again", async () => {
  const { manager } = await harness({
    state: stateWith(
      [entry("good-1")],
      {
        [key("old")]: {
          routedId: "good-1",
          provider: target.provider,
          model: target.model,
          boundAt: 0,
          lastSeenAt: 0,
        },
      },
    ),
    config: { leaseTtlMs: 60_000 },
  });

  assert.equal(await manager.bind(key("new"), target, 0), "good-1");
});

test("a slow observation quarantines the id and unbinds the conversation", async () => {
  const { manager, store } = await harness({ state: stateWith([entry("good-1")]) });
  await manager.bind(key("s1"), target, 0);

  await manager.observe(key("s1"), { "server-timing": "gateway;dur=10, upstream;dur=20000" }, 200);

  assert.equal(manager.peek(key("s1")), undefined);
  const persisted = await store.load();
  assert.deepEqual(persisted.entries, []);
  assert.deepEqual(Object.keys(persisted.bindings), []);
});

test("a fast observation refreshes the entry stats", async () => {
  const { manager, store, clock } = await harness({
    state: stateWith([entry("good-1", { upstreamMs: 2_000, verifiedAt: 1 })]),
  });
  await manager.bind(key("s1"), target, 0);

  // Move past the persist throttle so the refreshed stats reach the file.
  clock.value += 10_000;
  await manager.observe(key("s1"), { "server-timing": "upstream;dur=910" }, 200);

  const persisted = await store.load();
  assert.equal(persisted.entries[0]?.upstreamMs, 910);
  assert.equal(persisted.entries[0]?.failures, 0);
});

test("real traffic refreshes the binding lease", async () => {
  const { manager, store, clock } = await harness({
    state: stateWith(
      [entry("good-1")],
      {
        [key("s1")]: {
          routedId: "good-1",
          provider: target.provider,
          model: target.model,
          boundAt: 0,
          lastSeenAt: 0,
        },
      },
    ),
  });
  await manager.bind(key("s1"), target, 0);

  clock.value += 60 * 60_000;
  await manager.observe(key("s1"), { "server-timing": "upstream;dur=1200" }, 200);

  const persisted = await store.load();
  assert.equal(persisted.bindings[key("s1")]?.lastSeenAt, clock.value);
});

test("one degraded observation is tolerated, the second evicts", async () => {
  const { manager } = await harness({
    state: stateWith([entry("good-1")]),
    config: { quarantineFailures: 2, degradeMs: 6_000, quarantineMs: 20_000 },
  });
  await manager.bind(key("s1"), target, 0);

  await manager.observe(key("s1"), { "server-timing": "upstream;dur=7000" }, 200);
  assert.equal(manager.peek(key("s1")), "good-1", "7000ms is a strike but not catastrophic");

  await manager.observe(key("s1"), { "server-timing": "upstream;dur=7100" }, 200);
  assert.equal(manager.peek(key("s1")), undefined);
});

test("ordinary prefill latency is not a strike", async () => {
  const { manager } = await harness({
    state: stateWith([entry("good-1")]),
    config: { degradeMs: 6_000, quarantineMs: 8_000, quarantineFailures: 2 },
  });
  await manager.bind(key("s1"), target, 0);

  for (const upstream of [2600, 3400, 5100]) {
    await manager.observe(key("s1"), { "server-timing": `upstream;dur=${upstream}` }, 200);
    assert.equal(manager.peek(key("s1")), "good-1", `${upstream}ms is normal prefill`);
  }

  await manager.observe(key("s1"), { "server-timing": "upstream;dur=9000" }, 200);
  assert.equal(manager.peek(key("s1")), undefined, "9000ms is catastrophic");
});

test("an overloaded (429) response evicts immediately", async () => {
  const { manager } = await harness({ state: stateWith([entry("good-1")]) });
  await manager.bind(key("s1"), target, 0);

  await manager.observe(key("s1"), { "retry-after-ms": "2303" }, 429);
  assert.equal(manager.peek(key("s1")), undefined);
});

test("a stale binding inside the lease window is reused without a probe", async () => {
  const stale = entry("good-1", { verifiedAt: 1_000_000 - 60 * 60_000 });
  const { manager, calls } = await harness({
    state: stateWith([stale], {
      [key("s1")]: {
        routedId: "good-1",
        provider: target.provider,
        model: target.model,
        boundAt: 1_000_000,
        lastSeenAt: 1_000_000,
      },
    }),
    config: { ttlMs: 30 * 60_000 },
  });

  assert.equal(await manager.bind(key("s1"), target, 5_000), "good-1");
  assert.deepEqual(calls, []);
});

test("a stale entry is not handed to a new conversation", async () => {
  const stale = entry("good-1", { verifiedAt: 1_000_000 - 60 * 60_000 });
  const { manager, calls } = await harness({
    state: stateWith([stale]),
    config: { ttlMs: 30 * 60_000 },
  });

  assert.equal(await manager.bind(key("s2"), target, 0), undefined);
  assert.deepEqual(calls, []);
});

test("refresh tops the pool up to its configured size", async () => {
  const { manager, store, calls } = await harness({
    plan: [{ fast: true }, { fast: true }, { fast: true }],
    config: { size: 3 },
  });
  manager.registerTarget(target);

  await manager.refresh();

  assert.deepEqual(calls, ["cand-1", "cand-2", "cand-3"]);
  const persisted = await store.load();
  assert.equal(persisted.entries.length, 3);
});

test("refresh re-verifies stale entries and drops the slow ones", async () => {
  const stale = entry("good-1", { verifiedAt: 1_000_000 - 60 * 60_000 });
  const { manager, store, calls } = await harness({
    state: stateWith([stale]),
    plan: [{ fast: false, reason: "slow" }],
    config: { size: 1, ttlMs: 30 * 60_000 },
  });
  manager.registerTarget(target);

  await manager.refresh();

  assert.equal(calls[0], "good-1", "the pooled id is re-verified, not replaced blindly");
  const persisted = await store.load();
  assert.equal(persisted.entries.length, 0);
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
  // Sabotage the store mid-flight.
  (manager as unknown as { store: { load: () => Promise<never> } }).store.load = async () => {
    throw new Error("disk on fire");
  };

  assert.equal(await manager.bind(key("s1"), target, 5_000), undefined);
});
