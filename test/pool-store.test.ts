import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  PoolStore,
  emptyState,
  normalizeState,
  pruneState,
} from "../lib/pool-store.ts";

async function tempStore(now = () => 1_000_000): Promise<PoolStore> {
  const dir = await mkdtemp(join(tmpdir(), "pi-ocpool-store-"));
  return new PoolStore({ path: join(dir, "state.json"), now });
}

const entry = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  provider: "opencode-go",
  model: "deepseek-v4.1-flash",
  upstreamMs: 900,
  verifiedAt: 1_000_000,
  createdAt: 1_000_000,
  ...overrides,
});

test("round-trips state atomically", async () => {
  const store = await tempStore();
  const state = emptyState();
  state.entries.push(entry("gw-1"));

  await store.save(state);
  assert.deepEqual(await store.load(), state);

  const files = await readdir(join(store.path, ".."));
  assert.deepEqual(files, ["state.json"], "no temp files left behind");
});

test("missing file loads as an empty state", async () => {
  const store = await tempStore();
  assert.deepEqual(await store.load(), emptyState());
});

test("a corrupt file is quarantined instead of throwing", async () => {
  const store = await tempStore();
  await writeFile(store.path, "{ not json", "utf8");

  assert.deepEqual(await store.load(), emptyState());
  const files = await readdir(join(store.path, ".."));
  assert.ok(files.some((name) => name.startsWith("state.json.corrupt-")), files.join(","));
});

test("normalizeState drops malformed entries and bindings", () => {
  const state = normalizeState({
    version: 99,
    entries: [
      entry("gw-1"),
      { id: "", provider: "p", model: "m", upstreamMs: 1, verifiedAt: 1 },
      { id: "gw-2", provider: "p", model: "m", upstreamMs: "slow", verifiedAt: 1 },
      "garbage",
    ],
    bindings: {
      good: { routedId: "gw-1", provider: "p", model: "m", boundAt: 5 },
      bad: { routedId: "", provider: "p", model: "m", boundAt: 5, lastSeenAt: 5 },
    },
  });

  assert.equal(state.version, 1);
  assert.deepEqual(state.entries.map((item) => item.id), ["gw-1"]);
  assert.deepEqual(Object.keys(state.bindings), ["good"]);
  assert.equal(state.bindings.good?.lastSeenAt, 5);
});

test("pruneState expires idle bindings and caps the table", () => {
  const bindings = Object.fromEntries(
    Array.from({ length: 5 }, (_, index) => [
      `key-${index}`,
      {
        routedId: `gw-${index}`,
        provider: "p",
        model: "m",
        boundAt: index,
        lastSeenAt: index,
        upstreamMs: 900,
        verifiedAt: index,
        failures: 0,
      },
    ]),
  );

  const pruned = pruneState(
    { version: 1, entries: [], bindings },
    { leaseTtlMs: 10, maxBindings: 3, now: 10 },
  );

  assert.equal(Object.keys(pruned.bindings).length, 3);
  assert.deepEqual(Object.keys(pruned.bindings), ["key-4", "key-3", "key-2"]);
});

test("mutate merges with a concurrent writer instead of clobbering", async () => {
  const store = await tempStore();
  await store.save({ version: 1, entries: [entry("gw-1")], bindings: {} });

  // Another pi process appends to the same file after our last read.
  const other = await tempStore();
  other.path; // keep the interface obvious
  const otherStore = new PoolStore({ path: store.path });
  await otherStore.mutate((state) => {
    state.entries.push(entry("gw-2"));
  });

  const result = await store.mutate((state) => {
    state.entries.push(entry("gw-3"));
  });

  assert.deepEqual(result.entries.map((item) => item.id).sort(), ["gw-1", "gw-2", "gw-3"]);
  const persisted = JSON.parse(await readFile(store.path, "utf8"));
  assert.deepEqual(persisted.entries.map((item: { id: string }) => item.id).sort(), [
    "gw-1",
    "gw-2",
    "gw-3",
  ]);
});

test("concurrent mutations from two stores never lose an update", async () => {
  const store = await tempStore();
  const other = new PoolStore({ path: store.path });
  await store.save(emptyState());

  // Both read-modify-write cycles overlap, exactly like two pi processes.
  await Promise.all([
    store.mutate(async (state) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      state.entries.push(entry("gw-a"));
    }),
    other.mutate(async (state) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      state.entries.push(entry("gw-b"));
    }),
  ]);

  const persisted = JSON.parse(await readFile(store.path, "utf8"));
  assert.deepEqual(persisted.entries.map((item: { id: string }) => item.id).sort(), ["gw-a", "gw-b"]);
});

test("concurrent mutations in one process are serialized", async () => {
  const store = await tempStore();
  await store.save(emptyState());

  await Promise.all([
    store.mutate((state) => {
      state.entries.push(entry("gw-a"));
    }),
    store.mutate((state) => {
      state.entries.push(entry("gw-b"));
    }),
    store.mutate((state) => {
      state.bindings.k = {
        routedId: "gw-a",
        provider: "p",
        model: "m",
        boundAt: 1,
        lastSeenAt: 1,
        upstreamMs: 900,
        verifiedAt: 1,
        failures: 0,
      };
    }),
  ]);

  const persisted = JSON.parse(await readFile(store.path, "utf8"));
  assert.deepEqual(persisted.entries.map((item: { id: string }) => item.id).sort(), ["gw-a", "gw-b"]);
  assert.deepEqual(Object.keys(persisted.bindings), ["k"]);
});
