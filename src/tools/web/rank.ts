import type { SearchEntry } from "./types.js";

export function canonicalSearchUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    const removable = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "utm_id",
      "fbclid",
      "gclid",
      "mc_cid",
      "mc_eid",
    ];
    for (const key of removable) parsed.searchParams.delete(key);
    if ((parsed.protocol === "http:" && parsed.port === "80") || (parsed.protocol === "https:" && parsed.port === "443")) parsed.port = "";
    if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    parsed.hostname = parsed.hostname.toLowerCase();
    return parsed.toString();
  } catch {
    return null;
  }
}

export function dedupeSearchResults(results: SearchEntry[], maxResults: number): SearchEntry[] {
  const seen = new Set<string>();
  const deduped: SearchEntry[] = [];
  for (const result of results) {
    const canonical = canonicalSearchUrl(result.url);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    deduped.push({ ...result, url: canonical });
    if (deduped.length >= maxResults) break;
  }
  return deduped;
}

export function rankSearchResults(query: string, results: SearchEntry[], maxResults: number): SearchEntry[] {
  const terms = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(term => term.length >= 2);
  return results
    .map((result, index) => ({ result, score: scoreSearchResult(result, terms, index) }))
    .sort((a, b) => b.score - a.score || a.result.title.localeCompare(b.result.title))
    .slice(0, maxResults)
    .map(item => item.result);
}

function scoreSearchResult(result: SearchEntry, terms: string[], index: number): number {
  const title = result.title.toLowerCase();
  const snippet = (result.snippet || "").toLowerCase();
  let score = Math.max(0, 100 - index);
  for (const term of terms) {
    if (title.includes(term)) score += 15;
    if (snippet.includes(term)) score += 5;
  }
  try {
    const url = new URL(result.url);
    const host = url.hostname.toLowerCase();
    if (host.endsWith(".edu") || host.endsWith(".gov")) score += 8;
    if (/docs|developer|api|reference|guide/.test(url.pathname.toLowerCase())) score += 6;
    if (/github\.com|npmjs\.com|pypi\.org|developer\.mozilla\.org/.test(host)) score += 5;
    if (/\/(tag|category|search|login|signup)\b/i.test(url.pathname)) score -= 10;
  } catch {
    score -= 50;
  }
  if (!result.snippet) score -= 4;
  return score;
}
