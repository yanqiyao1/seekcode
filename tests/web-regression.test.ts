import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getRegistry } from "../src/tools/registry.js";
import { registerWebTools } from "../src/tools/web.js";

let oldHttpProxy: string | undefined;
let oldHttpsProxy: string | undefined;
let oldNoProxy: string | undefined;

beforeEach(() => {
  oldHttpProxy = process.env.HTTP_PROXY;
  oldHttpsProxy = process.env.HTTPS_PROXY;
  oldNoProxy = process.env.NO_PROXY;
  delete process.env.HTTP_PROXY;
  delete process.env.http_proxy;
  delete process.env.HTTPS_PROXY;
  delete process.env.https_proxy;
  delete process.env.NO_PROXY;
  delete process.env.no_proxy;
  getRegistry().clear();
  registerWebTools();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (oldHttpProxy === undefined) delete process.env.HTTP_PROXY;
  else process.env.HTTP_PROXY = oldHttpProxy;
  if (oldHttpsProxy === undefined) delete process.env.HTTPS_PROXY;
  else process.env.HTTPS_PROXY = oldHttpsProxy;
  if (oldNoProxy === undefined) delete process.env.NO_PROXY;
  else process.env.NO_PROXY = oldNoProxy;
});

describe("web tools", () => {
  it("falls back to DuckDuckGo when Bing fails", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("bing.com")) {
        throw new Error("connect timeout");
      }
      if (url.includes("duckduckgo.com")) {
        return new Response(`
          <html><body>
            <div class="result">
              <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fnews">Example News</a>
              <a class="result__snippet">Useful snippet &amp; context.</a>
            </div>
          </body></html>
        `, { status: 200, headers: { "content-type": "text/html" } });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await getRegistry().lookup("web_search")!.execute({
      query: "latest news",
      max_results: 1,
      timeout_ms: 1000,
    });

    expect(result).toContain("Source: DuckDuckGo");
    expect(result).toContain("Example News");
    expect(result).toContain("ref_id: web_");
    expect(result).toContain("https://example.com/news");
    expect(result).toContain("Bing");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("accepts q and search_query compatibility aliases", async () => {
    const duckHtml = `
      <html><body>
        <div class="result">
          <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fdeepseek">DeepSeek Result</a>
          <a class="result__snippet">Snippet text</a>
        </div>
      </body></html>
    `;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(duckHtml, { status: 200, headers: { "content-type": "text/html" } })
    );

    const qResult = await getRegistry().lookup("web_search")!.execute({ q: "deepseek" });
    const arrayResult = await getRegistry().lookup("web_search")!.execute({
      search_query: [{ q: "deepseek api", max_results: 1 }],
    });

    expect(qResult).toContain("DeepSeek Result");
    expect(qResult).toContain("https://example.com/deepseek");
    expect(arrayResult).toContain("DeepSeek Result");
  });

  it("fetches and extracts text from reachable HTTP pages", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(`
      <html>
        <head><title>Local Title</title><style>.x{color:red}</style></head>
        <body><script>alert(1)</script><h1>Hello &amp; welcome</h1><p>Readable text.</p></body>
      </html>
    `, { status: 200, headers: { "content-type": "text/html" } }));

    const result = await getRegistry().lookup("web_fetch")!.execute({ url: "http://93.184.216.34/" });

    expect(result).toContain("Status: 200");
    expect(result).toContain("Local Title");
    expect(result).toContain("Hello & welcome");
    expect(result).toContain("Readable text.");
    expect(result).not.toContain("alert");
    expect(result).not.toContain("color:red");
  });

  it("fetches search results by ref_id", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("bing.com")) {
        return new Response(`
          <html><body>
            <li class="b_algo">
              <h2><a href="https://example.com/ref-page">Ref Page</a></h2>
              <div class="b_caption"><p>Ref snippet</p></div>
            </li>
          </body></html>
        `, { status: 200, headers: { "content-type": "text/html" } });
      }
      if (url.includes("example.com/ref-page")) {
        return new Response("<html><body><h1>Fetched by ref</h1><p>Body text</p></body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const search = await getRegistry().lookup("web_search")!.execute({ query: "ref test", max_results: 1 });
    const ref = search.match(/ref_id: (web_[a-z0-9]+)/)?.[1];
    const fetched = await getRegistry().lookup("web_fetch")!.execute({ ref_id: ref, format: "markdown" });

    expect(ref).toBeTruthy();
    expect(fetched).toContain("# Fetched by ref");
    expect(fetched).toContain("Body text");
  });

  it("retries transient search failures before falling back", async () => {
    let bingCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("bing.com")) {
        bingCalls++;
        if (bingCalls === 1) throw new Error("fetch failed");
        return new Response(`
          <html><body>
            <li class="b_algo">
              <h2><a href="https://example.com/retry">Retry Result</a></h2>
              <div class="b_caption"><p>Retried successfully</p></div>
            </li>
          </body></html>
        `, { status: 200, headers: { "content-type": "text/html" } });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await getRegistry().lookup("web_search")!.execute({ query: "retry", engine: "bing" });

    expect(result).toContain("Retry Result");
    expect(bingCalls).toBe(2);
  });

  it("returns non-2xx fetch bodies instead of hiding useful content", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    }));

    const result = await getRegistry().lookup("fetch_url")!.execute({ url: "https://example.com/missing", json: true });
    const parsed = JSON.parse(result);

    expect(parsed.status).toBe(404);
    expect(parsed.content).toContain("not found");
  });

  it("blocks redirects to restricted hosts", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", {
      status: 302,
      headers: { location: "http://127.0.0.1/admin" },
    }));

    const result = await getRegistry().lookup("web_fetch")!.execute({ url: "https://example.com/redirect" });

    expect(result).toContain("blocked restricted host");
  });

  it("rejects localhost fetches to avoid SSRF", async () => {
    const result = await getRegistry().lookup("web_fetch")!.execute({ url: "http://localhost:1234" });

    expect(result).toContain("blocked restricted host");
  });

  it("rejects IPv4-mapped IPv6 localhost fetches", async () => {
    const result = await getRegistry().lookup("web_fetch")!.execute({ url: "http://[::ffff:127.0.0.1]/admin" });

    expect(result).toContain("blocked restricted host");
  });

  it("honors web disabled config", async () => {
    getRegistry().clear();
    registerWebTools({ enabled: false, mode: "off" });

    const search = await getRegistry().lookup("web_search")!.execute({ query: "anything" });
    const fetch = await getRegistry().lookup("web_fetch")!.execute({ url: "https://example.com" });

    expect(search).toContain("disabled by configuration");
    expect(fetch).toContain("disabled by configuration");
  });

  it("enforces allowed domains for direct fetch", async () => {
    getRegistry().clear();
    registerWebTools({ allowed_domains: ["example.com"] });

    const result = await getRegistry().lookup("web_fetch")!.execute({ url: "https://blocked.test/page" });

    expect(result).toContain("blocked by web.allowed_domains");
  });

  it("applies allowed domain filters to search results", async () => {
    getRegistry().clear();
    registerWebTools({ allowed_domains: ["allowed.example"] });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      expect(url).toContain("site%3Aallowed.example");
      return new Response(`
        <html><body>
          <li class="b_algo">
            <h2><a href="https://allowed.example/ok">Allowed Result</a></h2>
            <div class="b_caption"><p>Allowed snippet</p></div>
          </li>
          <li class="b_algo">
            <h2><a href="https://blocked.example/no">Blocked Result</a></h2>
            <div class="b_caption"><p>Blocked snippet</p></div>
          </li>
        </body></html>
      `, { status: 200, headers: { "content-type": "text/html" } });
    });

    const result = await getRegistry().lookup("web_search")!.execute({ query: "domain filter", engine: "bing", max_results: 5 });

    expect(result).toContain("Allowed Result");
    expect(result).toContain("https://allowed.example/ok");
    expect(result).not.toContain("Blocked Result");
  });

  it("applies blocked domain filters to search results", async () => {
    getRegistry().clear();
    registerWebTools({ blocked_domains: ["blocked.example"] });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(`
        <html><body>
          <li class="b_algo">
            <h2><a href="https://allowed.example/ok">Allowed Result</a></h2>
            <div class="b_caption"><p>Allowed snippet</p></div>
          </li>
          <li class="b_algo">
            <h2><a href="https://blocked.example/no">Blocked Result</a></h2>
            <div class="b_caption"><p>Blocked snippet</p></div>
          </li>
        </body></html>
      `, { status: 200, headers: { "content-type": "text/html" } })
    );

    const result = await getRegistry().lookup("web_search")!.execute({ query: "domain filter", engine: "bing", max_results: 5 });

    expect(result).toContain("Allowed Result");
    expect(result).not.toContain("Blocked Result");
    expect(result).not.toContain("https://blocked.example/no");
  });

  it("rejects requested search domains outside allowed domains before fetching", async () => {
    getRegistry().clear();
    registerWebTools({ allowed_domains: ["allowed.example"] });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }));

    const result = await getRegistry().lookup("web_search")!.execute({
      query: "domain filter",
      domains: ["blocked.example"],
      json: true,
    });
    const parsed = JSON.parse(result);

    expect(parsed.count).toBe(0);
    expect(parsed.failures[0]).toContain("outside web.allowed_domains");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks direct fetches to blocked domains", async () => {
    getRegistry().clear();
    registerWebTools({ blocked_domains: ["blocked.example"] });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("should not fetch", { status: 200 }));

    const result = await getRegistry().lookup("web_fetch")!.execute({ url: "https://blocked.example/page" });

    expect(result).toContain("blocked by web.blocked_domains");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes explicit proxy dispatcher to fetch", async () => {
    getRegistry().clear();
    registerWebTools({ proxy: "http://proxy.example:8080" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", {
      status: 200,
      headers: { "content-type": "text/plain" },
    }));

    await getRegistry().lookup("web_fetch")!.execute({ url: "https://example.com/page" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit & { dispatcher?: unknown };
    expect(init.dispatcher).toBeTruthy();
  });

  it("honors no_proxy for explicit proxy configuration", async () => {
    getRegistry().clear();
    registerWebTools({ proxy: "http://proxy.example:8080", no_proxy: ["example.com"] });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", {
      status: 200,
      headers: { "content-type": "text/plain" },
    }));

    await getRegistry().lookup("web_fetch")!.execute({ url: "https://example.com/page" });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit & { dispatcher?: unknown };
    expect(init.dispatcher).toBeTruthy();
    expect(init.dispatcher?.constructor?.name).not.toBe("ProxyAgent");
  });

  it("uses the final redirect URL and extracts the redirected body", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://example.com/redirect") {
        return new Response("", {
          status: 302,
          headers: { location: "https://example.com/final" },
        });
      }
      if (url === "https://example.com/final") {
        return new Response("<html><body><h1>Final page</h1></body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await getRegistry().lookup("web_fetch")!.execute({ url: "https://example.com/redirect" });

    expect(result).toContain("URL: https://example.com/final");
    expect(result).toContain("# Final page");
  });

  it("truncates large pages at the configured byte cap", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("a".repeat(200), {
      status: 200,
      headers: { "content-type": "text/plain" },
    }));

    const result = await getRegistry().lookup("web_fetch")!.execute({
      url: "https://example.com/large",
      max_bytes: 32,
      json: true,
      format: "raw",
    });
    const parsed = JSON.parse(result);

    expect(parsed.truncated).toBe(true);
    expect(parsed.content).toHaveLength(32);
    expect(parsed.content).toBe("a".repeat(32));
  });

  it("applies current domain policy when fetching a stored ref_id", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(`
        <html><body>
          <li class="b_algo">
            <h2><a href="https://example.com/ref-page">Ref Page</a></h2>
            <div class="b_caption"><p>Ref snippet</p></div>
          </li>
        </body></html>
      `, { status: 200, headers: { "content-type": "text/html" } })
    );
    const search = await getRegistry().lookup("web_search")!.execute({ query: "ref policy", max_results: 1 });
    const ref = search.match(/ref_id: (web_[a-z0-9]+)/)?.[1];
    getRegistry().clear();
    registerWebTools({ blocked_domains: ["example.com"] });

    const fetched = await getRegistry().lookup("web_fetch")!.execute({ ref_id: ref });

    expect(ref).toBeTruthy();
    expect(fetched).toContain("blocked by web.blocked_domains");
  });
});
