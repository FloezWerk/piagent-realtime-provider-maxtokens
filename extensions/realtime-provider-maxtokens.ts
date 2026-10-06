/**
 * realtime-provider-maxtokens.ts (Pi extension)
 *
 * OpenRouter only routes a request to providers that can serve a response of the
 * requested length. Pi sends `max_completion_tokens` (or `max_tokens`, depending
 * on `compat.maxTokensField`) from `model.maxTokens`. For OpenRouter models that
 * value is the model-wide maximum from the catalogue (for example 943718 for
 * `deepseek/deepseek-v4.1-flash`), so every provider with a lower output limit is
 * filtered out before routing - the provider pool shrinks to the handful of
 * endpoints that publish the catalogue maximum.
 *
 * This extension rewrites that field in the outgoing payload, per request, to the
 * smallest output limit among the model's provider endpoints. The limit is read
 * from the public OpenRouter endpoints route and cached on disk with a TTL, so
 * the request path never waits for a lookup.
 *
 * It does not register a provider, does not touch `models.json` and does not pin
 * a provider: routing stays with OpenRouter.
 *
 * Settings live under the root key `provider-maxtokens` in Pi's shared
 * `settings.json`; the cache lives in `provider-maxtokens-cache.json` next to it.
 *
 * All user-facing strings and comments stay English (see AGENTS.md).
 */

import type {
  BeforeProviderRequestEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ModelSelectEvent,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Command name without the leading slash. */
const COMMAND_NAME = "provider-maxtokens";

/** Root key inside `settings.json`, matching the extension name. */
const SETTINGS_ROOT_KEY = "provider-maxtokens";

/** Status channel used via `ctx.ui.setStatus(...)`. */
const STATUS_KEY = "provider-maxtokens";

/** Cache file name, resolved next to `settings.json` in the agent directory. */
const CACHE_FILE_NAME = "provider-maxtokens-cache.json";

/** Bumped when the on-disk cache shape changes; older files are discarded. */
const CACHE_VERSION = 1;

/** Provider whose requests are rewritten. Every other provider is left alone. */
const OPENROUTER_PROVIDER = "openrouter";

/** Public OpenRouter model endpoints route; no credential is required. */
const ENDPOINTS_BASE_URL = "https://openrouter.ai/api/v1/models";

/** Timeout for a single endpoints lookup. */
const LOOKUP_TIMEOUT_MS = 10_000;

/** How many endpoints lookups run in parallel during a prefetch pass. */
const PREFETCH_CONCURRENCY = 4;

/** Upper bound on models warmed in one prefetch pass. */
const PREFETCH_LIMIT = 250;

/** Lower bound for the configured TTL and fallback cap. */
const MIN_TTL_MINUTES = 1;
const MIN_FALLBACK_CAP = 1024;

/** Field names Pi may use for the output limit. */
const MAX_TOKENS_FIELDS = ["max_completion_tokens", "max_tokens"] as const;
type MaxTokensField = (typeof MAX_TOKENS_FIELDS)[number];

interface ExtensionSettings {
  /** Rewrite the output limit at all. */
  enabled: boolean;
  /** Age after which a cached limit is refreshed, in minutes. */
  ttlMinutes: number;
  /** Limit used when no cached entry exists yet or a lookup fails. */
  fallbackCap: number;
}

const DEFAULT_SETTINGS: ExtensionSettings = {
  enabled: true,
  ttlMinutes: 60,
  fallbackCap: 131072,
};

interface CacheEntry {
  /** Smallest `max_completion_tokens` across the model's endpoints. */
  cap: number;
  /** Epoch milliseconds of the lookup that produced `cap`. */
  checkedAt: number;
  /** Number of endpoints the limit was derived from. */
  endpointCount: number;
}

interface CacheFile {
  version: number;
  entries: Record<string, CacheEntry>;
}

interface ClampRecord {
  modelId: string;
  from: number;
  to: number;
  at: number;
}

interface CapResolution {
  cap: number;
  /** `cache` when a fresh entry was used, `fallback` otherwise. */
  source: "cache" | "fallback";
}

let settings: ExtensionSettings = { ...DEFAULT_SETTINGS };
let cache = new Map<string, CacheEntry>();
let cacheLoaded = false;
let cacheWriteQueue: Promise<void> = Promise.resolve();
const lookupsInFlight = new Set<string>();
/** Latest event context; refreshed by every handler because a captured context can go stale. */
let activeContext: ExtensionContext | undefined;
let lastClamp: ClampRecord | undefined;
let clampCount = 0;
let statusText: string | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function settingsPath(): string {
  return join(getAgentDir(), "settings.json");
}

function cachePath(): string {
  return join(getAgentDir(), CACHE_FILE_NAME);
}

function normalizeInteger(value: unknown, fallback: number, minimum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.floor(value);
  return rounded >= minimum ? rounded : fallback;
}

function normalizeSettings(section: unknown): ExtensionSettings {
  const record = isRecord(section) ? section : {};

  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : DEFAULT_SETTINGS.enabled,
    ttlMinutes: normalizeInteger(
      record.ttlMinutes,
      DEFAULT_SETTINGS.ttlMinutes,
      MIN_TTL_MINUTES,
    ),
    fallbackCap: normalizeInteger(
      record.fallbackCap,
      DEFAULT_SETTINGS.fallbackCap,
      MIN_FALLBACK_CAP,
    ),
  };
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** Loads the extension settings; missing or invalid values fall back to defaults. */
async function loadSettings(): Promise<ExtensionSettings> {
  const root = await readJsonFile(settingsPath());
  return normalizeSettings(isRecord(root) ? root[SETTINGS_ROOT_KEY] : undefined);
}

/**
 * Merges a patch into the extension's settings section and persists it.
 * Read-modify-write of the whole file so unrelated keys survive.
 */
async function saveSettings(patch: Partial<ExtensionSettings>): Promise<void> {
  const parsed = await readJsonFile(settingsPath());
  const root: Record<string, unknown> = isRecord(parsed) ? parsed : {};
  const current = isRecord(root[SETTINGS_ROOT_KEY]) ? root[SETTINGS_ROOT_KEY] : {};

  root[SETTINGS_ROOT_KEY] = { ...current, ...patch };
  await writeFile(settingsPath(), `${JSON.stringify(root, null, 2)}\n`, "utf8");
}

function isFresh(entry: CacheEntry, now: number): boolean {
  return now - entry.checkedAt < settings.ttlMinutes * 60_000;
}

async function loadCache(): Promise<void> {
  if (cacheLoaded) return;
  cacheLoaded = true;

  const raw = await readJsonFile(cachePath());
  if (!isRecord(raw) || raw.version !== CACHE_VERSION || !isRecord(raw.entries)) return;

  const next = new Map<string, CacheEntry>();
  for (const [modelId, value] of Object.entries(raw.entries)) {
    if (!isRecord(value)) continue;
    const cap = value.cap;
    const checkedAt = value.checkedAt;
    if (typeof cap !== "number" || !Number.isFinite(cap) || cap <= 0) continue;
    if (typeof checkedAt !== "number" || !Number.isFinite(checkedAt)) continue;

    next.set(modelId, {
      cap,
      checkedAt,
      endpointCount:
        typeof value.endpointCount === "number" && Number.isFinite(value.endpointCount)
          ? value.endpointCount
          : 0,
    });
  }

  cache = next;
}

/** Serializes cache writes so concurrent refreshes cannot interleave. */
function scheduleCacheWrite(): void {
  cacheWriteQueue = cacheWriteQueue.then(async () => {
    const entries: Record<string, CacheEntry> = {};
    for (const [modelId, entry] of cache) entries[modelId] = entry;

    const payload: CacheFile = { version: CACHE_VERSION, entries };
    const path = cachePath();
    const temporaryPath = `${path}.tmp-${process.pid}`;

    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      await rename(temporaryPath, path);
    } catch {
      // A cache that cannot be persisted only costs one extra lookup next start.
    }
  });
}

function endpointsUrl(modelId: string): string {
  // The endpoints route is slash-separated: keep the slashes, encode the segments.
  const path = modelId
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${ENDPOINTS_BASE_URL}/${path}/endpoints`;
}

/** Smallest positive `max_completion_tokens` across an endpoints response. */
function smallestOutputLimit(payload: unknown): { cap: number; endpointCount: number } | undefined {
  if (!isRecord(payload) || !isRecord(payload.data)) return undefined;
  const endpoints = payload.data.endpoints;
  if (!Array.isArray(endpoints)) return undefined;

  let cap: number | undefined;
  let endpointCount = 0;

  for (const endpoint of endpoints) {
    if (!isRecord(endpoint)) continue;
    const value = endpoint.max_completion_tokens;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
    endpointCount += 1;
    if (cap === undefined || value < cap) cap = value;
  }

  return cap === undefined ? undefined : { cap, endpointCount };
}

async function lookupCap(modelId: string): Promise<CacheEntry | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);

  try {
    const response = await fetch(endpointsUrl(modelId), {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return undefined;

    const limits = smallestOutputLimit(await response.json());
    if (!limits) return undefined;

    return { cap: limits.cap, checkedAt: Date.now(), endpointCount: limits.endpointCount };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Refreshes one model's limit unless a lookup for it is already running. */
async function refreshCap(modelId: string): Promise<CacheEntry | undefined> {
  if (lookupsInFlight.has(modelId)) return undefined;
  lookupsInFlight.add(modelId);

  try {
    const entry = await lookupCap(modelId);
    if (!entry) return undefined;

    cache.set(modelId, entry);
    scheduleCacheWrite();
    return entry;
  } finally {
    lookupsInFlight.delete(modelId);
  }
}

async function refreshCaps(modelIds: readonly string[]): Promise<number> {
  const queue = [...new Set(modelIds)].slice(0, PREFETCH_LIMIT);
  let refreshed = 0;

  const workers = Array.from({ length: Math.min(PREFETCH_CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const modelId = queue.shift();
      if (modelId === undefined) return;
      if (await refreshCap(modelId)) refreshed += 1;
    }
  });

  await Promise.all(workers);
  return refreshed;
}

/**
 * Resolves the limit to clamp to. Never blocks: a missing or stale entry falls
 * back to the configured default and triggers a background refresh.
 */
function resolveCap(modelId: string): CapResolution {
  const entry = cache.get(modelId);
  const now = Date.now();

  if (entry && isFresh(entry, now)) return { cap: entry.cap, source: "cache" };

  void refreshCap(modelId);
  return { cap: settings.fallbackCap, source: "fallback" };
}

/** Field Pi uses for the output limit of this model. */
function maxTokensField(model: Model<Api>): MaxTokensField {
  // Only the OpenAI-completions compat shape carries maxTokensField.
  const compat = model.compat as { maxTokensField?: MaxTokensField } | undefined;
  return compat?.maxTokensField === "max_tokens" ? "max_tokens" : "max_completion_tokens";
}

function isOpenRouterModel(model: Model<Api> | undefined): model is Model<Api> {
  return model?.provider === OPENROUTER_PROVIDER;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

function formatAge(checkedAt: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - checkedAt) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60 === 0 ? "" : `${minutes % 60}m`}`;
}

function setStatus(ctx: ExtensionContext, text: string | undefined): void {
  if (text === statusText) return;
  statusText = text;

  try {
    ctx.ui.setStatus(STATUS_KEY, text);
  } catch {
    // setStatus is not available in every mode.
  }
}

/** Remembers the most recent event context for deferred status updates. */
function rememberContext(ctx: ExtensionContext): void {
  activeContext = ctx;
}

/**
 * Renders the status for the current model. Uses the most recent event context
 * and swallows a stale one: Pi replaces the context on session switch/reload and
 * a getter then throws, which must never take the process down.
 */
function updateStatus(): void {
  const ctx = activeContext;
  if (!ctx) return;

  let text: string | undefined;

  try {
    if (!settings.enabled) {
      text = "MT:off";
    } else {
      const model = ctx.model;
      if (isOpenRouterModel(model)) {
        const entry = cache.get(model.id);
        const fresh = entry !== undefined && isFresh(entry, Date.now());
        text = `MT:${formatTokens(fresh ? entry.cap : settings.fallbackCap)}${fresh ? "" : "*"}`;
      }
    }
  } catch {
    // Stale context: the next event supplies a fresh one.
    return;
  }

  setStatus(ctx, text);
}

/** Model ids worth warming: the session scope, plus the current model. */
function warmupModelIds(ctx: ExtensionContext): string[] {
  const ids = ctx.scopedModels
    .map((scoped) => scoped.model)
    .filter((model) => isOpenRouterModel(model))
    .map((model) => model.id);

  if (isOpenRouterModel(ctx.model)) ids.push(ctx.model.id);
  return ids;
}

function warmUp(ctx: ExtensionContext): void {
  if (!settings.enabled) return;

  const ids = warmupModelIds(ctx);
  if (ids.length === 0) return;

  void refreshCaps(ids).then(() => updateStatus());
}

function statusLines(ctx: ExtensionContext): string[] {
  const now = Date.now();
  const model = ctx.model;
  const lines: string[] = [
    `**Provider max tokens**`,
    "",
    `Enabled: ${settings.enabled ? "yes" : "no"}`,
    `TTL: ${settings.ttlMinutes} minute(s)`,
    `Fallback cap: ${settings.fallbackCap} (${formatTokens(settings.fallbackCap)})`,
    `Cache: ${cache.size} model(s), ${cachePath()}`,
  ];

  if (isOpenRouterModel(model)) {
    const entry = cache.get(model.id);
    const field = maxTokensField(model);
    lines.push("", `**Current model** \`${model.id}\``);
    lines.push(`Field: ${field}`);
    lines.push(`Model maxTokens: ${model.maxTokens}`);

    if (entry) {
      lines.push(
        `Cached cap: ${entry.cap} (${formatTokens(entry.cap)}) from ${entry.endpointCount} endpoint(s), age ${formatAge(entry.checkedAt, now)}${isFresh(entry, now) ? "" : " - stale, refreshing"}`,
      );
    } else {
      lines.push(`Cached cap: none yet - using the fallback cap`);
    }

    const effective = Math.min(model.maxTokens, entry && isFresh(entry, now) ? entry.cap : settings.fallbackCap);
    lines.push(`Sent as: ${effective} (${formatTokens(effective)})`);
  } else {
    lines.push("", "Current model is not an OpenRouter model - requests are not rewritten.");
  }

  if (lastClamp) {
    lines.push(
      "",
      `Last clamp: \`${lastClamp.modelId}\` ${lastClamp.from} -> ${lastClamp.to} (${formatAge(lastClamp.at, now)} ago)`,
    );
  }
  lines.push(`Clamps this session: ${clampCount}`);

  return lines;
}

async function handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  rememberContext(ctx);
  const [action, value] = args.trim().split(/\s+/, 2);
  const notify = (message: string, type: "info" | "warning" | "error" = "info"): void => {
    if (ctx.hasUI) ctx.ui.notify(message, type);
  };

  switch ((action ?? "").toLowerCase()) {
    case "":
    case "status": {
      if (ctx.hasUI) ctx.ui.notify(statusLines(ctx).join("\n"), "info");
      return;
    }

    case "on":
    case "off":
    case "toggle": {
      const enabled = action === "toggle" ? !settings.enabled : action === "on";
      settings = { ...settings, enabled };
      await saveSettings({ enabled });
      updateStatus();
      notify(`${COMMAND_NAME}: ${enabled ? "enabled" : "disabled"}`, "info");
      return;
    }

    case "ttl": {
      const minutes = Number(value);
      if (!Number.isFinite(minutes) || minutes < MIN_TTL_MINUTES) {
        notify(`${COMMAND_NAME}: usage: /${COMMAND_NAME} ttl <minutes>`, "warning");
        return;
      }

      const ttlMinutes = Math.floor(minutes);
      settings = { ...settings, ttlMinutes };
      await saveSettings({ ttlMinutes });
      notify(`${COMMAND_NAME}: TTL is now ${ttlMinutes} minute(s)`, "info");
      return;
    }

    case "cap": {
      const tokens = Number(value);
      if (!Number.isFinite(tokens) || tokens < MIN_FALLBACK_CAP) {
        notify(`${COMMAND_NAME}: usage: /${COMMAND_NAME} cap <tokens>`, "warning");
        return;
      }

      const fallbackCap = Math.floor(tokens);
      settings = { ...settings, fallbackCap };
      await saveSettings({ fallbackCap });
      updateStatus();
      notify(`${COMMAND_NAME}: fallback cap is now ${fallbackCap}`, "info");
      return;
    }

    case "refresh": {
      const ids = warmupModelIds(ctx);
      if (ids.length === 0) {
        notify(`${COMMAND_NAME}: no OpenRouter model to refresh`, "warning");
        return;
      }

      notify(`${COMMAND_NAME}: refreshing ${ids.length} model(s)...`, "info");
      const refreshed = await refreshCaps(ids);
      updateStatus();
      notify(`${COMMAND_NAME}: ${refreshed} of ${ids.length} model(s) updated`, "info");
      return;
    }

    case "clear": {
      cache.clear();
      scheduleCacheWrite();
      updateStatus();
      notify(`${COMMAND_NAME}: cache cleared`, "info");
      return;
    }

    default: {
      notify(
        [
          `${COMMAND_NAME}: unknown action "${action}"`,
          `usage: /${COMMAND_NAME} [status|on|off|toggle|refresh|clear|ttl <minutes>|cap <tokens>]`,
        ].join("\n"),
        "warning",
      );
    }
  }
}

export default async function realtimeProviderMaxtokens(pi: ExtensionAPI): Promise<void> {
  settings = await loadSettings();
  await loadCache();

  pi.on("session_start", (_event, ctx) => {
    rememberContext(ctx);
    updateStatus();
    warmUp(ctx);
  });

  pi.on("model_select", (_event: ModelSelectEvent, ctx) => {
    rememberContext(ctx);
    updateStatus();
    if (isOpenRouterModel(ctx.model)) void refreshCap(ctx.model.id).then(() => updateStatus());
  });

  pi.on("before_provider_request", (event: BeforeProviderRequestEvent, ctx) => {
    rememberContext(ctx);

    if (!settings.enabled) return undefined;

    const model = ctx.model;
    if (!isOpenRouterModel(model)) return undefined;

    const payload = event.payload;
    if (!isRecord(payload)) return undefined;

    const field = maxTokensField(model);
    const current = payload[field];
    if (typeof current !== "number" || !Number.isFinite(current) || current <= 0) return undefined;

    const { cap } = resolveCap(model.id);
    if (current <= cap) return undefined;

    lastClamp = { modelId: model.id, from: current, to: cap, at: Date.now() };
    clampCount += 1;
    updateStatus();

    return { ...payload, [field]: cap };
  });

  pi.registerCommand(COMMAND_NAME, {
    description: "Clamp OpenRouter max output tokens to the smallest provider limit",
    handler: handleCommand,
  });
}
