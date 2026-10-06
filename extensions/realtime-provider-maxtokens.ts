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
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Command name without the leading slash. */
const COMMAND_NAME = "provider-maxtokens";

/** Root key inside `settings.json`, matching the extension name. */
const SETTINGS_ROOT_KEY = "provider-maxtokens";

/** Status channel used via `ctx.ui.setStatus(...)`. */
const STATUS_KEY = "provider-maxtokens";

/** Cache file name, resolved next to `settings.json` in the agent directory. */
const CACHE_FILE_NAME = "provider-maxtokens-cache.json";

/** Diagnostic log file name, written only while `log` is enabled. */
const LOG_FILE_NAME = "provider-maxtokens.log";

/** Length of the provider tag shown in the status line. */
const PROVIDER_TAG_LENGTH = 3;

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
  /**
   * Per-model lower bound for the limit that is sent, keyed by model id. The
   * value never drops below this, even when every endpoint publishes less.
   */
  minByModel: Record<string, number>;
  /** Append a diagnostic log next to the settings file. Off by default. */
  log: boolean;
  /** Show the serving provider's own output limit in the status line. */
  statusProviderLimit: boolean;
  /** Include the provider tag (first three letters) in that parenthetical. */
  statusProviderLimitTag: boolean;
}

const DEFAULT_SETTINGS: ExtensionSettings = {
  enabled: true,
  ttlMinutes: 60,
  fallbackCap: 131072,
  minByModel: {},
  log: false,
  statusProviderLimit: true,
  statusProviderLimitTag: true,
};

interface CacheEntry {
  /** Smallest `max_completion_tokens` across the model's endpoints. */
  cap: number;
  /** Epoch milliseconds of the lookup that produced `cap`. */
  checkedAt: number;
  /** Number of endpoints the limit was derived from. */
  endpointCount: number;
  /**
   * Output limit per provider, keyed by lowercase provider name. Lets the status
   * line show what the provider that served a request supports itself.
   */
  providers?: Record<string, number>;
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

/** How the limit that is sent was derived. */
interface CapState {
  /** Limit used, never below the configured per-model minimum. */
  cap: number;
  /** Limit from the cache or the fallback, before the minimum is applied. */
  baseCap: number;
  /** A fresh cache entry exists. */
  fresh: boolean;
  /** The configured per-model minimum raised the cap. */
  raisedByMinimum: boolean;
}

/** Per-model request bookkeeping for the status line. */
interface ModelState {
  /** The most recent request for this model was reduced. */
  clamped: boolean;
  /** Requests reduced since this session started. */
  clamps: number;
  /** The most recent reduction. */
  lastClamp?: ClampRecord;
}

let settings: ExtensionSettings = { ...DEFAULT_SETTINGS };
let cache = new Map<string, CacheEntry>();
let cacheLoaded = false;
let cacheWriteQueue: Promise<void> = Promise.resolve();
const lookupsInFlight = new Set<string>();
/** Latest event context; refreshed by every handler because a captured context can go stale. */
let activeContext: ExtensionContext | undefined;
const modelStates = new Map<string, ModelState>();
/** Provider that served the most recent response, per model id. */
const servingProviders = new Map<string, string>();
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

function logPath(): string {
  return join(getAgentDir(), LOG_FILE_NAME);
}

/**
 * Appends one line to the diagnostic log. No-op while logging is disabled, and
 * a failing write is swallowed: logging must never affect a request.
 */
function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  if (!settings.log) return;

  const line = `${new Date().toISOString()} ${event} ${JSON.stringify(fields)}\n`;
  void appendFile(logPath(), line, "utf8").catch(() => {
    // A log that cannot be written is not worth failing a request over.
  });
}

function normalizeInteger(value: unknown, fallback: number, minimum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.floor(value);
  return rounded >= minimum ? rounded : fallback;
}

/** Keeps only usable entries: a non-empty model id and a plausible token count. */
function normalizeMinByModel(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};

  const result: Record<string, number> = {};
  for (const [rawId, rawValue] of Object.entries(value)) {
    const modelId = rawId.trim();
    if (!modelId) continue;
    if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) continue;

    const tokens = Math.floor(rawValue);
    if (tokens < MIN_FALLBACK_CAP) continue;
    result[modelId] = tokens;
  }

  return result;
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
    minByModel: normalizeMinByModel(record.minByModel),
    log: typeof record.log === "boolean" ? record.log : DEFAULT_SETTINGS.log,
    statusProviderLimit:
      typeof record.statusProviderLimit === "boolean"
        ? record.statusProviderLimit
        : DEFAULT_SETTINGS.statusProviderLimit,
    statusProviderLimitTag:
      typeof record.statusProviderLimitTag === "boolean"
        ? record.statusProviderLimitTag
        : DEFAULT_SETTINGS.statusProviderLimitTag,
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

    const providers = isRecord(value.providers) ? value.providers : undefined;
    const limits: Record<string, number> = {};
    for (const [name, limit] of Object.entries(providers ?? {})) {
      if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) limits[name] = limit;
    }

    next.set(modelId, {
      cap,
      checkedAt,
      endpointCount:
        typeof value.endpointCount === "number" && Number.isFinite(value.endpointCount)
          ? value.endpointCount
          : 0,
      ...(Object.keys(limits).length > 0 ? { providers: limits } : {}),
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
interface EndpointLimits {
  /** Smallest limit across the endpoints: the cap that is sent. */
  cap: number;
  /** Number of endpoints that published a limit. */
  endpointCount: number;
  /** Highest limit per provider (lowercase name): what that provider supports. */
  providers: Record<string, number>;
}

/** Reads the output limits out of an endpoints response. */
function readEndpointLimits(payload: unknown): EndpointLimits | undefined {
  if (!isRecord(payload) || !isRecord(payload.data)) return undefined;
  const endpoints = payload.data.endpoints;
  if (!Array.isArray(endpoints)) return undefined;

  let cap: number | undefined;
  let endpointCount = 0;
  const providers: Record<string, number> = {};

  for (const endpoint of endpoints) {
    if (!isRecord(endpoint)) continue;
    const value = endpoint.max_completion_tokens;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;

    endpointCount += 1;
    if (cap === undefined || value < cap) cap = value;

    const name = typeof endpoint.provider_name === "string" ? endpoint.provider_name.trim().toLowerCase() : "";
    if (!name) continue;
    const known = providers[name];
    if (known === undefined || value > known) providers[name] = value;
  }

  return cap === undefined ? undefined : { cap, endpointCount, providers };
}

async function lookupCap(modelId: string): Promise<CacheEntry | undefined> {
  const url = endpointsUrl(modelId);
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);

  logEvent("lookup.start", { modelId, url });

  try {
    const response = await fetch(url, { headers: { accept: "application/json" }, signal: controller.signal });
    if (!response.ok) {
      logEvent("lookup.http-error", { modelId, status: response.status, durationMs: Date.now() - startedAt });
      return undefined;
    }

    const limits = readEndpointLimits(await response.json());
    if (!limits) {
      logEvent("lookup.no-limits", { modelId, status: response.status, durationMs: Date.now() - startedAt });
      return undefined;
    }

    logEvent("lookup.response", {
      modelId,
      status: response.status,
      durationMs: Date.now() - startedAt,
      endpointCount: limits.endpointCount,
      cap: limits.cap,
      providers: limits.providers,
    });

    return {
      cap: limits.cap,
      checkedAt: Date.now(),
      endpointCount: limits.endpointCount,
      ...(Object.keys(limits.providers).length > 0 ? { providers: limits.providers } : {}),
    };
  } catch (error) {
    logEvent("lookup.failed", {
      modelId,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Refreshes one model's limit unless a lookup for it is already running. */
async function refreshCap(modelId: string): Promise<CacheEntry | undefined> {
  if (lookupsInFlight.has(modelId)) {
    logEvent("lookup.skipped", { modelId, reason: "already-in-flight" });
    return undefined;
  }

  lookupsInFlight.add(modelId);

  try {
    const entry = await lookupCap(modelId);
    if (!entry) return undefined;

    cache.set(modelId, entry);
    scheduleCacheWrite();
    logEvent("cache.stored", { modelId, cap: entry.cap, endpointCount: entry.endpointCount });
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
/** Derives the limit for a model without side effects, for display and clamping. */
function peekCap(modelId: string): CapState {
  const entry = cache.get(modelId);
  const fresh = entry !== undefined && isFresh(entry, Date.now());
  const baseCap = fresh ? entry.cap : settings.fallbackCap;
  const minimum = settings.minByModel[modelId];
  const raisedByMinimum = minimum !== undefined && minimum > baseCap;

  return { cap: raisedByMinimum ? minimum : baseCap, baseCap, fresh, raisedByMinimum };
}

/** Same as {@link peekCap}, but makes sure a stale entry is refreshed in the background. */
function resolveCap(modelId: string): CapState {
  const state = peekCap(modelId);
  const entry = cache.get(modelId);

  if (state.fresh) {
    logEvent("cache.hit", {
      modelId,
      cap: state.cap,
      ageMinutes: entry === undefined ? null : ageMinutes(entry.checkedAt),
      ttlMinutes: settings.ttlMinutes,
    });
    return state;
  }

  if (entry === undefined) {
    logEvent("cache.miss", { modelId, ttlMinutes: settings.ttlMinutes, fallbackCap: settings.fallbackCap });
  } else {
    logEvent("cache.expired", {
      modelId,
      cap: entry.cap,
      ageMinutes: ageMinutes(entry.checkedAt),
      ttlMinutes: settings.ttlMinutes,
    });
  }

  void refreshCap(modelId);
  return state;
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

/** Whole minutes since a timestamp, for the log. */
function ageMinutes(checkedAt: number): number {
  return Math.max(0, Math.round((Date.now() - checkedAt) / 60_000));
}

function formatAge(checkedAt: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - checkedAt) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60 === 0 ? "" : `${minutes % 60}m`}`;
}

/**
 * Three-letter provider tag, mirroring `piagent-realtime-provider-cost`: lower
 * case, first letter capitalised, truncated. `DigitalOcean` -> `Dig`.
 */
function providerTag(name: string): string {
  const lower = name.trim().toLowerCase();
  if (!lower) return "";

  return (lower.charAt(0).toUpperCase() + lower.slice(1)).slice(0, PROVIDER_TAG_LENGTH);
}

/** Output limit a provider published for a model, when it is in the cache. */
function providerLimit(modelId: string, providerName: string): number | undefined {
  const entry = cache.get(modelId);
  if (!entry?.providers) return undefined;

  return entry.providers[providerName.trim().toLowerCase()];
}

/** `(Dig131k)` style suffix for the status line; empty when it is hidden. */
function providerSuffix(modelId: string): string {
  if (!settings.statusProviderLimit) return "";

  const name = servingProviders.get(modelId);
  if (!name) return "";

  const limit = providerLimit(modelId, name);
  const tag = settings.statusProviderLimitTag ? providerTag(name) : "";
  const text = `${tag}${limit === undefined ? "" : formatTokens(limit)}`;

  return text ? `(${text})` : "";
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
        const { cap, fresh } = peekCap(model.id);
        // "*" marks the fallback cap, the arrow marks a request that was reduced.
        const markers = `${fresh ? "" : "*"}${modelStates.get(model.id)?.clamped ? "\u2193" : ""}`;
        text = `MT:${formatTokens(cap)}${markers}${providerSuffix(model.id)}`;
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
    `Log: ${settings.log ? `on -> ${logPath()}` : "off"}`,
    `Provider limit in the status line: ${
      settings.statusProviderLimit
        ? settings.statusProviderLimitTag
          ? "tag + limit"
          : "limit only"
        : "off"
    }`,
  ];

  if (isOpenRouterModel(model)) {
    const entry = cache.get(model.id);
    const field = maxTokensField(model);
    const state = peekCap(model.id);
    const modelState = modelStates.get(model.id);

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

    const configuredMinimum = settings.minByModel[model.id];
    lines.push(
      state.raisedByMinimum
        ? `Minimum: ${state.cap} (${formatTokens(state.cap)}) - raised the cap from ${state.baseCap}`
        : configuredMinimum === undefined
          ? `Minimum: none configured`
          : `Minimum: ${configuredMinimum} - not binding, the cap is ${state.baseCap}`,
    );
    lines.push(`Cap used: ${state.cap} (${formatTokens(state.cap)})${state.fresh ? "" : " - fallback"}`);

    const effective = Math.min(model.maxTokens, state.cap);
    lines.push(`Sent as: ${effective} (${formatTokens(effective)})`);
    lines.push(
      `Requests reduced: ${modelState?.clamps ?? 0}${modelState?.clamped ? " (the most recent one was reduced)" : ""}`,
    );

    const serving = servingProviders.get(model.id);
    const servingLimit = serving === undefined ? undefined : providerLimit(model.id, serving);
    lines.push(`Serving provider: ${serving ?? "not reported yet"}`);
    lines.push(
      `Provider limit: ${
        serving === undefined
          ? "-"
          : servingLimit === undefined
            ? "not cached"
            : `${servingLimit} (${formatTokens(servingLimit)})`
      }`,
    );
  } else {
    lines.push("", "Current model is not an OpenRouter model - requests are not rewritten.");
  }

  const states = [...modelStates.values()];
  const last = states
    .map((entry) => entry.lastClamp)
    .filter((record): record is ClampRecord => record !== undefined)
    .sort((a, b) => b.at - a.at)[0];

  if (last) {
    lines.push(
      "",
      `Last clamp: \`${last.modelId}\` ${last.from} -> ${last.to} (${formatAge(last.at, now)} ago)`,
    );
  }
  lines.push(`Clamps this session: ${states.reduce((sum, entry) => sum + entry.clamps, 0)}`);

  return lines;
}

async function handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  rememberContext(ctx);
  const [action, first, second] = args.trim().split(/\s+/);
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
      const minutes = Number(first);
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
      const tokens = Number(first);
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

    case "min": {
      const modelId = (first ?? "").trim();
      const configured = settings.minByModel;

      if (!modelId) {
        const entries = Object.entries(configured).sort(([a], [b]) => a.localeCompare(b));
        notify(
          entries.length === 0
            ? `${COMMAND_NAME}: no per-model minimum configured`
            : [
                `**Per-model minimum**`,
                "",
                ...entries.map(([id, value]) => `- \`${id}\`: ${value} (${formatTokens(value)})`),
                "",
                `Usage: /${COMMAND_NAME} min <model-id> <tokens|none>`,
              ].join("\n"),
          "info",
        );
        return;
      }

      const currentMinimum = configured[modelId];

      if (second === undefined) {
        notify(
          currentMinimum === undefined
            ? `${COMMAND_NAME}: no minimum configured for ${modelId}`
            : `${COMMAND_NAME}: minimum for ${modelId} is ${currentMinimum} (${formatTokens(currentMinimum)})`,
          currentMinimum === undefined ? "warning" : "info",
        );
        return;
      }

      const next = { ...configured };

      if (second.toLowerCase() === "none") {
        if (currentMinimum === undefined) {
          notify(`${COMMAND_NAME}: no minimum configured for ${modelId}`, "warning");
          return;
        }

        delete next[modelId];
        settings = { ...settings, minByModel: next };
        await saveSettings({ minByModel: next });
        updateStatus();
        notify(`${COMMAND_NAME}: minimum removed for ${modelId}`, "info");
        return;
      }

      const tokens = Number(second);
      if (!Number.isFinite(tokens) || tokens < MIN_FALLBACK_CAP) {
        notify(`${COMMAND_NAME}: usage: /${COMMAND_NAME} min <model-id> <tokens|none>`, "warning");
        return;
      }

      next[modelId] = Math.floor(tokens);
      settings = { ...settings, minByModel: next };
      await saveSettings({ minByModel: next });
      updateStatus();
      notify(`${COMMAND_NAME}: minimum for ${modelId} is now ${next[modelId]}`, "info");
      return;
    }

    case "log": {
      const mode = (first ?? "").trim().toLowerCase();
      if (mode !== "on" && mode !== "off") {
        notify(`${COMMAND_NAME}: usage: /${COMMAND_NAME} log <on|off>`, "warning");
        return;
      }

      const log = mode === "on";
      settings = { ...settings, log };
      await saveSettings({ log });
      notify(`${COMMAND_NAME}: logging ${log ? `enabled -> ${logPath()}` : "disabled"}`, "info");
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
          `usage: /${COMMAND_NAME} [status|on|off|toggle|refresh|clear|ttl <minutes>|cap <tokens>|min <model-id> <tokens|none>|log <on|off>]`,
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

  // OpenRouter reports the provider that served the call on every raw chunk; Pi
  // drops it before the message is finalized, so it is captured here.
  pi.on("provider_stream_event", (event, ctx) => {
    rememberContext(ctx);

    if (event.provider !== OPENROUTER_PROVIDER) return;
    if (!isRecord(event.data)) return;

    const name = typeof event.data.provider === "string" ? event.data.provider.trim() : "";
    if (!name) return;
    if (servingProviders.get(event.model) === name) return;

    servingProviders.set(event.model, name);
    logEvent("response.provider", {
      modelId: event.model,
      provider: name,
      providerLimit: providerLimit(event.model, name) ?? null,
    });
    updateStatus();
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
    const state = modelStates.get(model.id) ?? { clamped: false, clamps: 0 };

    if (current <= cap) {
      state.clamped = false;
      modelStates.set(model.id, state);
      logEvent("request.decision", { modelId: model.id, field, from: current, cap, reduced: false });
      updateStatus();
      return undefined;
    }

    state.clamped = true;
    state.clamps += 1;
    state.lastClamp = { modelId: model.id, from: current, to: cap, at: Date.now() };
    modelStates.set(model.id, state);
    logEvent("request.decision", { modelId: model.id, field, from: current, cap, reduced: true });
    updateStatus();

    return { ...payload, [field]: cap };
  });

  pi.registerCommand(COMMAND_NAME, {
    description: "Clamp OpenRouter max output tokens to the smallest provider limit",
    handler: handleCommand,
  });
}
