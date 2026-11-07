/**
 * Durable pool storage.
 *
 * The state file is shared by every pi process on the machine, so writes are:
 *
 *  - **atomic** — write a temp file in the same directory, then `rename` over
 *    the target. Readers never see a half-written JSON document.
 *  - **read-modify-write** — `mutate()` re-reads the file before applying the
 *    change, so concurrent sessions merge instead of clobbering each other.
 *  - **serialized in-process** — a promise chain prevents two hooks in the same
 *    process from interleaving their read-modify-write.
 *
 * A corrupt file is moved aside (`.corrupt-<epoch>`) rather than deleted, so a
 * bad write never permanently breaks the extension.
 */
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Binding, PoolEntry, PoolState } from "./types.ts";

export const STATE_VERSION = 1;

export interface StoreFs {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  unlink(path: string): Promise<void>;
}

const defaultFs: StoreFs = {
  readFile: (path, encoding) => readFile(path, encoding),
  writeFile: (path, data, encoding) => writeFile(path, data, encoding),
  rename: (from, to) => rename(from, to),
  mkdir: (path, options) => mkdir(path, options),
  unlink: (path) => unlink(path),
};

export interface PoolStoreOptions {
  path: string;
  now?: () => number;
  fs?: StoreFs;
}

/** A fresh, empty state document. */
export function emptyState(): PoolState {
  return { version: STATE_VERSION, entries: [], bindings: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Validate and normalize one stored entry; returns `undefined` when unusable. */
export function normalizeEntry(value: unknown): PoolEntry | undefined {
  if (!isRecord(value)) return undefined;
  const id = nonEmptyString(value.id);
  const provider = nonEmptyString(value.provider);
  const model = nonEmptyString(value.model);
  const upstreamMs = finiteNumber(value.upstreamMs);
  const verifiedAt = finiteNumber(value.verifiedAt);
  const createdAt = finiteNumber(value.createdAt);
  if (!id || !provider || !model || upstreamMs === undefined || !verifiedAt) return undefined;
  return {
    id,
    provider,
    model,
    upstreamMs: Math.max(0, upstreamMs),
    verifiedAt,
    createdAt: createdAt ?? verifiedAt,
    failures: Math.max(0, finiteNumber(value.failures) ?? 0),
  };
}

/** Validate and normalize one stored binding; returns `undefined` when unusable. */
export function normalizeBinding(value: unknown): Binding | undefined {
  if (!isRecord(value)) return undefined;
  const routedId = nonEmptyString(value.routedId);
  const provider = nonEmptyString(value.provider);
  const model = nonEmptyString(value.model);
  const boundAt = finiteNumber(value.boundAt);
  if (!routedId || !provider || !model || !boundAt) return undefined;
  return {
    routedId,
    provider,
    model,
    boundAt,
    lastSeenAt: finiteNumber(value.lastSeenAt) ?? boundAt,
  };
}

/** Coerce arbitrary parsed JSON into a valid state document. */
export function normalizeState(value: unknown): PoolState {
  if (!isRecord(value)) return emptyState();
  const entries: PoolEntry[] = [];
  for (const raw of Array.isArray(value.entries) ? value.entries : []) {
    const entry = normalizeEntry(raw);
    if (entry) entries.push(entry);
  }
  const bindings: Record<string, Binding> = {};
  const rawBindings = isRecord(value.bindings) ? value.bindings : {};
  for (const [key, raw] of Object.entries(rawBindings)) {
    const binding = normalizeBinding(raw);
    if (binding) bindings[key] = binding;
  }
  return { version: STATE_VERSION, entries, bindings };
}

export interface PruneOptions {
  /** Drop bindings idle for longer than this. */
  leaseTtlMs: number;
  /** Hard cap on bindings, keeping the most recently seen. */
  maxBindings: number;
  now?: number;
}

/** Drop expired bindings and cap the binding table. Entries are kept for the manager to re-verify. */
export function pruneState(state: PoolState, options: PruneOptions): PoolState {
  const now = options.now ?? Date.now();
  const cutoff = now - options.leaseTtlMs;
  const bindings = Object.entries(state.bindings)
    .filter(([, binding]) => binding.lastSeenAt >= cutoff)
    .sort((a, b) => b[1].lastSeenAt - a[1].lastSeenAt)
    .slice(0, options.maxBindings);
  return {
    version: STATE_VERSION,
    entries: state.entries,
    bindings: Object.fromEntries(bindings),
  };
}

/**
 * Serialized, atomic, merge-on-write JSON store.
 *
 * Read failures degrade to an empty state instead of throwing: a broken state
 * file must never stop a conversation from starting.
 */
export class PoolStore {
  readonly path: string;
  private readonly now: () => number;
  private readonly fs: StoreFs;
  private queue: Promise<unknown> = Promise.resolve();
  private tempCounter = 0;

  constructor(options: PoolStoreOptions) {
    this.path = options.path;
    this.now = options.now ?? Date.now;
    this.fs = options.fs ?? defaultFs;
  }

  /** Read and normalize the state file. Never rejects. */
  async load(): Promise<PoolState> {
    try {
      const raw = await this.fs.readFile(this.path, "utf8");
      return normalizeState(JSON.parse(raw) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return emptyState();
      if (error instanceof SyntaxError) {
        await this.quarantineCorruptFile();
        return emptyState();
      }
      return emptyState();
    }
  }

  /** Atomically replace the state file. */
  async save(state: PoolState): Promise<void> {
    const document = `${JSON.stringify(state, null, 2)}\n`;
    await this.fs.mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.${this.tempCounter++}.tmp`;
    try {
      await this.fs.writeFile(temp, document, "utf8");
      await this.fs.rename(temp, this.path);
    } catch (error) {
      await this.fs.unlink(temp).catch(() => {});
      throw error;
    }
  }

  /**
   * Apply `change` to the freshest state and persist the result.
   *
   * The returned state is what was written. If saving fails the in-memory
   * change is still returned to the caller so routing keeps working; only
   * durability is lost.
   */
  async mutate(
    change: (state: PoolState) => PoolState | void | Promise<PoolState | void>,
  ): Promise<PoolState> {
    const run = async (): Promise<PoolState> => {
      const current = pruneState(await this.load(), {
        leaseTtlMs: Number.POSITIVE_INFINITY,
        maxBindings: Number.POSITIVE_INFINITY,
        now: this.now(),
      });
      const result = await change(current);
      const next = result ?? current;
      try {
        await this.save(next);
      } catch {
        // Best effort: keep serving from memory.
      }
      return next;
    };

    const pending = this.queue.then(run, run);
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  private async quarantineCorruptFile(): Promise<void> {
    try {
      await this.fs.rename(this.path, `${this.path}.corrupt-${this.now()}`);
    } catch {
      // Nothing else to do; an empty state is still usable.
    }
  }
}
