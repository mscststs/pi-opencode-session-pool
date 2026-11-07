/**
 * pi-opencode-session-pool
 *
 * Pins every OpenCode request of a conversation to a pre-verified
 * fast-routing `x-opencode-session` id.
 *
 * Why: OpenCode's gateway hashes that header onto an upstream shard and keeps
 * the mapping sticky. Around half of all ids land on an overloaded relay whose
 * `server-timing` reports `upstream;dur` of 10-43 s instead of ~1 s, and a slow
 * conversation stays slow. pi hands out a fresh random id per conversation, so
 * every new session is a coin flip. This extension verifies ids first, keeps
 * the fast ones in a durable pool (~/.pi/opencode-session-pool.json), and
 * rewrites the header before the request leaves the process.
 *
 * How it hooks in:
 *   - `session_start` fills/warms the pool and pins the conversation up front.
 *   - `before_provider_headers` rewrites `x-opencode-session` (and lazily binds
 *     when the model changed mid-conversation).
 *   - `after_provider_response` feeds real latency back so bad ids are evicted.
 *   - `session_shutdown` stops the background refresh timer on quit.
 *
 * Everything is scoped to OpenCode (`provider` starting with `opencode` or a
 * `opencode.ai` base URL) and to the `openai-completions` transport. Other
 * providers, models and APIs are never touched, and any failure degrades to
 * pi's own session id.
 *
 * Controls: see `readConfig` in `lib/config.ts` (`PI_OCPOOL_*`).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { readConfig, SESSION_HEADER, type PoolConfig } from "../lib/config.ts";
import { createLogger, type Logger } from "../lib/logger.ts";
import { PoolManager } from "../lib/pool-manager.ts";
import { PoolStore } from "../lib/pool-store.ts";
import { createProber } from "../lib/probe.ts";
import { bindingKey, isOpenCodeModel, resolveTarget, supportsProbing } from "../lib/targets.ts";
import type { ProbeTarget } from "../lib/types.ts";

const MANAGER_KEY = Symbol.for("pi-opencode-session-pool.manager");

interface ManagerState {
  manager: PoolManager;
  config: PoolConfig;
  log: Logger;
}

/**
 * The manager is process-wide, not session-wide: pi reloads extensions when the
 * session is replaced, and rebuilding the pool (and its refresh timer) on every
 * reload would throw away the warm state.
 */
function getManager(): ManagerState {
  const slot = globalThis as unknown as Record<symbol, ManagerState | undefined>;
  const existing = slot[MANAGER_KEY];
  if (existing) return existing;

  const config = readConfig();
  const log = createLogger(config.debug);
  const manager = new PoolManager({
    config,
    store: new PoolStore({ path: config.statePath }),
    prober: createProber({
      config: {
        probeTimeoutMs: config.probeTimeoutMs,
        maxUpstreamMs: config.maxUpstreamMs,
        requireGatewayId: config.requireGatewayId,
      },
      log,
    }),
    log,
  });

  const state: ManagerState = { manager, config, log };
  slot[MANAGER_KEY] = state;
  return state;
}

/** Resolve the active model into a ready-to-probe target, or `undefined`. */
async function resolveTargetFor(
  ctx: ExtensionContext,
  model: Model<Api> | undefined,
): Promise<ProbeTarget | undefined> {
  const active = model ?? ctx.model;
  if (!active) return undefined;
  if (!isOpenCodeModel(active)) return undefined;

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(active);
  if (!auth.ok) return undefined;

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(auth.headers ?? {})) {
    if (typeof value === "string") headers[key] = value;
  }

  return resolveTarget(
    { id: active.id, provider: active.provider, api: active.api, baseUrl: active.baseUrl },
    { apiKey: auth.apiKey, headers },
  );
}

function sessionKey(ctx: ExtensionContext, provider: string, model: string): string {
  return bindingKey(ctx.sessionManager.getSessionId(), provider, model);
}

export default function opencodeSessionPool(pi: ExtensionAPI): void {
  const { manager, config, log } = getManager();
  if (!config.enabled) return;

  pi.on("session_start", async (_event, ctx) => {
    manager.start();
    try {
      const target = await resolveTargetFor(ctx, ctx.model);
      if (!target) return;
      manager.registerTarget(target);
      const key = sessionKey(ctx, target.provider, target.model);
      const routed = await manager.bind(key, target, config.startupBudgetMs);
      log.debug(
        routed
          ? `session ${ctx.sessionManager.getSessionId()} pinned to ${routed} (${target.provider}/${target.model})`
          : `session ${ctx.sessionManager.getSessionId()} has no pooled id yet; pi's id stays in place`,
      );
    } catch (error) {
      log.debug(`session_start failed: ${(error as Error)?.message ?? String(error)}`);
    }
  });

  pi.on("before_provider_headers", async (event, ctx) => {
    try {
      const model = ctx.model;
      if (!model || !supportsProbing(model)) return;

      // Hot path: the conversation is already bound, so no auth resolution and
      // no async work is needed before the header is written.
      const key = sessionKey(ctx, model.provider, model.id);
      const bound = manager.peek(key);
      if (bound) {
        event.headers[SESSION_HEADER] = bound;
        return;
      }

      const target = await resolveTargetFor(ctx, model);
      if (!target) return;
      manager.registerTarget(target);
      const routed = await manager.bind(key, target, config.requestBudgetMs);
      if (routed) event.headers[SESSION_HEADER] = routed;
    } catch (error) {
      // Never break a request because of routing.
      log.debug(`before_provider_headers failed: ${(error as Error)?.message ?? String(error)}`);
    }
  });

  pi.on("after_provider_response", (event, ctx) => {
    try {
      const model = ctx.model;
      if (!model || !supportsProbing(model)) return;
      void manager.observe(sessionKey(ctx, model.provider, model.id), event.headers, event.status);
    } catch (error) {
      log.debug(`after_provider_response failed: ${(error as Error)?.message ?? String(error)}`);
    }
  });

  pi.on("session_shutdown", (event) => {
    if (event.reason === "quit") manager.stop();
  });
}
