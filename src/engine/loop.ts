/** Core ReAct conversation loop. */

import type { Config } from "../config.js";
import type { DeepSeekClient } from "../client/deepseek.js";
import type { StreamEvent, ContentDelta, ThinkingDelta, ToolCallBegin, ToolCallArgsDelta, StreamDone, UsageTelemetry } from "../client/base.js";
import type { BaseMode, UICallbacks } from "../modes/base.js";
import type { ConversationHistory } from "../session/history.js";
import type { Message, Session, ToolCall, ToolResult } from "../session/types.js";
import { getToolUseRuntimeMetadata, validateToolInput, type ApprovalContext, type ToolDef } from "../tools/base.js";
import { ToolRegistry } from "../tools/registry.js";
import { CapacityController } from "./capacity.js";
import { LayeredContextManager } from "./context-manager.js";
import { checkSandboxPolicy } from "../tools/sandbox.js";
import { runAutoDiagnostics } from "../tools/diagnostics.js";
import { fireHooks } from "./hooks.js";
import { applyToolResultBudget } from "./tool-result-budget.js";
import { emitRuntimeEvent } from "./events.js";
import { ImmutablePrefix, PrefixManager, stripPinnedPrefixMessages } from "./prefix.js";
import { estimateMessagesTokens, projectMessagesForRequest } from "./compact.js";
import { getMode } from "../modes/base.js";

export type { UICallbacks };

export interface TurnResult {
  duration_s: number;
  tool_calls: ToolCall[];
  tool_results: ToolResult[];
  iterations: number;
  usage: UsageTelemetry | null;
  artifact_ids: string[];
}

export interface RunTurnOptions {
  signal?: AbortSignal;
  ephemeralInstructions?: string;
}

export class Engine {
  config: Config;
  session: Session;
  history: ConversationHistory;
  client: DeepSeekClient;
  tools: ToolRegistry;
  readonly prefixManager: PrefixManager;
  interrupted = false;
  private capacity: CapacityController;
  private contextManager: LayeredContextManager;

  constructor(
    config: Config, session: Session, history: ConversationHistory,
    client: DeepSeekClient, tools: ToolRegistry, prefix?: ImmutablePrefix,
  ) {
    this.config = config;
    this.session = session;
    this.history = history;
    this.client = client;
    this.tools = tools;
    this.prefixManager = new PrefixManager(prefix ?? new ImmutablePrefix({
      systemPrompt: firstPlainSystemMessage(history.getMessages())?.content || "",
      toolSchemas: tools.toOpenAISchemas({ activeOnly: false }),
    }));
    this.capacity = new CapacityController();
    this.contextManager = new LayeredContextManager(config);
  }

  get prefix(): ImmutablePrefix {
    return this.prefixManager.prefix;
  }

  set prefix(prefix: ImmutablePrefix) {
    this.prefixManager.replace(prefix);
  }

  interrupt(): void { this.interrupted = true; }

  async runTurn(
    userInput: string, mode: BaseMode, callbacks?: UICallbacks, options: RunTurnOptions = {},
  ): Promise<TurnResult> {
    this.interrupted = false;
    const onAbort = () => { this.interrupted = true; };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const start = Date.now();
    const turnToolCalls: ToolCall[] = [];
    const turnToolResults: ToolResult[] = [];
    const turnArtifactIds = new Set<string>();
    let ephemeralMessage: Message | null = null;

    try {
      const activeMode = resolveActiveMode(this.config, this.session, mode);
      if (options.ephemeralInstructions?.trim()) {
        ephemeralMessage = {
          role: "system",
          content: options.ephemeralInstructions,
          tool_calls: null,
          tool_call_id: null,
          name: null,
          reasoning_content: null,
        };
        this.session.messages.push(ephemeralMessage);
      }
      this.history.addUser(userInput);
      await emitRuntimeEvent(callbacks, { type: "user_message", data: { text: userInput } });
      const autoActivatedTools = this.tools.activateForContext(userInput);
      if (autoActivatedTools.length) {
        await emitRuntimeEvent(callbacks, { type: "tool_catalog_auto_activate", data: { tools: autoActivatedTools, source: "user_input" } });
      }
      await emitRuntimeEvent(callbacks, { type: "prefix_pinned", data: this.prefix.metadata });
      const schemas = this.prefix.toolSchemas();
      const allowedToolNames = new Set(activeMode.filterTools(this.tools.listActive()).map(tool => tool.name));

      let iterations = 0;
      let lastUsage: UsageTelemetry | null = null;
      let totalUsage: UsageTelemetry | null = null;
      const respondedToolCallIds = new Set<string>();
      const recordToolResult = (result: ToolResult) => {
        this.history.addToolResult(result);
        respondedToolCallIds.add(result.tool_call_id);
      };
      const interruptedToolResult = (tc: ToolCall, reason: string): ToolResult => ({
        tool_call_id: tc.id,
        name: tc.name || "tool",
        content: `Error: interrupted before tool '${tc.name || "tool"}' completed (${reason}).`,
        is_error: true,
      });
      const addInterruptedToolResults = async (toolCalls: ToolCall[], reason: string) => {
        for (const tc of toolCalls) {
          if (respondedToolCallIds.has(tc.id)) continue;
          const tr = interruptedToolResult(tc, reason);
          recordToolResult(tr);
          turnToolCalls.push(tc);
          turnToolResults.push(tr);
          await emitRuntimeEvent(callbacks, { type: "tool_result", data: tr, preview: tr.content });
        }
      };

      while (iterations < this.config.max_turns) {
        if (this.interrupted) break;
        iterations++;
        const approvalPolicy = effectiveApprovalPolicy(this.config, activeMode);

        const projectedTokens = this.requestTokenCount();
        const capacityDecision = this.capacity.observe(projectedTokens, this.config.context_limit);
        const intervention = this.contextManager.apply(this.history, capacityDecision, this.session.workspace_path);
        if (intervention) {
          await emitRuntimeEvent(callbacks, { type: "context_intervention", data: intervention });
          if (intervention.compaction?.prefix_invalidated) {
            await emitRuntimeEvent(callbacks, {
              type: "prefix_invalidated",
              data: {
                reason: intervention.compaction.prefix_invalidation_reason || "context_compaction",
                boundary_id: intervention.compaction.boundary_id,
                compaction: {
                  actions: intervention.compaction.actions,
                  finalTokens: intervention.compaction.finalTokens,
                  original_tokens: intervention.compaction.original_tokens,
                  removed_messages: intervention.compaction.removed_messages,
                  preserved_messages: intervention.compaction.preserved_messages,
                  summary_message_name: intervention.compaction.summary_message_name,
                },
              },
            });
          }
        }

        await emitRuntimeEvent(callbacks, {
          type: "api_call_start",
          data: { prefix_hash: this.prefix.hash, tool_schema_count: schemas.length },
        });
        const response = await this.callApi(schemas, callbacks, options.signal);
        lastUsage = response.usage;
        totalUsage = mergeUsage(totalUsage, response.usage);

        const assistantMessage = this.history.addAssistant(response.content, response.tool_calls, response.reasoning_content);
        await emitRuntimeEvent(callbacks, { type: "assistant_message", data: assistantMessage });

        if (!response.tool_calls.length) break;

        for (const tc of response.tool_calls) {
          if (this.interrupted) break;
          if (turnToolCalls.length >= this.config.tool_call_budget_per_turn) {
            const err = `Error: tool call budget exceeded for this turn (${this.config.tool_call_budget_per_turn}).`;
            const tr: ToolResult = { tool_call_id: tc.id, name: tc.name, content: err, is_error: true };
            recordToolResult(tr);
            turnToolCalls.push(tc);
            turnToolResults.push(tr);
            await emitRuntimeEvent(callbacks, { type: "tool_budget_exceeded", data: { tool: tc.name, budget: this.config.tool_call_budget_per_turn } });
            await emitRuntimeEvent(callbacks, { type: "tool_result", data: tr, preview: err.slice(0, 200) });
            this.interrupted = true;
            break;
          }
          const toolDef = this.tools.lookup(tc.name);
          await emitRuntimeEvent(callbacks, {
            type: "tool_call",
            data: toolDef
              ? { ...tc, metadata: getToolUseRuntimeMetadata(toolDef, tc.arguments as Record<string, unknown>) }
              : tc,
          });
          if (!toolDef) {
            const err = `Error: Unknown tool '${tc.name}'`;
            const tr: ToolResult = {
              tool_call_id: tc.id, name: tc.name, content: err, is_error: true,
            };
            recordToolResult(tr);
            turnToolCalls.push(tc);
            turnToolResults.push(tr);
            await emitRuntimeEvent(callbacks, { type: "tool_result", data: tr, preview: err.slice(0, 200) });
            continue;
          }
          if (!this.prefix.hasTool(tc.name) || !allowedToolNames.has(tc.name)) {
            const err = `Tool '${tc.name}' is not active in the current mode or prefix. Enable it explicitly if needed.`;
            const tr: ToolResult = {
              tool_call_id: tc.id, name: tc.name, content: err, is_error: true,
            };
            recordToolResult(tr);
            turnToolCalls.push(tc);
            turnToolResults.push(tr);
            await emitRuntimeEvent(callbacks, { type: "tool_result", data: tr, preview: err.slice(0, 200) });
            continue;
          }

          try {
            let resultContent: string;
            const pushToolError = async (content: string): Promise<void> => {
              const tr: ToolResult = {
                tool_call_id: tc.id,
                name: tc.name,
                content,
                is_error: true,
              };
              recordToolResult(tr);
              turnToolResults.push(tr);
              turnToolCalls.push(tc);
              await emitRuntimeEvent(callbacks, { type: "tool_result", data: tr, preview: content.slice(0, 200) });
            };
            const normalizeArgs = async (nextArgs: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
              const validation = await validateToolInput(toolDef, nextArgs, {
                tool_name: tc.name,
                workspace_path: this.session.workspace_path,
              });
              if (!validation.ok) {
                const err = `Error: invalid input for tool '${tc.name}': ${validation.message || "validation failed"}`;
                await pushToolError(err);
                return null;
              }
              return withWorkspaceDefaults(toolDef, validation.args ?? nextArgs, this.session.workspace_path);
            };
            const authorizeArgs = async (nextArgs: Record<string, unknown>): Promise<boolean> => {
              const nextCtx: ApprovalContext = {
                tool_name: tc.name,
                tool_args: nextArgs,
                tool_def: toolDef,
                workspace_path: this.session.workspace_path,
              };
              const approvalArgs = publicToolArgs(nextArgs);
              const approvalCtx: ApprovalContext = {
                ...nextCtx,
                tool_args: approvalArgs,
              };
              const nextSandbox = checkSandboxPolicy(this.config, nextCtx);
              if (nextSandbox.decision === "deny") {
                await emitRuntimeEvent(callbacks, { type: "approval_audit", data: { tool: tc.name, decision: "deny", reason: nextSandbox.reason } });
                await pushToolError(`Tool '${tc.name}' was denied by sandbox: ${nextSandbox.reason}.`);
                return false;
              }

              let approvedAfterMutation: boolean;
              if (nextSandbox.decision === "ask" && approvalPolicy === "never") {
                approvedAfterMutation = true;
              } else if (nextSandbox.decision === "ask") {
                approvedAfterMutation = await callbacks?.requestApproval?.(
                  tc.name,
                  approvalArgs,
                  `Sandbox approval required: ${nextSandbox.reason}\n\nArguments: ${JSON.stringify(approvalArgs)}`,
                ) ?? false;
              } else {
                approvedAfterMutation = nextSandbox.decision === "allow" && approvalPolicy === "never"
                  ? true
                  : await activeMode.checkPermission(approvalCtx, callbacks);
              }
              await emitRuntimeEvent(callbacks, {
                type: "approval_audit",
                data: { tool: tc.name, decision: approvedAfterMutation ? "allow" : "deny", reason: nextSandbox.reason },
              });
              if (!approvedAfterMutation) {
                await pushToolError(`Tool '${tc.name}' was denied.`);
                return false;
              }
              return true;
            };
            let args = withWorkspaceDefaults(toolDef, tc.arguments as Record<string, unknown>, this.session.workspace_path);
            const normalizedArgs = await normalizeArgs(args);
            if (!normalizedArgs) continue;
            args = normalizedArgs;
            const preHook = await fireHooks("PreToolUse", {
              tool_name: tc.name,
              tool_input: args,
              session_id: this.session.id,
              cwd: this.session.workspace_path,
            });
            await emitRuntimeEvent(callbacks, { type: "hook", data: { event: "PreToolUse", tool: tc.name, ...preHook } });
            if (preHook.decision === "deny") {
              const deny = `Tool '${tc.name}' was denied by hook: ${preHook.message || "no reason provided"}.`;
              const tr: ToolResult = {
                tool_call_id: tc.id, name: tc.name, content: deny, is_error: true,
              };
              recordToolResult(tr);
              turnToolResults.push(tr);
              turnToolCalls.push(tc);
              await emitRuntimeEvent(callbacks, { type: "tool_result", data: tr, preview: deny.slice(0, 200) });
              continue;
            }
            if (preHook.modified_input) {
              args = withWorkspaceDefaults(toolDef, { ...args, ...preHook.modified_input }, this.session.workspace_path);
              const revalidatedArgs = await normalizeArgs(args);
              if (!revalidatedArgs) continue;
              args = revalidatedArgs;
            }
            if (!(await authorizeArgs(args))) continue;
            // Map argument names (Python snake_case → JS camelCase already handled by Zod/JSON parsing)
            const toolStart = Date.now();
            resultContent = await toolDef.execute(args, {
              signal: options.signal,
              toolCallId: tc.id,
              sessionId: this.session.id,
              workspacePath: this.session.workspace_path,
              onProgress: async (progress) => {
                const rendered = toolDef.renderProgress?.(progress, args);
                await emitRuntimeEvent(callbacks, {
                  type: "tool_progress",
                  data: { tool: tc.name, tool_call_id: tc.id, progress },
                  rendered,
                });
              },
            });
            let isError = resultContent.startsWith("Error:");
            if (!isError) {
              const diagnostics = await this.maybeRunPostEditDiagnostics(tc.name, args);
              if (diagnostics) resultContent = `${resultContent}\n\n[post-edit diagnostics]\n${diagnostics}`;
              isError = resultContent.startsWith("Error:");
            }

            const originalArtifactIds = extractArtifactIds(resultContent);
            const budgeted = applyToolResultBudget({
              toolName: tc.name,
              toolCallId: tc.id,
              content: resultContent,
              isError,
              sessionId: this.session.id,
              maxChars: toolDef.maxResultSizeChars,
            });
            const artifactIds = [...new Set([...originalArtifactIds, ...budgeted.artifactIds])];
            const tr: ToolResult = {
              tool_call_id: tc.id, name: tc.name, content: budgeted.content, is_error: isError,
            };
            const rendered = toolDef.renderResult?.(budgeted.replaced ? budgeted.content : resultContent, args);
            const metadata = getToolUseRuntimeMetadata(toolDef, args, budgeted.replaced ? budgeted.content : resultContent);
            recordToolResult(tr);
            turnToolResults.push(tr);
            turnToolCalls.push(tc);
            const stats = this.tools.recordCall(tc.name, !isError, Date.now() - toolStart);
            const degraded = isError ? this.tools.degradeIfUnhealthy(tc.name, this.config.tool_failure_degrade_threshold) : null;
            await emitRuntimeEvent(callbacks, { type: "tool_stats", data: { stats, degraded } });
            await emitRuntimeEvent(callbacks, {
              type: "tool_result",
              data: tr,
              artifact_ids: artifactIds,
              preview: rendered?.preview ?? (budgeted.replaced ? budgeted.content : resultContent),
              rendered,
              metadata,
            });
            for (const id of artifactIds) turnArtifactIds.add(id);
            const postHook = await fireHooks("PostToolUse", {
              tool_name: tc.name,
              tool_input: args,
              tool_result: resultContent,
              session_id: this.session.id,
              cwd: this.session.workspace_path,
            });
            await emitRuntimeEvent(callbacks, { type: "hook", data: { event: "PostToolUse", tool: tc.name, ...postHook } });
          } catch (e: any) {
            if (this.interrupted || options.signal?.aborted || isAbortLikeError(e)) {
              this.interrupted = true;
              const reason = options.signal?.aborted ? "abort requested" : "interrupt requested";
              const tr = interruptedToolResult(tc, reason);
              recordToolResult(tr);
              turnToolResults.push(tr);
              turnToolCalls.push(tc);
              await emitRuntimeEvent(callbacks, { type: "tool_result", data: tr, preview: tr.content });
              break;
            }
            const err = `Error executing ${tc.name}: ${e.message}`;
            const tr: ToolResult = {
              tool_call_id: tc.id, name: tc.name, content: err, is_error: true,
            };
            recordToolResult(tr);
            turnToolResults.push(tr);
            turnToolCalls.push(tc);
            const stats = this.tools.recordCall(tc.name, false, 0);
            const degraded = this.tools.degradeIfUnhealthy(tc.name, this.config.tool_failure_degrade_threshold);
            await emitRuntimeEvent(callbacks, { type: "tool_stats", data: { stats, degraded } });
            await emitRuntimeEvent(callbacks, { type: "tool_result", data: tr, preview: err.slice(0, 200) });
          }
        }
        if (this.interrupted) {
          await addInterruptedToolResults(response.tool_calls, options.signal?.aborted ? "abort requested" : "interrupt requested");
          break;
        }
      }

      return {
        duration_s: (Date.now() - start) / 1000,
        tool_calls: turnToolCalls,
        tool_results: turnToolResults,
        iterations,
        usage: totalUsage || lastUsage,
        artifact_ids: [...turnArtifactIds],
      };
    } finally {
      if (ephemeralMessage) {
        const index = this.session.messages.indexOf(ephemeralMessage);
        if (index >= 0) this.session.messages.splice(index, 1);
      }
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  private async callApi(
    schemas: Record<string, unknown>[],
    callbacks?: UICallbacks,
    signal?: AbortSignal,
  ): Promise<{ content: string; reasoning_content: string | null; tool_calls: ToolCall[]; finish_reason: string; usage: UsageTelemetry | null }> {
    let content = "";
    let reasoning = "";
    const toolCalls: ToolCall[] = [];
    let finishReason = "stop";
    let usage: UsageTelemetry | null = null;

    for await (const event of this.client.send(
      this.requestMessages(), schemas.length ? schemas : null,
      { stream: true, reasoning_effort: this.config.reasoning_effort, max_tokens: this.config.max_tokens, signal },
    )) {
      if (this.interrupted) break;

      switch (event.type) {
        case "thinking":
          reasoning += (event as ThinkingDelta).text;
          await emitRuntimeEvent(callbacks, { type: "thinking_delta", data: { text: (event as ThinkingDelta).text } });
          break;
        case "content":
          content += (event as ContentDelta).text;
          await emitRuntimeEvent(callbacks, { type: "content_delta", data: { text: (event as ContentDelta).text } });
          break;
        case "tool_call_begin":
          await emitRuntimeEvent(callbacks, {
            type: "tool_call_begin",
            data: {
              name: (event as ToolCallBegin).name,
              tool_call_id: (event as ToolCallBegin).tool_call_id,
              index: (event as ToolCallBegin).index,
            },
          });
          break;
        case "tool_call_args":
          await emitRuntimeEvent(callbacks, {
            type: "tool_call_args",
            data: {
              tool_call_id: (event as ToolCallArgsDelta).tool_call_id,
              name: (event as ToolCallArgsDelta).name,
              index: (event as ToolCallArgsDelta).index,
              arguments: (event as ToolCallArgsDelta).arguments,
            },
          });
          break;
        case "done": {
          const done = event as StreamDone;
          finishReason = done.finish_reason;
          usage = done.usage;
          if (done.reasoning_content && !reasoning) reasoning = done.reasoning_content;
          if (done.content && !content) content = done.content;
          for (const tc of done.tool_calls) {
            toolCalls.push(tc);
          }
          break;
        }
      }
    }

    return { content, reasoning_content: reasoning || null, tool_calls: toolCalls, finish_reason: finishReason, usage };
  }

  private requestMessages(): Message[] {
    const sessionMessages = projectMessagesForRequest(this.history.getMessages());
    return [
      ...this.prefix.toMessages(),
      ...stripPinnedPrefixMessages(sessionMessages, this.prefix),
    ];
  }

  requestTokenCount(): number {
    return estimateMessagesTokens(this.requestMessages());
  }

  private async maybeRunPostEditDiagnostics(toolName: string, args: Record<string, unknown>): Promise<string | null> {
    if (!this.config.lsp_auto_diagnostics) return null;
    if (!["write", "edit", "apply_patch"].includes(toolName)) return null;
    const files = changedFilesForTool(toolName, args);
    try {
      return await runAutoDiagnostics({
        workdir: this.session.workspace_path,
        files,
        minSeverity: this.config.lsp_diagnostics_severity,
      });
    } catch (e: any) {
      return `Diagnostics failed: ${e.message}`;
    }
  }
}

function firstPlainSystemMessage(messages: Message[]): Message | null {
  return messages.find(message => message.role === "system" && message.name == null) ?? null;
}

function extractArtifactIds(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(/\b[a-zA-Z][a-zA-Z0-9._-]*_[a-z0-9]{6,}_[a-f0-9]{8,}\b/g)) {
    ids.add(match[0]);
  }
  try {
    const parsed = JSON.parse(text);
    collectArtifactIds(parsed, ids);
  } catch {
    // non-JSON tool output
  }
  return [...ids];
}

function mergeUsage(
  total: UsageTelemetry | null,
  next: UsageTelemetry | null,
): UsageTelemetry | null {
  if (!next) return total;
  const merged: Record<string, unknown> = { ...(total || {}) };
  for (const [key, value] of Object.entries(next)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      merged[key] = (typeof merged[key] === "number" ? merged[key] : 0) + value;
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      merged[key] = mergeUsage(
        isUsageRecord(merged[key]) ? merged[key] : null,
        value as UsageTelemetry,
      );
    }
  }
  return merged;
}

function isUsageRecord(value: unknown): value is UsageTelemetry {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function effectiveApprovalPolicy(config: Config, mode: BaseMode): Config["approval_policy"] {
  return mode.name === "yolo" ? "never" : config.approval_policy;
}

function resolveActiveMode(config: Config, session: Session, requestedMode: BaseMode): BaseMode {
  if (requestedMode.name === "yolo" && config.mode !== "plan" && session.mode !== "plan") {
    return requestedMode;
  }
  return session.mode && session.mode !== requestedMode.name
    ? getMode(session.mode)
    : requestedMode;
}

function isAbortLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || /aborted|abort/i.test(error.message);
}

function withWorkspaceDefaults(toolDef: ToolDef, args: Record<string, unknown>, workspacePath: string): Record<string, unknown> {
  const next = { ...args, __workspace_path: workspacePath };
  if (toolDef.name === "apply_patch") {
    const hasPatchRootAlias = [next.workdir, next.cwd, next.root].some(value => typeof value === "string" && value.trim());
    if (!hasPatchRootAlias) next.workdir = workspacePath;
    return next;
  }
  const properties = toolSchemaProperties(toolDef);
  if ("root" in properties) {
    const hasFileRootAlias = [next.root, next.workspace, next.cwd].some(value => typeof value === "string" && value.trim());
    if (!hasFileRootAlias) next.root = workspacePath;
    return next;
  }
  if ("workdir" in properties) {
    if ((typeof next.workdir !== "string" || !next.workdir.trim()) && typeof next.cwd === "string" && next.cwd.trim()) {
      next.workdir = next.cwd;
    }
    if (typeof next.workdir !== "string" || !next.workdir.trim()) {
      next.workdir = workspacePath;
    }
  }
  return next;
}

function publicToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([key]) => !key.startsWith("__")));
}

function toolSchemaProperties(toolDef: ToolDef): Record<string, unknown> {
  const properties = toolDef.parameters?.properties;
  return properties && typeof properties === "object" && !Array.isArray(properties)
    ? properties as Record<string, unknown>
    : {};
}

function collectArtifactIds(value: unknown, ids: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectArtifactIds(item, ids);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if ((key === "artifact_id" || key === "artifactId") && typeof child === "string") ids.add(child);
    else collectArtifactIds(child, ids);
  }
}

function changedFilesForTool(toolName: string, args: Record<string, unknown>): string[] {
  if ((toolName === "write" || toolName === "edit") && typeof args.path === "string") return [args.path];
  if (toolName === "apply_patch") {
    if (typeof args.target_file === "string" && args.target_file) return [args.target_file];
    if (typeof args.patch === "string") return extractPatchFiles(args.patch);
  }
  return [];
}

function extractPatchFiles(patch: string): string[] {
  const files = new Set<string>();
  for (const line of patch.split("\n")) {
    if (!line.startsWith("+++ ")) continue;
    const raw = line.slice(4).trim();
    if (!raw || raw === "/dev/null") continue;
    files.add(raw.replace(/^b\//, ""));
  }
  return [...files];
}
