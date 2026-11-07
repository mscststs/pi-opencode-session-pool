import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import opencodeSessionPool from "../extensions/index.ts";

const MANAGER_KEY = Symbol.for("pi-opencode-session-pool.manager");

const opencodeModel = {
  id: "deepseek-v4.1-flash",
  provider: "opencode-go",
  api: "openai-completions",
  baseUrl: "https://opencode.ai/inference/go/openai/v1",
};

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface Fixture {
  handlers: Map<string, Handler>;
  statePath: string;
  authCalls: () => number;
}

async function setup(options: { state?: unknown } = {}): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "pi-ocpool-ext-"));
  const statePath = join(dir, "state.json");
  if (options.state) await writeFile(statePath, JSON.stringify(options.state), "utf8");

  process.env.PI_OCPOOL_STATE_PATH = statePath;
  process.env.PI_OCPOOL_REFRESH_INTERVAL_MS = "0";
  process.env.PI_OCPOOL_STARTUP_BUDGET_MS = "0";
  process.env.PI_OCPOOL_REQUEST_BUDGET_MS = "0";
  delete (globalThis as unknown as Record<symbol, unknown>)[MANAGER_KEY];

  const handlers = new Map<string, Handler>();
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
  } as unknown as ExtensionAPI;
  opencodeSessionPool(pi);

  return { handlers, statePath, authCalls: () => 0 };
}

function context(
  fixture: Fixture,
  options: { model?: unknown; sessionId?: string; auth?: unknown; onAuth?: () => void } = {},
): ExtensionContext {
  return {
    sessionManager: { getSessionId: () => options.sessionId ?? "pi-session-1" },
    model: options.model ?? opencodeModel,
    modelRegistry: {
      getApiKeyAndHeaders: async () => {
        options.onAuth?.();
        return options.auth ?? { ok: true, apiKey: "sk-test" };
      },
    },
  } as unknown as ExtensionContext;
}

async function start(fixture: Fixture, ctx: ExtensionContext): Promise<void> {
  await fixture.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
}

async function headersFor(
  fixture: Fixture,
  ctx: ExtensionContext,
): Promise<Record<string, string | null>> {
  const event = { type: "before_provider_headers", headers: {} as Record<string, string | null> };
  await fixture.handlers.get("before_provider_headers")?.(event, ctx);
  return event.headers;
}

const freshEntry = (id: string) => ({
  id,
  provider: opencodeModel.provider,
  model: opencodeModel.id,
  upstreamMs: 880,
  verifiedAt: Date.now(),
  createdAt: Date.now() - 1_000,
  failures: 0,
});

test("pins a pooled id for an OpenCode conversation", async () => {
  const fixture = await setup({ state: { version: 1, entries: [freshEntry("fast-1")], bindings: {} } });
  const ctx = context(fixture);
  await start(fixture, ctx);

  assert.equal((await headersFor(fixture, ctx))["x-opencode-session"], "fast-1");
});

test("a resumed conversation keeps its existing routed id", async () => {
  const state = {
    version: 1,
    entries: [freshEntry("fast-1")],
    bindings: {
      "pi-session-1::opencode-go::deepseek-v4.1-flash": {
        routedId: "fast-1",
        provider: opencodeModel.provider,
        model: opencodeModel.id,
        boundAt: Date.now() - 5_000,
        lastSeenAt: Date.now() - 5_000,
        upstreamMs: 880,
        verifiedAt: Date.now() - 5_000,
        failures: 0,
      },
    },
  };
  const fixture = await setup({ state });
  const ctx = context(fixture);
  await start(fixture, ctx);

  assert.equal((await headersFor(fixture, ctx))["x-opencode-session"], "fast-1");
});

test("leaves non-OpenCode providers completely alone", async () => {
  const fixture = await setup({ state: { version: 1, entries: [freshEntry("fast-1")], bindings: {} } });
  let authCalls = 0;
  const ctx = context(fixture, {
    model: { ...opencodeModel, provider: "anthropic", baseUrl: "https://api.anthropic.com/v1" },
    onAuth: () => {
      authCalls += 1;
    },
  });
  await start(fixture, ctx);

  const headers = await headersFor(fixture, ctx);
  assert.deepEqual(headers, {});
  assert.equal(authCalls, 0);
});

test("leaves OpenCode models on other transports alone", async () => {
  const fixture = await setup({ state: { version: 1, entries: [freshEntry("fast-1")], bindings: {} } });
  const ctx = context(fixture, { model: { ...opencodeModel, api: "anthropic-messages" } });
  await start(fixture, ctx);

  assert.deepEqual(await headersFor(fixture, ctx), {});
});

test("falls back to pi's id when there is no pooled id yet", async () => {
  const fixture = await setup();
  const ctx = context(fixture);
  await start(fixture, ctx);

  assert.deepEqual(await headersFor(fixture, ctx), {});
});

test("falls back when credentials are missing", async () => {
  const fixture = await setup({ state: { version: 1, entries: [freshEntry("fast-1")], bindings: {} } });
  const ctx = context(fixture, { auth: { ok: false, error: "no key" } });
  await start(fixture, ctx);

  assert.deepEqual(await headersFor(fixture, ctx), {});
});

test("never throws when the model registry fails", async () => {
  const fixture = await setup({ state: { version: 1, entries: [freshEntry("fast-1")], bindings: {} } });
  const ctx = {
    sessionManager: { getSessionId: () => "pi-session-1" },
    model: opencodeModel,
    modelRegistry: {
      getApiKeyAndHeaders: async () => {
        throw new Error("registry offline");
      },
    },
  } as unknown as ExtensionContext;

  await assert.doesNotReject(() => start(fixture, ctx));
  assert.deepEqual(await headersFor(fixture, ctx), {});
});

test("quarantines a slow routed id after a real response", async () => {
  const fixture = await setup({ state: { version: 1, entries: [freshEntry("fast-1")], bindings: {} } });
  const ctx = context(fixture);
  await start(fixture, ctx);
  await headersFor(fixture, ctx);

  const handler = fixture.handlers.get("after_provider_response");
  assert.ok(handler);
  await handler({ type: "after_provider_response", status: 200, headers: { "server-timing": "upstream;dur=31000" } }, ctx);

  // `observe()` is intentionally fire-and-forget (awaiting it inside the
  // response hook would delay the stream), so give the quarantine a moment.
  await new Promise((resolve) => setTimeout(resolve, 100));

  // The conversation is unbound now, so the next request keeps pi's own id.
  assert.deepEqual(await headersFor(fixture, ctx), {});
});
