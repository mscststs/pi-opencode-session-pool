/**
 * The session pool.
 *
 * Problem: OpenCode's gateway hashes `x-opencode-session` onto an upstream
 * shard. Roughly half of all session ids land on an overloaded relay that
 * answers with `upstream;dur` between 10 and 43 seconds instead of ~1 second,
 * and the mapping is sticky — a slow conversation stays slow for its whole
 * life. pi generates a fresh random id per conversation, so new conversations
 * are a coin flip.
 *
 * Solution: verify ids before they are used and keep the fast ones in a pool.
 *
 *  1. `bind()` resolves a conversation (pi session id + provider + model) to a
 *     already-verified id from the pool — no probe on the happy path.
 *  2. When the pool is empty, ids are probed sequentially inside a time budget
 *     (a probe is a real 1-token request, and roughly 50% of candidates are
 *     fast). The first fast id is adopted for the whole conversation.
 *  3. `observe()` watches every real request through `server-timing`. Ids that
 *     turn slow are quarantined and the conversation rebinds.
 *  4. A background refresh keeps `size` fresh ids per provider+model and
 *     re-verifies entries older than `ttlMs`.
 *
 * The manager never throws into pi: exhaustion, network errors and storage
 * failures all degrade to "no routed id", which means pi's own session id is
 * used and behaviour is exactly as before the extension existed.
 */
import { randomUUID } from "node:crypto";
import type { PoolConfig } from "./config.ts";
import { silentLogger, type Logger } from "./logger.ts";
import { timingFromHeaders, type Prober } from "./probe.ts";
import { pruneState, type PoolStore } from "./pool-store.ts";
import { targetKey } from "./targets.ts";
import type { Binding, PoolEntry, PoolState, ProbeResult, ProbeTarget } from "./types.ts";

/** How often a repeated `observe()` may rewrite the state file. */
const PERSIST_INTERVAL_MS = 5_000;

/** Never persist a binding touch more often than this. */
const TOUCH_INTERVAL_MS = 30_000;

/** Minimum useful probe budget; below this the probe would be cut off anyway. */
const MIN_PROBE_BUDGET_MS = 500;

export interface PoolManagerDeps {
  config: PoolConfig;
  store: PoolStore;
  prober: Prober;
  now?: () => number;
  randomId?: () => string;
  log?: Logger;
  sleep?: (ms: number) => Promise<void>;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
}

export interface PoolStats {
  entries: Array<Pick<PoolEntry, "id" | "provider" | "model" | "upstreamMs" | "verifiedAt" | "failures">>;
  bindings: number;
  targets: string[];
}

export class PoolManager {
  private readonly config: PoolConfig;
  private readonly store: PoolStore;
  private readonly prober: Prober;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly log: Logger;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly setIntervalImpl: typeof setInterval;
  private readonly clearIntervalImpl: typeof clearInterval;

  private state: PoolState | undefined;
  private readonly targets = new Map<string, ProbeTarget>();
  private readonly inflight = new Map<string, Promise<string | undefined>>();
  private readonly touchedAt = new Map<string, number>();
  private lastProbeAt = 0;
  private blockedUntil = 0;
  private lastPersistAt = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private refreshInFlight: Promise<void> | undefined;

  constructor(deps: PoolManagerDeps) {
    this.config = deps.config;
    this.store = deps.store;
    this.prober = deps.prober;
    this.now = deps.now ?? Date.now;
    this.randomId = deps.randomId ?? randomUUID;
    this.log = deps.log ?? silentLogger;
    this.sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.setIntervalImpl = deps.setIntervalImpl ?? setInterval;
    this.clearIntervalImpl = deps.clearIntervalImpl ?? clearInterval;
  }

  /** Remember a model so the background refresh can keep it warm. */
  registerTarget(target: ProbeTarget): void {
    this.targets.set(targetKey(target.provider, target.model), target);
  }

  /** The routed id currently bound to `key`, if it is still usable. */
  peek(key: string): string | undefined {
    const binding = this.state?.bindings[key];
    if (!binding) return undefined;
    if (!this.entryFor(binding.routedId, binding.provider, binding.model)) return undefined;
    return binding.routedId;
  }

  /**
   * Resolve `key` to a fast routed id, filling the pool if necessary.
   *
   * Never rejects. Returns `undefined` when no fast id was found within
   * `budgetMs`; callers should then leave pi's own session id untouched.
   */
  bind(key: string, target: ProbeTarget, budgetMs: number): Promise<string | undefined> {
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const pending = this.acquire(key, target, budgetMs)
      .catch((error: unknown) => {
        this.log.debug(`bind ${key} failed: ${(error as Error)?.message ?? String(error)}`);
        return undefined;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, pending);
    return pending;
  }

  /**
   * Feed a real provider response back into the pool.
   *
   * Fast responses refresh the entry's stats; slow or overloaded ones count
   * toward quarantine. Never rejects, and callers are free to ignore the
   * promise (the extension does) so it never blocks the request path.
   */
  observe(
    key: string,
    headers: Record<string, string | undefined>,
    status: number,
  ): Promise<void> {
    return this.applyObservation(key, headers, status).catch((error: unknown) => {
      this.log.debug(`observe ${key} failed: ${(error as Error)?.message ?? String(error)}`);
    });
  }

  /**
   * Start the background refresh timer. Idempotent.
   *
   * Deliberately does not refresh immediately: `bind()` already fills the pool
   * on demand for the conversation that is starting, and probing the remaining
   * slots right at startup would compete with that first request for the
   * gateway's rate limit.
   */
  start(): void {
    if (this.timer !== undefined) return;
    if (this.config.refreshIntervalMs <= 0) return;
    const timer = this.setIntervalImpl(() => {
      void this.refresh();
    }, this.config.refreshIntervalMs);
    timer.unref?.();
    this.timer = timer;
  }

  /** Stop the background timer (called on `session_shutdown` for `quit`). */
  stop(): void {
    if (this.timer === undefined) return;
    this.clearIntervalImpl(this.timer);
    this.timer = undefined;
  }

  /** Snapshot for `scripts/inspect-pool.mjs` and debug logs. */
  stats(): PoolStats {
    const state = this.state;
    return {
      entries: (state?.entries ?? []).map((entry) => ({
        id: entry.id,
        provider: entry.provider,
        model: entry.model,
        upstreamMs: entry.upstreamMs,
        verifiedAt: entry.verifiedAt,
        failures: entry.failures,
      })),
      bindings: Object.keys(state?.bindings ?? {}).length,
      targets: [...this.targets.keys()],
    };
  }

  /** Re-verify stale entries and top the pool up. Safe to call concurrently. */
  refresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const pending = this.doRefresh()
      .catch((error: unknown) => {
        this.log.debug(`refresh failed: ${(error as Error)?.message ?? String(error)}`);
      })
      .finally(() => {
        this.refreshInFlight = undefined;
      });
    this.refreshInFlight = pending;
    return pending;
  }

  // ---------------------------------------------------------------- internals

  private async acquire(key: string, target: ProbeTarget, budgetMs: number): Promise<string | undefined> {
    this.registerTarget(target);
    const state = await this.ensureLoaded();
    const now = this.now();

    const binding = state.bindings[key];
    if (binding && binding.provider === target.provider && binding.model === target.model) {
      const entry = this.entryFor(binding.routedId, target.provider, target.model);
      if (entry && this.usable(entry, now)) {
        await this.touch(key, entry, now);
        return binding.routedId;
      }
      this.log.debug(`dropping unusable binding ${key} -> ${binding.routedId}`);
      await this.mutate((draft) => {
        delete draft.bindings[key];
        this.dropEntry(draft, binding.routedId, target.provider, target.model);
      });
    }

    const pooled = this.pickPooled(target, key, now);
    if (pooled) {
      await this.mutate((draft) => {
        this.putBinding(draft, key, target, pooled.id, now);
      });
      this.log.debug(
        `adopted pooled id=${pooled.id} upstream=${Math.round(pooled.upstreamMs)}ms for ${target.provider}/${target.model}`,
      );
      return pooled.id;
    }

    return this.probeUntilFast(key, target, budgetMs);
  }

  private async probeUntilFast(
    key: string,
    target: ProbeTarget,
    budgetMs: number,
  ): Promise<string | undefined> {
    const deadline = this.now() + Math.max(0, budgetMs);
    if (budgetMs < MIN_PROBE_BUDGET_MS) {
      this.log.debug(`skip probing ${target.provider}/${target.model}: budget ${budgetMs}ms too small`);
      return undefined;
    }

    while (this.now() < deadline) {
      const remaining = deadline - this.now();
      if (remaining < MIN_PROBE_BUDGET_MS) break;
      await this.waitForProbeSlot(deadline);
      if (this.now() >= deadline) break;

      const id = this.randomId();
      const result = await this.prober.probe(id, target, deadline - this.now());
      if (result.fast) {
        await this.mutate((draft) => {
          this.upsertEntry(draft, id, target, result.upstreamMs ?? 0, this.now());
          this.putBinding(draft, key, target, id, this.now());
        });
        this.log.debug(`probed fast id=${id} upstream=${result.upstreamMs ?? "?"}ms`);
        return id;
      }

      this.log.debug(`candidate ${id} rejected (${result.reason})`);
      if (result.reason === "unauthorized" || result.reason === "rejected") break;
      if (result.reason === "overloaded") {
        this.block(result.retryAfterMs ?? this.config.minProbeIntervalMs);
      }
    }

    this.log.debug(
      `no fast id for ${target.provider}/${target.model} within ${budgetMs}ms; keeping pi's session id`,
    );
    return undefined;
  }

  private async applyObservation(
    key: string,
    headers: Record<string, string | undefined>,
    status: number,
  ): Promise<void> {
    const state = await this.ensureLoaded();
    const binding = state.bindings[key];
    if (!binding) return;
    const entry = this.entryFor(binding.routedId, binding.provider, binding.model);
    if (!entry) return;

    const timing = timingFromHeaders(headers);
    const upstreamMs = timing.upstreamMs;
    const now = this.now();
    const overloaded = status === 429;
    // "degraded" costs one strike; "catastrophic" ejects immediately.
    // The strike threshold is higher than the probe ceiling because a real
    // request also pays prompt prefill; only pathological values count.
    const degraded = overloaded || (upstreamMs !== undefined && upstreamMs >= this.config.degradeMs);
    const catastrophic = overloaded || (upstreamMs !== undefined && upstreamMs >= this.config.quarantineMs);

    if (upstreamMs === undefined && !overloaded) return;

    if (!degraded) {
      entry.failures = 0;
      entry.upstreamMs = upstreamMs ?? entry.upstreamMs;
      entry.verifiedAt = now;
      await this.persistThrottled();
      return;
    }

    entry.failures += 1;
    this.log.debug(
      `slow observation ${key}: upstream=${upstreamMs ?? "?"}ms status=${status} failures=${entry.failures}`,
    );
    if (!catastrophic && entry.failures < this.config.quarantineFailures) {
      await this.persistThrottled(true);
      return;
    }

    await this.mutate((draft) => {
      this.dropEntry(draft, binding.routedId, binding.provider, binding.model);
      delete draft.bindings[key];
    });
    this.log.debug(`quarantined id=${binding.routedId} (${key})`);
  }

  private async doRefresh(): Promise<void> {
    const state = await this.ensureLoaded();
    const now = this.now();

    const pruned = pruneState(state, {
      leaseTtlMs: this.config.leaseTtlMs,
      maxBindings: this.config.maxBindings,
      now,
    });
    this.state = pruned;

    let probes = 0;
    const maxProbes = Math.max(this.config.size * 2, 2);

    for (const target of this.targets.values()) {
      const own = this.entriesFor(target);

      // Re-verify stale entries first: keeping a known-good id is cheaper than
      // discovering a new one, and it preserves prompt-cache locality.
      for (const entry of own) {
        if (this.isFresh(entry, now) || probes >= maxProbes) continue;
        const result = await this.probeOne(target, entry.id);
        probes += 1;
        if (result.fast) {
          await this.mutate((draft) => {
            this.upsertEntry(draft, entry.id, target, result.upstreamMs ?? 0, this.now());
          });
        } else if (result.reason === "unauthorized" || result.reason === "rejected") {
          return;
        } else {
          await this.mutate((draft) => {
            this.dropEntry(draft, entry.id, target.provider, target.model);
            for (const [key, binding] of Object.entries(draft.bindings)) {
              if (binding.routedId === entry.id) delete draft.bindings[key];
            }
          });
        }
      }

      const freshNow = this.entriesFor(target).filter((entry) => this.isFresh(entry, this.now())).length;
      let missing = this.config.size - freshNow;
      while (missing > 0 && probes < maxProbes) {
        missing -= 1;
        const result = await this.probeOne(target);
        probes += 1;
        if (result.fast && result.id) {
          await this.mutate((draft) => {
            this.upsertEntry(draft, result.id as string, target, result.upstreamMs ?? 0, this.now());
          });
        } else if (result.reason === "unauthorized" || result.reason === "rejected") {
          break;
        }
      }
    }

    if (probes > 0) await this.persistThrottled(true);
  }

  private async probeOne(target: ProbeTarget, id?: string): Promise<ProbeResult & { id?: string }> {
    await this.waitForProbeSlot(Infinity);
    const candidate = id ?? this.randomId();
    const result = await this.prober.probe(candidate, target);
    if (result.reason === "overloaded") this.block(result.retryAfterMs ?? this.config.minProbeIntervalMs);
    return { ...result, id: candidate };
  }

  private pickPooled(target: ProbeTarget, key: string, now: number): PoolEntry | undefined {
    const leased = this.leasedIds(key, now);
    return this.entriesFor(target)
      .filter((entry) => this.isFresh(entry, now) && !leased.has(entry.id))
      .sort((a, b) => a.upstreamMs - b.upstreamMs)[0];
  }

  /** Ids currently reserved by another live conversation for this provider+model. */
  private leasedIds(ownKey: string, now: number): Set<string> {
    const ids = new Set<string>();
    for (const [key, binding] of Object.entries(this.state?.bindings ?? {})) {
      if (key === ownKey) continue;
      if (binding.lastSeenAt < now - this.config.leaseTtlMs) continue;
      ids.add(binding.routedId);
    }
    return ids;
  }

  private entriesFor(target: ProbeTarget): PoolEntry[] {
    return (this.state?.entries ?? []).filter(
      (entry) => entry.provider === target.provider && entry.model === target.model,
    );
  }

  private entryFor(id: string, provider: string, model: string): PoolEntry | undefined {
    return (this.state?.entries ?? []).find(
      (entry) => entry.id === id && entry.provider === provider && entry.model === model,
    );
  }

  /** Fresh enough to reuse without verification. */
  private isFresh(entry: PoolEntry, now: number): boolean {
    return now - entry.verifiedAt <= this.config.ttlMs;
  }

  /** Fresh or still within the lease window: usable right now. */
  private usable(entry: PoolEntry, now: number): boolean {
    return now - entry.verifiedAt <= this.config.leaseTtlMs && entry.failures < this.config.quarantineFailures;
  }

  private upsertEntry(draft: PoolState, id: string, target: ProbeTarget, upstreamMs: number, now: number): void {
    const existing = draft.entries.find(
      (entry) => entry.id === id && entry.provider === target.provider && entry.model === target.model,
    );
    if (existing) {
      existing.upstreamMs = upstreamMs;
      existing.verifiedAt = now;
      existing.failures = 0;
      return;
    }
    draft.entries.push({
      id,
      provider: target.provider,
      model: target.model,
      upstreamMs,
      verifiedAt: now,
      createdAt: now,
      failures: 0,
    });
  }

  private dropEntry(draft: PoolState, id: string, provider: string, model: string): void {
    draft.entries = draft.entries.filter(
      (entry) => !(entry.id === id && entry.provider === provider && entry.model === model),
    );
  }

  private putBinding(draft: PoolState, key: string, target: ProbeTarget, id: string, now: number): void {
    const previous = draft.bindings[key];
    const binding: Binding = {
      routedId: id,
      provider: target.provider,
      model: target.model,
      boundAt: previous?.boundAt ?? now,
      lastSeenAt: now,
    };
    draft.bindings[key] = binding;
  }

  private async touch(key: string, entry: PoolEntry, now: number): Promise<void> {
    void entry;
    const last = this.touchedAt.get(key) ?? 0;
    if (now - last < TOUCH_INTERVAL_MS) return;
    this.touchedAt.set(key, now);
    await this.mutate((draft) => {
      const binding = draft.bindings[key];
      if (binding) binding.lastSeenAt = now;
    });
  }

  private async ensureLoaded(): Promise<PoolState> {
    if (this.state) return this.state;
    this.state = await this.store.load();
    return this.state;
  }

  private async mutate(change: (draft: PoolState) => void): Promise<void> {
    this.state = await this.store.mutate((draft) => {
      change(draft);
      return draft;
    });
    this.lastPersistAt = this.now();
  }

  private persistThrottled(force = false): Promise<void> {
    const now = this.now();
    if (!force && now - this.lastPersistAt < PERSIST_INTERVAL_MS) return Promise.resolve();
    const snapshot = this.state;
    if (!snapshot) return Promise.resolve();
    this.lastPersistAt = now;
    return this.store.save(snapshot).catch((error: unknown) => {
      this.log.debug(`persist failed: ${(error as Error)?.message ?? String(error)}`);
    });
  }

  private block(ms: number): void {
    const until = this.now() + Math.max(0, ms);
    if (until > this.blockedUntil) this.blockedUntil = until;
  }

  private async waitForProbeSlot(deadline: number): Promise<void> {
    const now = this.now();
    const waitUntil = Math.max(this.lastProbeAt + this.config.minProbeIntervalMs, this.blockedUntil);
    const wait = waitUntil - now;
    if (wait > 0 && now + wait < deadline) await this.sleep(wait);
    this.lastProbeAt = this.now();
  }
}
