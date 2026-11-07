/**
 * Decide which models are routed by OpenCode's session-keyed gateway, and turn
 * a pi model into a ready-to-probe target.
 *
 * Only `openai-completions` transport is supported: it is the transport that
 * sends `x-opencode-session`, exposes request headers to extensions
 * (`before_provider_headers`) and surfaces response headers such as
 * `server-timing` (`after_provider_response`). Other OpenCode APIs
 * (`anthropic-messages`, `google-generative-ai`) are left untouched.
 */
import type { ModelLike, ProbeTarget } from "./types.ts";

/** Hostname that owns the OpenCode inference gateway. */
export const OPENCODE_HOST = "opencode.ai";

/** Provider ids that pi routes through OpenCode. */
const OPENCODE_PROVIDER_PREFIX = "opencode";

/** True when `model` belongs to OpenCode, by provider id or base URL host. */
export function isOpenCodeModel(model: Pick<ModelLike, "provider" | "baseUrl">): boolean {
  if (model.provider.toLowerCase().startsWith(OPENCODE_PROVIDER_PREFIX)) return true;
  return hostOf(model.baseUrl) === OPENCODE_HOST;
}

/** True when the pool can probe this model at all. */
export function supportsProbing(model: ModelLike): boolean {
  return model.api === "openai-completions" && isOpenCodeModel(model);
}

/**
 * Join a provider base URL with the chat-completions path.
 *
 * Accepts `https://host/v1`, `https://host/v1/` and an already-complete
 * `https://host/v1/chat/completions`. Returns `undefined` for unparseable URLs.
 */
export function chatCompletionsUrl(baseUrl: string | null | undefined): string | undefined {
  if (!baseUrl) return undefined;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/chat/completions") ? path : `${path}/chat/completions`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * Build the binding key for a conversation + model.
 *
 * pi's session id is stable across `--continue`/resume, which is exactly what
 * we want: a resumed conversation keeps the same routed id, so OpenCode's
 * prompt cache stays warm.
 */
export function bindingKey(piSessionId: string, provider: string, model: string): string {
  return `${piSessionId}::${provider}::${model}`;
}

/** Provider+model key used by the pool to scope entries. */
export function targetKey(provider: string, model: string): string {
  return `${provider}::${model}`;
}

/** Extract `host:port` from a URL, tolerating junk. */
function hostOf(baseUrl: string | null | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {
    return new URL(baseUrl).host;
  } catch {
    return undefined;
  }
}

/** Resolve a pi model plus its auth into a probe target, or `undefined` when unsupported. */
export function resolveTarget(
  model: ModelLike,
  auth: { apiKey?: string; headers?: Record<string, string> },
): ProbeTarget | undefined {
  if (!supportsProbing(model)) return undefined;
  const url = chatCompletionsUrl(model.baseUrl);
  if (!url) return undefined;
  if (!auth.apiKey) return undefined;
  return {
    provider: model.provider,
    model: model.id,
    url,
    apiKey: auth.apiKey,
    headers: auth.headers,
  };
}
