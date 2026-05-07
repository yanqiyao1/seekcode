import { describe, expect, it, vi } from "vitest";

const createMock = vi.fn();

vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: createMock } },
  })),
}));

const { DeepSeekClient, sanitizeMessagesForThinkingMode } = await import("../src/client/deepseek.js");
const { providerCapability, extractCachedInputTokens } = await import("../src/client/capabilities.js");

describe("DeepSeekClient", () => {
  it("captures usage-only final stream chunks", async () => {
    createMock.mockResolvedValueOnce(streamFrom([
      { choices: [{ delta: { content: "hi" }, finish_reason: null }] },
      { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
    ]));
    const client = new DeepSeekClient({ apiKey: "key", baseUrl: "http://localhost", model: "deepseek-v4-pro" });

    const events = await collect(client.send([{ role: "user", content: "hello" }] as any, null, { max_tokens: 5 }));

    expect(events.at(-1)).toMatchObject({ type: "done", usage: { total_tokens: 5 }, content: "hi" });
  });

  it("omits tools from requests when there are no tool schemas", async () => {
    createMock.mockResolvedValueOnce(streamFrom([{ choices: [], usage: { total_tokens: 0 } }]));
    const client = new DeepSeekClient({ apiKey: "key", baseUrl: "http://localhost", model: "deepseek-v4-pro" });

    await collect(client.send([{ role: "user", content: "hello" }] as any, null));

    expect(createMock).toHaveBeenLastCalledWith(expect.not.objectContaining({ tools: expect.anything() }));
  });

  it("emits tool_call_begin only once per streamed tool call", async () => {
    createMock.mockResolvedValueOnce(streamFrom([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: "{\"path\"" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "read", arguments: ":\"x\"}" } }] }, finish_reason: "tool_calls" }] },
      { choices: [], usage: { total_tokens: 1 } },
    ]));
    const client = new DeepSeekClient({ apiKey: "key", baseUrl: "http://localhost", model: "deepseek-v4-pro" });

    const events = await collect(client.send([{ role: "user", content: "hello" }] as any));

    expect(events.filter(e => e.type === "tool_call_begin")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      tool_calls: [{ id: "call_1", name: "read", arguments: { path: "x" } }],
    });
  });

  it("passes reasoning_effort through to the API request", async () => {
    createMock.mockResolvedValueOnce(streamFrom([{ choices: [], usage: { total_tokens: 0 } }]));
    const client = new DeepSeekClient({ apiKey: "key", baseUrl: "http://localhost", model: "deepseek-v4-pro" });

    await collect(client.send([{ role: "user", content: "hello" }] as any, null, { reasoning_effort: "max", max_tokens: 7 }));

    expect(createMock).toHaveBeenLastCalledWith(expect.objectContaining({ reasoning_effort: "max", max_tokens: 7 }));
  });

  it("passes AbortSignal to the OpenAI request layer", async () => {
    createMock.mockResolvedValueOnce(streamFrom([{ choices: [], usage: { total_tokens: 0 } }]));
    const client = new DeepSeekClient({ apiKey: "key", baseUrl: "http://localhost", model: "deepseek-v4-pro" });
    const controller = new AbortController();

    await collect(client.send([{ role: "user", content: "hello" }] as any, null, { signal: controller.signal }));

    expect(createMock).toHaveBeenLastCalledWith(expect.any(Object), expect.objectContaining({ signal: controller.signal }));
  });

  it("maps local off to disabled thinking instead of pretending low reasoning is off", async () => {
    createMock.mockResolvedValueOnce(streamFrom([{ choices: [], usage: { total_tokens: 0 } }]));
    const client = new DeepSeekClient({ apiKey: "key", baseUrl: "http://localhost", model: "deepseek-v4-pro" });

    await collect(client.send([{ role: "user", content: "hello" }] as any, null, { reasoning_effort: "off", max_tokens: 7 }));

    expect(createMock).toHaveBeenLastCalledWith(expect.objectContaining({ thinking: { type: "disabled" }, max_tokens: 7 }));
    expect(createMock).toHaveBeenLastCalledWith(expect.not.objectContaining({ reasoning_effort: expect.anything() }));
  });

  it("passes assistant reasoning_content back in follow-up requests", async () => {
    createMock.mockResolvedValueOnce(streamFrom([{ choices: [], usage: { total_tokens: 0 } }]));
    const client = new DeepSeekClient({ apiKey: "key", baseUrl: "http://localhost", model: "deepseek-v4-pro" });

    await collect(client.send([
      { role: "user", content: "hello" },
      { role: "assistant", content: "calling tool", reasoning_content: "need tools" },
      { role: "tool", content: "result", tool_call_id: "call_1", name: "ls" },
    ] as any, null, { reasoning_effort: "high" }));

    expect(createMock).toHaveBeenLastCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: "calling tool",
          reasoning_content: "need tools",
        }),
      ]),
    }));
  });

  it("adds placeholder reasoning_content to assistant messages in V4 thinking mode", () => {
    const messages = sanitizeMessagesForThinkingMode([
      { role: "user", content: "hello" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "ls", arguments: "{}" } }] },
    ], "deepseek-v4-pro", "high");

    expect(messages[1]).toMatchObject({ reasoning_content: "(reasoning omitted)", content: "" });
  });

  it("does not replay reasoning_content when thinking is off", () => {
    const messages = sanitizeMessagesForThinkingMode([
      { role: "assistant", content: "ok", reasoning_content: "" },
    ], "deepseek-v4-pro", "off");

    expect(messages[0]).not.toHaveProperty("reasoning_content");
  });

  it("strips stored reasoning_content from all assistant messages when thinking is off", () => {
    const messages = sanitizeMessagesForThinkingMode([
      { role: "assistant", content: "ok", reasoning_content: "previous reasoning" },
      { role: "tool", content: "result", tool_call_id: "call_1", name: "read" },
    ], "deepseek-v4-pro", "off");

    expect(messages[0]).not.toHaveProperty("reasoning_content");
  });

  it("clamps requested max tokens to provider capability", async () => {
    createMock.mockResolvedValueOnce(streamFrom([{ choices: [], usage: { total_tokens: 0 } }]));
    const client = new DeepSeekClient({ apiKey: "key", baseUrl: "http://localhost", model: "legacy-model" });

    await collect(client.send([{ role: "user", content: "hello" }] as any, null, { max_tokens: 10_000 }));

    expect(createMock).toHaveBeenLastCalledWith(expect.objectContaining({ max_tokens: 4096 }));
  });

  it("falls back to the default max token budget when max_tokens is invalid", async () => {
    createMock.mockResolvedValueOnce(streamFrom([{ choices: [], usage: { total_tokens: 0 } }]));
    const client = new DeepSeekClient({ apiKey: "key", baseUrl: "http://localhost", model: "deepseek-v4-pro" });

    await collect(client.send([{ role: "user", content: "hello" }] as any, null, { max_tokens: Number.NaN }));

    expect(createMock).toHaveBeenLastCalledWith(expect.objectContaining({ max_tokens: 8192 }));
  });

  it("treats an explicit empty reasoning_effort as default thinking-on behavior", async () => {
    createMock.mockResolvedValueOnce(streamFrom([{ choices: [], usage: { total_tokens: 0 } }]));
    const client = new DeepSeekClient({ apiKey: "key", baseUrl: "http://localhost", model: "deepseek-v4-pro" });

    await collect(client.send([{ role: "user", content: "hello" }] as any, null, { reasoning_effort: "", max_tokens: 7 }));

    expect(createMock).toHaveBeenLastCalledWith(expect.objectContaining({
      reasoning_effort: "high",
      thinking: { type: "enabled" },
      max_tokens: 7,
    }));
  });
});

describe("DeepSeek capabilities", () => {
  it("models V4 context, output, thinking, and cache telemetry", () => {
    expect(providerCapability("deepseek", "deepseek-v4-pro")).toMatchObject({
      resolved_model: "deepseek-v4-pro",
      context_window: 1_000_000,
      max_output: 262_144,
      thinking_supported: true,
      cache_telemetry_supported: true,
    });
  });

  it("normalizes legacy aliases and provider-specific model ids", () => {
    expect(providerCapability("nvidia-nim", "deepseek-chat")).toMatchObject({
      resolved_model: "deepseek-ai/deepseek-v4-flash",
      deprecation: expect.objectContaining({ alias: "deepseek-chat" }),
    });
  });

  it("extracts prompt cache telemetry from common response shapes", () => {
    expect(extractCachedInputTokens({ prompt_cache_hit_tokens: 12 })).toBe(12);
    expect(extractCachedInputTokens({ prompt_tokens_details: { cached_tokens: 7 } })).toBe(7);
  });
});

async function* streamFrom(chunks: any[]) {
  for (const chunk of chunks) yield chunk;
}

async function collect(iterable: AsyncIterable<any>): Promise<any[]> {
  const events: any[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}
