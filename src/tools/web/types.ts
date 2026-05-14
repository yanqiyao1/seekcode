export type SearchEngine = "auto" | "bing" | "duckduckgo" | "brave" | "tavily" | "serper" | "searxng" | "google" | "arxiv" | "baidu" | "exa" | "kagi" | "semantic_scholar" | "pubmed";
export type SearchType = "auto" | "fast" | "deep";

export interface SearchEntry {
  title: string;
  url: string;
  snippet?: string;
  ref_id?: string;
  content?: string;
  content_error?: string;
  content_profile?: ContentProfile;
}

export interface FetchResponse {
  status: number;
  url: string;
  contentType: string;
  text: string;
  truncated: boolean;
}

export interface SearchOutcome {
  source: string;
  results: SearchEntry[];
  failures: string[];
  telemetry?: SearchEngineTelemetry[];
  cacheHit?: boolean;
}

export interface CacheEntry<T> {
  createdAt: number;
  value: T;
}

export interface WebRef {
  url: string;
  title: string;
  snippet?: string;
  source: string;
  query: string;
  createdAt: number;
}

export interface SearchEngineTelemetry {
  engine: string;
  source: string;
  ok: boolean;
  duration_ms: number;
  result_count: number;
  error?: string;
  cache_hit?: boolean;
}

export interface ContentProfile {
  title?: string;
  format: "html" | "json" | "xml" | "text" | "binary";
  character_count: number;
  word_count: number;
  truncated: boolean;
  main_content_ratio?: number;
}

export interface WebStats {
  search_calls: number;
  search_cache_hits: number;
  search_engine_calls: Record<string, number>;
  search_engine_failures: Record<string, number>;
  search_engine_ms: Record<string, number>;
  fetch_calls: number;
  fetch_cache_hits: number;
  fetch_failures: number;
  fetch_ms: number;
  host_queue_waits: Record<string, number>;
}

export interface ResolvedWebConfig {
  enabled: boolean;
  mode: "live" | "off";
  searchEngine: SearchEngine;
  allowedDomains: string[];
  blockedDomains: string[];
  googleApiKey: string;
  googleCx: string;
  exaApiKey: string;
  kagiApiKey: string;
  braveApiKey: string;
  tavilyApiKey: string;
  serperApiKey: string;
  semanticScholarApiKey: string;
  pubmedApiKey: string;
  searxngUrl: string;
  proxy: string;
  noProxy: string[];
  searchTimeoutMs: number;
  fetchTimeoutMs: number;
  maxBytes: number;
}
