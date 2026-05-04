/** Web search and fetch tools. */

import * as cheerio from "cheerio";
import { lookup as callbackLookup } from "node:dns";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, EnvHttpProxyAgent, ProxyAgent, type Dispatcher } from "undici";
import type { WebConfig } from "../config.js";
import { PermissionLevel } from "./base.js";
import type { ToolExecutionContext } from "./base.js";
import { getRegistry } from "./registry.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_SEARCH_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;
const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS = 10;
const DEFAULT_MAX_BYTES = 1_000_000;
const MAX_BYTES = 10 * 1024 * 1024;
const USER_AGENT =
  "Mozilla/5.0 (compatible; seek-code/0.1; +https://github.com/seek-code/seek-code)";

interface SearchEntry {
  title: string;
  url: string;
  snippet?: string;
  ref_id?: string;
}

interface FetchResponse {
  status: number;
  url: string;
  contentType: string;
  text: string;
  truncated: boolean;
}

interface WebRef {
  url: string;
  title: string;
  snippet?: string;
  source: string;
  query: string;
  createdAt: number;
}

interface ResolvedWebConfig {
  enabled: boolean;
  mode: "live" | "off";
  searchEngine: "auto" | "bing" | "duckduckgo";
  allowedDomains: string[];
  blockedDomains: string[];
  proxy: string;
  noProxy: string[];
  searchTimeoutMs: number;
  fetchTimeoutMs: number;
  maxBytes: number;
}

const WEB_REFS = new Map<string, WebRef>();
const PROXY_DISPATCHERS = new Map<string, Dispatcher>();
const SAFE_DISPATCHER = new Agent({
  connect: {
    lookup: safeLookup,
  } as any,
});
let ENV_DISPATCHER: Dispatcher | null | undefined;
let refSeq = 0;

function asPositiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function normalizeSearchEngine(value: unknown): "auto" | "bing" | "duckduckgo" {
  if (typeof value !== "string") return "auto";
  const normalized = value.trim().toLowerCase().replace(/[-_\s]/g, "");
  if (normalized === "bing") return "bing";
  if (normalized === "duckduckgo" || normalized === "ddg") return "duckduckgo";
  return "auto";
}

function normalizeFetchFormat(args: Record<string, unknown>): "markdown" | "text" | "raw" {
  const raw = typeof args.format === "string"
    ? args.format
    : args.extract_text === false
      ? "raw"
      : "markdown";
  const normalized = raw.trim().toLowerCase();
  if (["raw", "html", "bytes"].includes(normalized)) return "raw";
  if (["text", "txt", "plain"].includes(normalized)) return "text";
  return "markdown";
}

function normalizeDomainList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map(item => String(item).trim().toLowerCase())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map(item => item.trim().toLowerCase()).filter(Boolean);
  }
  return [];
}

function resolveWebConfig(config?: Partial<WebConfig>): ResolvedWebConfig {
  return {
    enabled: config?.enabled !== false,
    mode: config?.mode === "off" ? "off" : "live",
    searchEngine: normalizeSearchEngine(config?.search_engine),
    allowedDomains: normalizeDomainList(config?.allowed_domains),
    blockedDomains: normalizeDomainList(config?.blocked_domains),
    proxy: typeof config?.proxy === "string" ? config.proxy.trim() : "",
    noProxy: normalizeDomainList(config?.no_proxy),
    searchTimeoutMs: asPositiveInt(config?.search_timeout_ms, DEFAULT_SEARCH_TIMEOUT_MS, MAX_TIMEOUT_MS),
    fetchTimeoutMs: asPositiveInt(config?.fetch_timeout_ms, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
    maxBytes: asPositiveInt(config?.max_bytes, DEFAULT_MAX_BYTES, MAX_BYTES),
  };
}

function extractSearchQuery(args: Record<string, unknown>): string {
  for (const key of ["query", "q"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  const searchQuery = args.search_query;
  if (Array.isArray(searchQuery)) {
    for (const item of searchQuery) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      for (const key of ["q", "query"]) {
        const value = record[key];
        if (typeof value === "string" && value.trim()) return value.trim();
      }
    }
  }

  return "";
}

function extractSearchMaxResults(args: Record<string, unknown>): number {
  const direct = asPositiveInt(args.max_results, 0, MAX_RESULTS);
  if (direct > 0) return direct;

  const searchQuery = args.search_query;
  if (Array.isArray(searchQuery)) {
    for (const item of searchQuery) {
      if (!item || typeof item !== "object") continue;
      const nested = asPositiveInt((item as Record<string, unknown>).max_results, 0, MAX_RESULTS);
      if (nested > 0) return nested;
    }
  }

  return DEFAULT_MAX_RESULTS;
}

function extractSearchDomains(args: Record<string, unknown>): string[] {
  const direct = normalizeDomainList(args.domains);
  if (direct.length) return direct;

  const searchQuery = args.search_query;
  if (Array.isArray(searchQuery)) {
    for (const item of searchQuery) {
      if (!item || typeof item !== "object") continue;
      const nested = normalizeDomainList((item as Record<string, unknown>).domains);
      if (nested.length) return nested;
    }
  }

  return [];
}

function extractRefId(args: Record<string, unknown>): string {
  for (const key of ["ref_id", "refId"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function decodeHtml(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function normalizeText(text: string): string {
  return decodeHtml(text.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function percentDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

function queryParam(value: string, key: string): string | null {
  const marker = value.indexOf("?");
  if (marker < 0) return null;
  for (const part of value.slice(marker + 1).split("&")) {
    const [name, raw = ""] = part.split("=", 2);
    if (name === key) return raw;
  }
  return null;
}

function normalizeDuckUrl(href: string): string {
  const uddg = queryParam(href, "uddg");
  if (uddg) {
    const decoded = percentDecode(uddg);
    if (decoded) return decoded;
  }
  if (href.startsWith("//")) return `https:${href}`;
  if (href.startsWith("/")) return `https://duckduckgo.com${href}`;
  return href;
}

function normalizeBingUrl(href: string): string {
  const encoded = queryParam(href, "u");
  if (encoded) {
    const decoded = percentDecode(encoded);
    const token = decoded.startsWith("a1") ? decoded.slice(2) : decoded;
    const padded = token.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(token.length / 4) * 4, "=");
    try {
      const url = Buffer.from(padded, "base64").toString("utf-8");
      if (url.startsWith("http://") || url.startsWith("https://")) return url;
    } catch {
      // keep original href
    }
  }
  if (href.startsWith("//")) return `https:${href}`;
  if (href.startsWith("/")) return `https://www.bing.com${href}`;
  return href;
}

function normalizeSearchResultUrl(href: string, baseUrl: string): string | null {
  const uddg = queryParam(href, "uddg");
  if (uddg) {
    const decoded = percentDecode(uddg);
    if (/^https?:\/\//.test(decoded)) return decoded;
  }
  const bingEncoded = queryParam(href, "u");
  if (bingEncoded) {
    const decoded = normalizeBingUrl(href);
    if (/^https?:\/\//.test(decoded)) return decoded;
  }
  try {
    const url = new URL(href, baseUrl).toString();
    if (!/^https?:\/\//.test(url)) return null;
    return url;
  } catch {
    return null;
  }
}

function parseDuckResults(html: string, maxResults: number): SearchEntry[] {
  const $ = cheerio.load(html);
  const results: SearchEntry[] = [];
  $(".result").each((_, el) => {
    if (results.length >= maxResults) return false;
    const anchor = $(el).find("a.result__a").first();
    const title = normalizeText(anchor.html() || anchor.text());
    const href = anchor.attr("href") || "";
    const snippet = normalizeText($(el).find(".result__snippet").first().html() || $(el).find(".result__snippet").first().text());
    if (title && href) results.push({ title, url: normalizeDuckUrl(href), snippet: snippet || undefined });
    return undefined;
  });
  return results;
}

function parseBingResults(html: string, maxResults: number): SearchEntry[] {
  const $ = cheerio.load(html);
  const results: SearchEntry[] = [];
  $("li.b_algo").each((_, el) => {
    if (results.length >= maxResults) return false;
    const anchor = $(el).find("h2 a").first();
    const title = normalizeText(anchor.html() || anchor.text());
    const href = anchor.attr("href") || "";
    const snippet = normalizeText($(el).find(".b_caption p").first().html() || $(el).find(".b_caption p").first().text());
    if (title && href) results.push({ title, url: normalizeBingUrl(href), snippet: snippet || undefined });
    return undefined;
  });
  return results;
}

function parseGenericResults(html: string, baseUrl: string, maxResults: number): SearchEntry[] {
  const $ = cheerio.load(html);
  const results: SearchEntry[] = [];
  const seen = new Set<string>();
  $("a[href]").each((_, el) => {
    if (results.length >= maxResults) return false;
    const href = $(el).attr("href") || "";
    const title = normalizeText($(el).text());
    if (!title || title.length < 3) return undefined;
    const url = normalizeSearchResultUrl(href, baseUrl);
    if (!url || seen.has(url)) return undefined;
    seen.add(url);
    results.push({ title: title.slice(0, 160), url });
    return undefined;
  });
  return results;
}

function isDuckChallenge(html: string): boolean {
  return html.includes("anomaly-modal") || html.includes("Unfortunately, bots use DuckDuckGo too");
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError") return false;
  const message = formatFetchError(error).toLowerCase();
  return /fetch failed|network|timeout|timed? out|econnreset|econnrefused|enotfound|eai_again|socket|tls|terminated/.test(message);
}

function formatFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause as { code?: string; message?: string } | undefined;
  if (cause?.code || cause?.message) {
    return `${error.message}${cause.code ? ` (${cause.code})` : ""}${cause.message ? `: ${cause.message}` : ""}`;
  }
  return error.message;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted|abort/i.test(error.message));
}

async function fetchTextOnce(
  url: string,
  timeoutMs: number,
  accept: string,
  options: { signal?: AbortSignal; maxBytes?: number; validateRedirect?: (url: string) => Promise<void>; config?: ResolvedWebConfig } = {},
): Promise<FetchResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromParent = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener("abort", abortFromParent, { once: true });
  try {
    let current = url;
    let resp: Response | null = null;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const dispatcher = dispatcherForUrl(current, options.config);
      resp = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        dispatcher: dispatcher as any,
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": accept,
          "Accept-Language": "en-US,en;q=0.9",
          "Cache-Control": "no-cache",
        },
      });
      if (![301, 302, 303, 307, 308].includes(resp.status)) break;
      const location = resp.headers.get("location");
      if (!location) break;
      current = new URL(location, current).toString();
      await options.validateRedirect?.(current);
      if (redirects === MAX_REDIRECTS) throw new Error(`too many redirects (${MAX_REDIRECTS})`);
    }
    if (!resp) throw new Error("request failed before response");
    const { text, truncated } = await readResponseText(resp, options.maxBytes || DEFAULT_MAX_BYTES);
    return {
      status: resp.status,
      url: resp.url || current,
      contentType: resp.headers.get("content-type") || "application/octet-stream",
      text,
      truncated,
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromParent);
  }
}

async function fetchText(
  url: string,
  timeoutMs: number,
  accept: string,
  options: { signal?: AbortSignal; maxBytes?: number; retries?: number; validateRedirect?: (url: string) => Promise<void>; config?: ResolvedWebConfig } = {},
): Promise<FetchResponse> {
  const retries = Math.max(0, Math.min(options.retries ?? 1, 3));
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchTextOnce(url, timeoutMs, accept, options);
      if (attempt < retries && isRetryableStatus(response.status)) {
        lastError = new Error(`HTTP ${response.status}`);
        await delay(150 * (attempt + 1));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !isRetryableError(error)) break;
      await delay(150 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function readResponseText(resp: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const cap = Math.max(1, Math.min(maxBytes, MAX_BYTES));
  if (!resp.body) {
    const text = await resp.text();
    return { text: text.slice(0, cap), truncated: text.length > cap };
  }
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = cap - total;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      if (value.byteLength > remaining) {
        chunks.push(value.slice(0, remaining));
        total += remaining;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => undefined);
  }
  return { text: Buffer.concat(chunks).toString("utf-8"), truncated };
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function hostWithoutBrackets(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
}

function domainMatches(hostname: string, patterns: string[]): boolean {
  const host = hostWithoutBrackets(hostname).replace(/\.$/, "");
  return patterns.some(pattern => {
    const normalized = pattern.toLowerCase().replace(/^\*\./, ".").replace(/\.$/, "");
    if (!normalized) return false;
    if (normalized.startsWith(".")) return host.endsWith(normalized) || host === normalized.slice(1);
    return host === normalized || host.endsWith(`.${normalized}`);
  });
}

function noProxyMatches(hostname: string, patterns: string[]): boolean {
  const envNoProxy = process.env.NO_PROXY || process.env.no_proxy || "";
  return domainMatches(hostname, [
    ...patterns,
    ...envNoProxy.split(",").map(item => item.trim()).filter(Boolean),
  ]);
}

function safeLookup(
  hostname: string,
  options: unknown,
  callback: (error: NodeJS.ErrnoException | null, address: unknown, family?: unknown) => void,
): void {
  callbackLookup(hostname, options as any, (error, address, family) => {
    if (error) {
      callback(error, address as any, family as any);
      return;
    }
    const addresses = Array.isArray(address)
      ? address.map(item => item.address)
      : [String(address)];
    const blocked = addresses.find(item => isRestrictedIpAddress(item));
    if (blocked) {
      const err = new Error(`blocked restricted resolved IP: ${blocked}`) as NodeJS.ErrnoException;
      err.code = "EAI_BLOCKED_PRIVATE_IP";
      callback(err, address as any, family as any);
      return;
    }
    callback(null, address as any, family as any);
  });
}

function dispatcherForUrl(rawUrl: string, config?: ResolvedWebConfig): Dispatcher | undefined {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (config?.proxy && !noProxyMatches(parsed.hostname, config.noProxy)) {
    let dispatcher = PROXY_DISPATCHERS.get(config.proxy);
    if (!dispatcher) {
      dispatcher = new ProxyAgent(config.proxy);
      PROXY_DISPATCHERS.set(config.proxy, dispatcher);
    }
    return dispatcher;
  }
  if (noProxyMatches(parsed.hostname, config?.noProxy || [])) return SAFE_DISPATCHER;
  const hasEnvProxy = Boolean(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy);
  if (!hasEnvProxy) return SAFE_DISPATCHER;
  if (ENV_DISPATCHER === undefined) ENV_DISPATCHER = new EnvHttpProxyAgent();
  return ENV_DISPATCHER || undefined;
}

async function searchDuckDuckGo(query: string, maxResults: number, timeoutMs: number, config: ResolvedWebConfig, signal?: AbortSignal): Promise<SearchEntry[]> {
  await assertPublicUrl("https://html.duckduckgo.com/", { ...config, allowedDomains: [] });
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const resp = await fetchText(url, timeoutMs, "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", { signal, maxBytes: Math.min(DEFAULT_MAX_BYTES, config.maxBytes), retries: 1, config });
  if (resp.status < 200 || resp.status >= 300) throw new Error(`DuckDuckGo HTTP ${resp.status}`);
  const results = parseDuckResults(resp.text, maxResults);
  if (!results.length && isDuckChallenge(resp.text)) throw new Error("DuckDuckGo returned a bot challenge");
  return results.length ? results : parseGenericResults(resp.text, resp.url, maxResults);
}

async function searchBing(query: string, maxResults: number, timeoutMs: number, config: ResolvedWebConfig, signal?: AbortSignal): Promise<SearchEntry[]> {
  await assertPublicUrl("https://www.bing.com/", { ...config, allowedDomains: [] });
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
  const resp = await fetchText(url, timeoutMs, "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", { signal, maxBytes: Math.min(DEFAULT_MAX_BYTES, config.maxBytes), retries: 1, config });
  if (resp.status < 200 || resp.status >= 300) throw new Error(`Bing HTTP ${resp.status}`);
  const results = parseBingResults(resp.text, maxResults);
  return results.length ? results : parseGenericResults(resp.text, resp.url, maxResults);
}

async function searchWithFallback(
  query: string,
  maxResults: number,
  timeoutMs: number,
  engine: "auto" | "bing" | "duckduckgo",
  config: ResolvedWebConfig,
  signal?: AbortSignal,
): Promise<{ source: string; results: SearchEntry[]; failures: string[] }> {
  const failures: string[] = [];
  const candidates = engine === "bing"
    ? [{ source: "Bing", run: searchBing }]
    : engine === "duckduckgo"
      ? [{ source: "DuckDuckGo", run: searchDuckDuckGo }]
      : [
          { source: "Bing", run: searchBing },
          { source: "DuckDuckGo", run: searchDuckDuckGo },
        ];
  for (const candidate of candidates) {
    try {
      const results = await candidate.run(query, maxResults, timeoutMs, config, signal);
      if (results.length) {
        return { source: candidate.source, results, failures };
      }
      failures.push(`${candidate.source}: no parseable results`);
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error;
      failures.push(`${candidate.source}: ${formatFetchError(error)}`);
    }
  }

  return { source: "", results: [], failures };
}

function assignRefs(query: string, source: string, results: SearchEntry[]): SearchEntry[] {
  return results.map(result => {
    const ref_id = `web_${(++refSeq).toString(36)}`;
    WEB_REFS.set(ref_id, {
      url: result.url,
      title: result.title,
      snippet: result.snippet,
      source,
      query,
      createdAt: Date.now(),
    });
    pruneRefs();
    return { ...result, ref_id };
  });
}

function filterSearchResults(results: SearchEntry[], allowedDomains: string[], blockedDomains: string[]): SearchEntry[] {
  return results.filter(result => {
    try {
      const hostname = new URL(result.url).hostname;
      if (blockedDomains.length && domainMatches(hostname, blockedDomains)) return false;
      if (allowedDomains.length && !domainMatches(hostname, allowedDomains)) return false;
      return true;
    } catch {
      return false;
    }
  });
}

function pruneRefs(): void {
  const maxRefs = 200;
  const maxAgeMs = 6 * 60 * 60 * 1000;
  const now = Date.now();
  for (const [key, value] of WEB_REFS) {
    if (now - value.createdAt > maxAgeMs) WEB_REFS.delete(key);
  }
  while (WEB_REFS.size > maxRefs) {
    const first = WEB_REFS.keys().next().value;
    if (!first) break;
    WEB_REFS.delete(first);
  }
}

async function webSearchWithConfig(args: Record<string, unknown>, config: ResolvedWebConfig, signal?: AbortSignal): Promise<string> {
  const query = extractSearchQuery(args);
  if (!query) return "Error searching: query is required.";

  if (!config.enabled || config.mode === "off") return "Error searching: web tools are disabled by configuration.";
  const maxResults = extractSearchMaxResults(args);
  const timeoutMs = asPositiveInt(args.timeout_ms, config.searchTimeoutMs, MAX_TIMEOUT_MS);
  const engine = normalizeSearchEngine(args.engine || args.source || config.searchEngine);
  const jsonOutput = asBool(args.json, false);
  const requestedDomains = extractSearchDomains(args);
  const effectiveAllowedDomains = requestedDomains.length
    ? requestedDomains.filter(domain => !config.allowedDomains.length || domainMatches(domain, config.allowedDomains))
    : config.allowedDomains;
  if (requestedDomains.length && !effectiveAllowedDomains.length) {
    return jsonOutput
      ? JSON.stringify({ query, source: "", count: 0, results: [], failures: ["requested domains are outside web.allowed_domains"], message: `No results for '${query}'` }, null, 2)
      : `No results for '${query}'. Tried requested domains but they are outside web.allowed_domains`;
  }
  const searchQuery = effectiveAllowedDomains.length
    ? `${query} ${effectiveAllowedDomains.map(domain => `site:${domain.replace(/^\*\./, "").replace(/^\./, "")}`).join(" OR ")}`
    : query;
  const { source, results: rawResults, failures } = await searchWithFallback(searchQuery, maxResults, timeoutMs, engine, config, signal);
  const results = assignRefs(query, source, filterSearchResults(rawResults, effectiveAllowedDomains, config.blockedDomains));

  if (!results.length) {
    const payload = { query, source: "", count: 0, results: [], failures, message: `No results for '${query}'` };
    return jsonOutput ? JSON.stringify(payload, null, 2) : `No results for '${query}'. Tried ${failures.join(" | ") || "no engines"}`;
  }

  if (jsonOutput) {
    return JSON.stringify({
      query,
      source,
      count: results.length,
      results,
      failures,
      message: `Found ${results.length} result(s)`,
    }, null, 2);
  }

  const lines = [`Search results for: ${query}`, `Source: ${source}`, ""];
  results.forEach((result, index) => {
    lines.push(`${index + 1}. ${result.title}`, `   ref_id: ${result.ref_id}`, `   ${result.url}`);
    if (result.snippet) lines.push(`   ${result.snippet}`);
    lines.push("");
  });
  if (failures.length) lines.push(`Note: ${failures.join(" | ")}`);
  return lines.join("\n");
}

function isRestrictedIPv4(ip: string): boolean {
  const parts = ip.split(".").map(part => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  return a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19));
}

function isRestrictedIPv6(ip: string): boolean {
  const normalized = hostWithoutBrackets(ip);
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:")) return true;
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    if (mapped.includes(".")) return isRestrictedIPv4(mapped);
    const parts = mapped.split(":");
    if (parts.length === 2) {
      const high = Number.parseInt(parts[0] || "0", 16);
      const low = Number.parseInt(parts[1] || "0", 16);
      if (Number.isFinite(high) && Number.isFinite(low)) {
        const v4 = [
          (high >> 8) & 255,
          high & 255,
          (low >> 8) & 255,
          low & 255,
        ].join(".");
        return isRestrictedIPv4(v4);
      }
    }
    return true;
  }
  return false;
}

function isRestrictedIpAddress(address: string): boolean {
  const host = hostWithoutBrackets(address);
  if (isIP(host) === 4) return isRestrictedIPv4(host);
  if (isIP(host) === 6) return isRestrictedIPv6(host);
  return false;
}

function isRestrictedHost(hostname: string): boolean {
  const host = hostWithoutBrackets(hostname);
  if (host === "localhost" || host.endsWith(".localhost") || host === "localhost.localdomain") return true;
  if (isIP(host)) return isRestrictedIpAddress(host);
  return false;
}

async function assertPublicUrl(rawUrl: string, config?: ResolvedWebConfig): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("invalid URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("only http:// and https:// URLs are supported");
  }
  if (config?.blockedDomains.length && domainMatches(parsed.hostname, config.blockedDomains)) {
    throw new Error(`blocked by web.blocked_domains: ${parsed.hostname}`);
  }
  if (config?.allowedDomains.length && !domainMatches(parsed.hostname, config.allowedDomains)) {
    throw new Error(`blocked by web.allowed_domains: ${parsed.hostname}`);
  }
  if (isRestrictedHost(parsed.hostname)) {
    throw new Error(`blocked restricted host: ${parsed.hostname}`);
  }

  try {
    const addresses = await lookup(parsed.hostname, { all: true });
    for (const address of addresses) {
      if (isRestrictedIpAddress(address.address)) {
        throw new Error(`blocked restricted resolved IP: ${address.address}`);
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("blocked restricted")) throw error;
  }

  return parsed;
}

function htmlToText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, nav, footer, header, noscript, svg, iframe, canvas").remove();
  const title = normalizeText($("title").first().text());
  const body = $("main").length ? $("main").text() : $("article").length ? $("article").text() : $("body").length ? $("body").text() : $.text();
  const text = body.split("\n").map(line => normalizeText(line)).filter(Boolean).join("\n");
  return [title, text].filter(Boolean).join("\n\n").replace(/\n{3,}/g, "\n\n");
}

function htmlToMarkdown(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, nav, footer, header, noscript, svg, iframe, canvas").remove();
  $("br").replaceWith("\n");
  $("h1,h2,h3").each((_, el) => {
    const tag = el.tagName.toLowerCase();
    const level = tag === "h1" ? "# " : tag === "h2" ? "## " : "### ";
    $(el).replaceWith(`\n${level}${normalizeText($(el).text())}\n`);
  });
  $("li").each((_, el) => {
    $(el).replaceWith(`\n- ${normalizeText($(el).text())}`);
  });
  $("p,div,section,article").each((_, el) => {
    $(el).append("\n");
  });
  const title = normalizeText($("title").first().text());
  const body = $("main").length ? $("main").text() : $("article").length ? $("article").text() : $("body").length ? $("body").text() : $.text();
  const text = decodeHtml(body).split("\n").map(line => line.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
  return [title ? `# ${title}` : "", text].filter(Boolean).join("\n\n").replace(/\n{3,}/g, "\n\n");
}

function processBody(body: string, contentType: string, format: "markdown" | "text" | "raw"): string {
  if (format === "raw") return body;
  const isHtml = contentType.includes("text/html") || /<html[\s>]/i.test(body) || /<(article|main|body|p|h1|h2)[\s>]/i.test(body);
  if (!isHtml) return body;
  return format === "markdown" ? htmlToMarkdown(body) : htmlToText(body);
}

function formatFetchResult(resp: FetchResponse, content: string, jsonOutput: boolean): string {
  if (jsonOutput) {
    return JSON.stringify({
      url: resp.url,
      status: resp.status,
      content_type: resp.contentType,
      truncated: resp.truncated,
      content,
    }, null, 2);
  }
  const header = [
    `URL: ${resp.url}`,
    `Status: ${resp.status}`,
    `Content-Type: ${resp.contentType}`,
    `Truncated: ${resp.truncated}`,
    "",
  ].join("\n");
  return header + content;
}

async function webFetchWithConfig(args: Record<string, unknown>, config: ResolvedWebConfig, signal?: AbortSignal): Promise<string> {
  if (!config.enabled || config.mode === "off") return "Error fetching URL: web tools are disabled by configuration.";
  const refId = extractRefId(args);
  const ref = refId ? WEB_REFS.get(refId) : undefined;
  const rawUrl = typeof args.url === "string" && args.url.trim() ? args.url.trim() : ref?.url || "";
  if (!rawUrl) return "Error fetching URL: url is required.";

  if (refId && !ref) return `Error fetching URL: unknown ref_id '${refId}'. Run web_search first or pass url directly.`;

  const format = normalizeFetchFormat(args);
  const jsonOutput = asBool(args.json, false);
  const timeoutMs = asPositiveInt(args.timeout_ms, config.fetchTimeoutMs, MAX_TIMEOUT_MS);
  const maxBytes = asPositiveInt(args.max_bytes, config.maxBytes, MAX_BYTES);

  try {
    const parsed = await assertPublicUrl(rawUrl, config);
    const resp = await fetchText(parsed.toString(), timeoutMs, "text/html,text/plain,application/json,application/xml,*/*;q=0.8", {
      signal,
      maxBytes,
      retries: 1,
      config,
      validateRedirect: async (url) => { await assertPublicUrl(url, config); },
    });
    const content = processBody(resp.text, resp.contentType, format).slice(0, maxBytes);
    return formatFetchResult(resp, content, jsonOutput);
  } catch (error) {
    return `Error fetching URL: ${formatFetchError(error)}`;
  }
}

export function registerWebTools(configInput?: Partial<WebConfig>): void {
  const r = getRegistry();
  const webConfig = resolveWebConfig(configInput);
  const searchExecute = (args: Record<string, unknown>, context?: ToolExecutionContext) =>
    webSearchWithConfig(args, webConfig, context?.signal);
  const fetchExecute = (args: Record<string, unknown>, context?: ToolExecutionContext) =>
    webFetchWithConfig(args, webConfig, context?.signal);
  r.register({
    name: "web_search",
    description: "Search the web using Bing with DuckDuckGo fallback. Returns titles, URLs, snippets.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query. Alias: q." },
        q: { type: "string", description: "Search query alias." },
        search_query: {
          type: "array",
          description: "Compatibility array form: [{ q, query, max_results }].",
          items: { type: "object", properties: { q: { type: "string" }, query: { type: "string" }, max_results: { type: "integer" }, domains: { type: "array", items: { type: "string" } } } },
        },
        max_results: { type: "integer", default: DEFAULT_MAX_RESULTS, maximum: MAX_RESULTS },
        timeout_ms: { type: "integer", default: DEFAULT_SEARCH_TIMEOUT_MS, maximum: MAX_TIMEOUT_MS },
        domains: { type: "array", items: { type: "string" }, description: "Optional domain filter, e.g. [\"example.com\"]." },
        engine: { type: "string", enum: ["auto", "bing", "duckduckgo"], default: "auto" },
        json: { type: "boolean", default: false },
      },
    },
    execute: searchExecute,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "web",
    parallelOk: true,
  });
  r.register({
    name: "web_fetch",
    description: "Fetch and extract text from an HTTP/HTTPS URL or web_search ref_id.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        ref_id: { type: "string", description: "Result ref_id returned by web_search." },
        format: { type: "string", enum: ["markdown", "text", "raw"], default: "markdown" },
        extract_text: { type: "boolean", default: true },
        max_bytes: { type: "integer", default: DEFAULT_MAX_BYTES, maximum: MAX_BYTES },
        timeout_ms: { type: "integer", default: DEFAULT_TIMEOUT_MS, maximum: MAX_TIMEOUT_MS },
        json: { type: "boolean", default: false },
      },
    },
    execute: fetchExecute,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "web",
    parallelOk: true,
  });
  r.register({
    name: "fetch_url",
    description: "Alias for web_fetch. Fetch a known HTTP/HTTPS URL and return content.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        ref_id: { type: "string" },
        format: { type: "string", enum: ["markdown", "text", "raw"], default: "markdown" },
        max_bytes: { type: "integer", default: DEFAULT_MAX_BYTES, maximum: MAX_BYTES },
        timeout_ms: { type: "integer", default: DEFAULT_TIMEOUT_MS, maximum: MAX_TIMEOUT_MS },
        json: { type: "boolean", default: false },
      },
    },
    execute: fetchExecute,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "web",
    parallelOk: true,
    deferLoading: true,
  });
}
