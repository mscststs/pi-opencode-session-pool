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
 * The model is deliberately tiny — three actions, nothing else:
 *
 *   1. **probe** a fresh id (1-token request) and, when it is fast, put it in
 *      the pool as a spare;
 *   2. **take** one spare when a conversation starts — it leaves the pool and
 *      belongs to that conversation alone, for good;
 *   3. **refill** the pool in the background so the next conversation can be
 *      served without waiting.
 *
 * There is no recycling. A routed id is never handed to a second conversation:
 * when a conversation is gone its id is retired, and the only way back into the
 * pool is a fresh probe. That keeps the invariant "one conversation, one routed
 * id" and removes any chance of two conversations sharing an upstream shard or
 * a prompt cache slot.
 *
 * The manager never throws into pi: exhaustion, network errors, rate limits and
 * storage failures all degrade to "no routed id", which means pi's own session
 * id is used and behaviour is exactly as before the extension existed.
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

/**
 * Minimum useful probe budget.
 *
 * A fast shard answers in 0.8-2.0 s, so a probe with less time than this would
 * time out a healthy id and throw it away. Below it, stop probing and fall back
 * to pi's session id instead.
 */
const MIN_PROBE_BUDGET_MS = 1_500;

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
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}

export interface PoolStats {
  /** Spare ids waiting to be taken. */
  spares: Array<Pick<PoolEntry, "id" | "provider" | "model" | "upstreamMs" | "verifiedAt">>;
  /** Unowned ids per provider+model. */
  spareCount: Record<string, number>;
  /** Conversations currently holding an id. */
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
  private readonly setTimeoutImpl: typeof setTimeout;
  private readonly clearTimeoutImpl: typeof clearTimeout;

  private state: PoolState | undefined;
  private readonly targets = new Map<string, ProbeTarget>();
  private readonly inflight = new Map<string, Promise<string | undefined>>();
  private readonly touchedAt = new Map<string, number>();
  private lastProbeAt = 0;
  private blockedUntil = 0;
  private lastPersistAt = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private refillTimer: ReturnType<typeof setTimeout> | undefined;
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
    this.setTimeoutImpl = deps.setTimeoutImpl ?? setTimeout;
    this.clearTimeoutImpl = deps.clearTimeoutImpl ?? clearTimeout;
  }

  /** Remember a model so the background refresh can keep it warm. */
  registerTarget(target: ProbeTarget): void {
    this.targets.set(targetKey(target.provider, target.model), target);
  }

  /** The routed id owned by `key`, if that conversation is still alive. */
  peek(key: string): string | undefined {
    const binding = this.state?.bindings[key];
    if (!binding || !this.alive(binding, this.now())) return undefined;
    return binding.routedId;
  }

  /**
   * Take a spare for `key`, or probe a new id when the pool is empty.
   *
   * Never rejects. Returns `undefined` when no verified id was available within
   * `budgetMs`; callers then leave pi's own session id untouched.
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
   * Feed a real provider response back into the conversation's binding.
   *
   * Fast responses keep the lease fresh; degraded ones count toward retirement.
   * Never rejects, and callers are free to ignore the promise (the extension
   * does) so it never blocks the request path.
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
   * Deliberately does not refresh immediately: `bind()` already acquires what
   * the starting conversation needs, and a burst of probes would compete with
   * that first request for the gateway's rate limit.
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

  /** Stop the timers (called on `session_shutdown` for `quit`). */
  stop(): void {
    if (this.timer !== undefined) {
      this.clearIntervalImpl(this.timer);
      this.timer = undefined;
    }
    if (this.refillTimer !== undefined) {
      this.clearTimeoutImpl(this.refillTimer);
      this.refillTimer = undefined;
    }
  }

  /** Snapshot for `scripts/inspect-pool.mjs` and debug logs. */
  stats(): PoolStats {
    const state = this.state;
    const spareCount: Record<string, number> = {};
    for (const entry of state?.entries ?? []) {
      const key = targetKey(entry.provider, entry.model);
      spareCount[key] = (spareCount[key] ?? 0) + 1;
    }
    return {
      spares: (state?.entries ?? []).map((entry) => ({
        id: entry.id,
        provider: entry.provider,
        model: entry.model,
        upstreamMs: entry.upstreamMs,
        verifiedAt: entry.verifiedAt,
      })),
      spareCount,
      bindings: Object.keys(state?.bindings ?? {}).length,
      targets: [...this.targets.keys()],
    };
  }

  /** Retire expired conversations, re-verify spares and refill. Safe to call concurrently. */
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
    await this.ensureLoaded();
    const now = this.now();

    // 1. Same conversation resuming: its id is still its own.
    const binding = this.state?.bindings[key];
    if (binding && binding.provider === target.provider && binding.model === target.model) {
      if (this.alive(binding, now)) {
        await this.touch(key, now);
        return binding.routedId;
      }
      this.log.debug(`retiring dead binding ${key} -> ${binding.routedId}`);
      await this.retireBinding(key, binding);
    }

    // 2. Take a spare that was verified within the TTL: no probe at all.
    const spare = this.pickSpare(target, now, true);
    if (spare) {
      await this.take(key, target, spare);
      this.log.debug(
        `took spare id=${spare.id} upstream=${Math.round(spare.upstreamMs)}ms for ${target.provider}/${target.model}`,
      );
      return spare.id;
    }

    // 3. A stale spare: verify that exact id before handing it out. Re-using a
    //    known id is cheaper than discovering a new one, and still 1:1.
    const stale = this.pickSpare(target, now, false);
    if (stale) {
      const result = await this.probeWithin(stale.id, target, budgetMs);
      if (result.fast) {
        await this.take(key, target, {
          ...stale,
          upstreamMs: result.upstreamMs ?? stale.upstreamMs,
          verifiedAt: this.now(),
        });
        this.log.debug(`took re-verified spare id=${stale.id} upstream=${result.upstreamMs ?? "?"}ms`);
        return stale.id;
      }
      await this.dropSpare(stale);
      this.log.debug(`dropped stale spare ${stale.id} (${result.reason})`);
      // Rejected credentials or an active 429 backoff: more probes cannot help.
      if (this.isTerminal(result) || result.reason === "overloaded") return undefined;
    }

    // 4. Probe fresh candidates until one is fast.
    return this.probeUntilFast(key, target, budgetMs);
  }

  /** Probe one id inside a budget and classify it. */
  private async probeWithin(id: string, target: ProbeTarget, budgetMs: number): Promise<ProbeResult> {
    if (budgetMs < MIN_PROBE_BUDGET_MS) {
      return { fast: false, status: 0, reason: "timeout" };
    }
    const deadline = this.now() + budgetMs;
    await this.waitForProbeSlot(deadline);
    const now = this.now();
    if (now < this.blockedUntil || now >= deadline) {
      return { fast: false, status: 0, reason: "overloaded" };
    }
    return this.prober.probe(id, target, deadline - now);
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
      const now = this.now();
      // Still inside a 429 backoff window (the deadline did not allow sleeping
      // it off) — probing now would ignore the gateway's Retry-After.
      if (now < this.blockedUntil || now >= deadline) break;

      const id = this.randomId();
      const result = await this.prober.probe(id, target, deadline - now);
      if (result.fast) {
        await this.take(key, target, {
          id,
          provider: target.provider,
          model: target.model,
          upstreamMs: result.upstreamMs ?? 0,
          verifiedAt: this.now(),
          createdAt: this.now(),
        });
        this.log.debug(`probed fast id=${id} upstream=${result.upstreamMs ?? "?"}ms`);
        return id;
      }

      this.log.debug(`candidate ${id} rejected (${result.reason})`);
      if (this.isTerminal(result)) break;
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

    const timing = timingFromHeaders(headers);
    const upstreamMs = timing.upstreamMs;
    const now = this.now();
    // Real traffic proves the conversation is alive, so keep the lease fresh.
    binding.lastSeenAt = now;

    if (upstreamMs === undefined && status !== 429) {
      await this.persistThrottled();
      return;
    }

    const overloaded = status === 429;
    // A real request also pays prompt prefill, so the strike threshold is
    // higher than the probe ceiling; only pathological values count.
    const degraded = overloaded || (upstreamMs !== undefined && upstreamMs >= this.config.degradeMs);
    const catastrophic = overloaded || (upstreamMs !== undefined && upstreamMs >= this.config.quarantineMs);

    if (!degraded) {
      binding.failures = 0;
      binding.upstreamMs = upstreamMs ?? binding.upstreamMs;
      binding.verifiedAt = now;
      await this.persistThrottled();
      return;
    }

    binding.failures += 1;
    this.log.debug(
      `slow observation ${key}: upstream=${upstreamMs ?? "?"}ms status=${status} failures=${binding.failures}`,
    );
    if (!catastrophic && binding.failures < this.config.quarantineFailures) {
      await this.persistThrottled(true);
      return;
    }

    await this.retireBinding(key, binding);
    this.log.debug(`retired id=${binding.routedId} (${key}) after ${binding.failures} strike(s)`);
  }

  private async doRefresh(): Promise<void> {
    await this.ensureLoaded();
    const now = this.now();

    // Retire expired conversations. Their ids are gone for good.
    await this.mutate((draft) => {
      const pruned = pruneState(draft, {
        leaseTtlMs: this.config.leaseTtlMs,
        maxBindings: this.config.maxBindings,
        now,
      });
      draft.entries = pruned.entries;
      draft.bindings = pruned.bindings;
    });

    let probes = 0;
    const maxProbes = Math.max(this.config.size * 2, 2);

    for (const target of this.targets.values()) {
      // Re-verify spare ids only; ids owned by a conversation are validated by
      // that conversation's real traffic.
      for (const entry of this.sparesFor(target)) {
        if (probes >= maxProbes) break;
        if (this.isFresh(entry, now)) continue;
        const result = await this.probeOne(target, entry.id);
        probes += 1;
        if (result.fast) {
          await this.mutate((draft) => {
            const existing = this.spareIn(draft, entry.id, target);
            if (existing) {
              existing.upstreamMs = result.upstreamMs ?? existing.upstreamMs;
              existing.verifiedAt = this.now();
            }
          });
        } else if (this.isTerminal(result)) {
          return;
        } else {
          await this.dropSpare(entry);
        }
      }

      const freshSpares = this.sparesFor(target).filter((entry) => this.isFresh(entry, this.now())).length;
      let missing = this.config.size - freshSpares;
      while (missing > 0 && probes < maxProbes) {
        missing -= 1;
        const result = await this.probeOne(target);
        probes += 1;
        if (result.fast && result.id) {
          await this.mutate((draft) => {
            this.addSpare(draft, {
              id: result.id as string,
              provider: target.provider,
              model: target.model,
              upstreamMs: result.upstreamMs ?? 0,
              verifiedAt: this.now(),
              createdAt: this.now(),
            });
          });
        } else if (this.isTerminal(result)) {
          break;
        }
      }
    }

    if (probes > 0) await this.persistThrottled(true);
  }

  /** Probe one candidate (or re-verify a spare id) with the default timeout. */
  private async probeOne(target: ProbeTarget, id?: string): Promise<ProbeResult & { id?: string }> {
    await this.waitForProbeSlot(Number.POSITIVE_INFINITY);
    const candidate = id ?? this.randomId();
    const result = await this.prober.probe(candidate, target);
    if (result.reason === "overloaded") this.block(result.retryAfterMs ?? this.config.minProbeIntervalMs);
    return { ...result, id: candidate };
  }

  /** Hand `entry` to `key` and remove it from the pool. */
  private async take(key: string, target: ProbeTarget, entry: PoolEntry): Promise<void> {
    await this.mutate((draft) => {
      draft.entries = draft.entries.filter(
        (candidate) =>
          !(
            candidate.id === entry.id &&
            candidate.provider === target.provider &&
            candidate.model === target.model
          ),
      );
      draft.bindings[key] = {
        routedId: entry.id,
        provider: target.provider,
        model: target.model,
        boundAt: this.now(),
        lastSeenAt: this.now(),
        upstreamMs: entry.upstreamMs,
        verifiedAt: entry.verifiedAt,
        failures: 0,
      };
    });
    this.scheduleRefill();
  }

  private async retireBinding(key: string, binding: Binding): Promise<void> {
    await this.mutate((draft) => {
      const current = draft.bindings[key];
      if (current?.routedId === binding.routedId) delete draft.bindings[key];
    });
    this.scheduleRefill();
  }

  /** Ask for a refill shortly after a spare was consumed. */
  private scheduleRefill(): void {
    if (this.config.refillDelayMs <= 0) return;
    if (this.refillTimer !== undefined) return;
    const timer = this.setTimeoutImpl(() => {
      this.refillTimer = undefined;
      void this.refresh();
    }, this.config.refillDelayMs);
    timer.unref?.();
    this.refillTimer = timer;
  }

  private pickSpare(target: ProbeTarget, now: number, freshOnly: boolean): PoolEntry | undefined {
    const own = this.sparesFor(target);
    const candidates = freshOnly ? own.filter((entry) => this.isFresh(entry, now)) : own;
    return candidates.sort((a, b) => a.upstreamMs - b.upstreamMs)[0];
  }

  private sparesFor(target: ProbeTarget): PoolEntry[] {
    return (this.state?.entries ?? []).filter(
      (entry) => entry.provider === target.provider && entry.model === target.model,
    );
  }

  private spareIn(state: PoolState, id: string, target: ProbeTarget): PoolEntry | undefined {
    return state.entries.find(
      (entry) => entry.id === id && entry.provider === target.provider && entry.model === target.model,
    );
  }

  private addSpare(state: PoolState, entry: PoolEntry): void {
    const exists = state.entries.some(
      (candidate) =>
        candidate.id === entry.id &&
        candidate.provider === entry.provider &&
        candidate.model === entry.model,
    );
    if (!exists) state.entries.push(entry);
  }

  private async dropSpare(entry: PoolEntry): Promise<void> {
    await this.mutate((draft) => {
      draft.entries = draft.entries.filter(
        (candidate) =>
          !(
            candidate.id === entry.id &&
            candidate.provider === entry.provider &&
            candidate.model === entry.model
          ),
      );
    });
  }

  /** Fresh enough to hand out without verification. */
  private isFresh(entry: PoolEntry, now: number): boolean {
    return now - entry.verifiedAt <= this.config.ttlMs;
  }

  /** A binding whose conversation is still considered active. */
  private alive(binding: Binding, now: number): boolean {
    return now - binding.lastSeenAt <= this.config.leaseTtlMs && binding.failures < this.config.quarantineFailures;
  }

  /** Probing makes no sense any more: rejected credentials or an invalid request. */
  private isTerminal(result: ProbeResult): boolean {
    return result.reason === "unauthorized" || result.reason === "rejected";
  }

  private async touch(key: string, now: number): Promise<void> {
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
