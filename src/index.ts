#!/usr/bin/env node
/** Seek Code — a terminal-native coding agent powered by DeepSeek. */

import { Command } from "commander";
import {
  commandCompletionProvider,
  InputController,
  readInput,
  restoreTTYInput,
  type ScrollDirection,
} from "./ui/input.js";
import { movePickerIndex, pickerActionForSequence, pickerWindow, type PickItem } from "./ui/picker.js";
import { basename, resolve } from "node:path";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import * as r from "./ui/renderer.js";
import { p } from "./ui/palette.js";
import * as screen from "./tui/screen.js";
import { TuiLayout } from "./tui/layout.js";
import { shouldUseAlternateScreen } from "./tui/alternate-screen.js";
import { Transcript } from "./tui/transcript.js";
import { TuiRuntimeViewModel } from "./tui/runtime-view-model.js";
import { approvalModalLines, pickerModalLines, type TuiModalKind, type TuiModalState } from "./tui/modal.js";

import { explainConfig, loadConfig, migrateProjectConfig, migrateUserConfig, userConfigPath, validateConfig, writeUserApiKey, type Config } from "./config.js";
import { DeepSeekClient } from "./client/deepseek.js";
import { getRegistry } from "./tools/registry.js";
import { getMode, nextModeName, type UICallbacks } from "./modes/base.js";
import { Engine } from "./engine/loop.js";
import { ConversationHistory } from "./session/history.js";
import { createSession } from "./session/types.js";
import { buildSystemPrompt, buildToolsDescription } from "./engine/context.js";
import { CapacityController, formatCapacityDecision } from "./engine/capacity.js";
import { CostTracker } from "./cost/tracker.js";
import { saveSession, loadSession, listSessions, deleteSession } from "./session/store.js";
import { refreshSessionTitle } from "./session/title.js";
import { revertLastTurn, restoreWorkspace } from "./rollback/restore.js";
import { clearPlanState, formatTodoState } from "./tools/plan.js";
import { clearGoalState } from "./tools/goal.js";
import { clearAgentState } from "./tools/sub-agent.js";
import { getApprovalCache, clearApprovalCache, DenialReason } from "./tools/approval-cache.js";
import { getTaskManager, clearTaskManager } from "./engine/task-lifecycle.js";
import {
  activateSkill,
  injectSkills,
  installSkill,
  listRemoteSkills,
  listSkills,
  trustSkill,
  uninstallSkill,
  updateSkill,
} from "./engine/skills.js";
import { checkPermission, rememberAlwaysAllow, rememberAlwaysDeny, clearAll as clearPermissions, getAllRules, getSessionMemory } from "./tools/permission-ruleset.js";

// Register all tools
import { registerFileTools } from "./tools/file-ops.js";
import { registerShellTool } from "./tools/shell.js";
import { registerGitTools } from "./tools/git.js";
import { registerWebTools } from "./tools/web.js";
import { registerPatchTool } from "./tools/patch.js";
import { registerThinkTool } from "./tools/think.js";
import { registerRLMTool } from "./tools/rlm-query.js";
import { registerSubAgentTool } from "./tools/sub-agent.js";
import { registerPlanTools } from "./tools/plan.js";
import { registerGoalTools } from "./tools/goal.js";
import { registerToolSearchTool } from "./tools/tool-search.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerDiagnosticsTools } from "./tools/diagnostics.js";
import { registerArtifactTools } from "./tools/artifacts.js";
import { formatJob, getJobManager } from "./tools/jobs.js";
import { injectAgentsMd } from "./engine/agents-md.js";
import { defaultBaseUrlForProvider, extractCachedInputTokens, parseProvider, providerCapability, type ApiProvider } from "./client/capabilities.js";
import { addMCPServer, getMCPManager, reloadMCPManager, removeMCPServer, setMCPServerEnabled } from "./mcp/manager.js";
import { linkArtifact } from "./artifacts/store.js";
import { VERSION } from "./version.js";
import { assertMinimumVersion, maybePromptForUpdate, runUpdateCommand } from "./update-check.js";

function parseOptionalInt(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted|abort/i.test(error.message));
}

const LIVE_READONLY_COMMANDS = new Set([
  "/tasks",
  "/jobs",
  "/tokens",
  "/cost",
  "/permissions",
  "/sessions",
  "/version",
  "/help",
]);

function isLiveReadonlyCommand(input: string): boolean {
  if (!input.startsWith("/")) return false;
  return LIVE_READONLY_COMMANDS.has(input.trim().split(/\s+/)[0].toLowerCase());
}

function setupTools(cfg?: ReturnType<typeof loadConfig>) {
  const reg = getRegistry();
  reg.clear();
  registerFileTools();
  registerShellTool();
  registerGitTools();
  registerWebTools(cfg?.web);
  registerPatchTool();
  registerThinkTool();
  registerRLMTool();
  registerSubAgentTool();
  registerPlanTools();
  registerGoalTools();
  registerToolSearchTool();
  registerTaskTools();
  registerArtifactTools();
  registerDiagnosticsTools();
}

async function ensureRuntimeApiKey(cfg: Config, cliOverrides: Record<string, unknown>): Promise<Config> {
  if (cfg.api_key) return cfg;
  const path = userConfigPath();
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`DEEPSEEK_API_KEY is required. Paste an API key from https://platform.deepseek.com into api_key in ${path}, or pass --api-key.`);
  }

  console.log(p.warning("DeepSeek API key is not configured."));
  console.log(`Get an API key from: ${p.blue("https://platform.deepseek.com")}`);
  console.log(`Config file: ${p.blue(path)}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("Paste API key to save it now, or press Enter to configure the file yourself: ")).trim();
    if (!answer) {
      throw new Error(`DEEPSEEK_API_KEY is required. Add api_key to ${path}, then run seek again.`);
    }
    writeUserApiKey(answer);
    console.log(p.success(`Saved API key to ${path}`));
    return loadConfig(cliOverrides);
  } finally {
    rl.close();
  }
}

async function runOneShot(cfg: ReturnType<typeof loadConfig>, prompt: string) {
  if (!cfg.api_key) throw new Error("DEEPSEEK_API_KEY is required. Set it in the environment, config file, or --api-key.");
  const client = new DeepSeekClient({ apiKey: cfg.api_key, baseUrl: cfg.base_url, model: cfg.model, provider: cfg.provider });
  const messages = [{ role: "user" as const, content: prompt, tool_calls: null, tool_call_id: null, name: null, reasoning_content: null }];

  process.stdout.write("\n");
  let wasThinking = false;
  for await (const event of client.send(messages, null, { stream: true, reasoning_effort: cfg.reasoning_effort, max_tokens: cfg.max_tokens })) {
    switch (event.type) {
      case "thinking":
        if (cfg.reasoning_effort === "off" || !cfg.thinking_visible) break;
        wasThinking = true;
        process.stdout.write(`\x1b[90m${(event as any).text}\x1b[0m`);
        break;
      case "content":
        if (wasThinking) { process.stdout.write("\n\n"); wasThinking = false; }
        process.stdout.write((event as any).text);
        break;
      case "done":
        process.stdout.write("\n");
        const usage = (event as any).usage;
        if (usage) console.log(`\n--- Tokens: ${usage.prompt_tokens ?? 0} in / ${usage.completion_tokens ?? 0} out ---`);
        break;
    }
  }
}

async function runInteractive(cfg: ReturnType<typeof loadConfig>) {
  if (!cfg.api_key) throw new Error("DEEPSEEK_API_KEY is required. Set it in the environment, config file, or --api-key.");
  setupTools(cfg);
  await reloadMCPManager(cfg).catch(() => undefined);
  const tools = getRegistry();
  let modeObj = getMode(cfg.mode);
  const costTracker = new CostTracker(cfg.model);
  const capacity = new CapacityController();

  const session = createSession({ mode: cfg.mode, model: cfg.model, workspace_path: resolve(".") });
  const history = new ConversationHistory(session);
  let client = new DeepSeekClient({ apiKey: cfg.api_key, baseUrl: cfg.base_url, model: cfg.model, provider: cfg.provider });

  const toolDesc = buildToolsDescription(tools.listAll());
  let sysPrompt = buildSystemPrompt(cfg, session.workspace_path, toolDesc);
  sysPrompt = injectAgentsMd(sysPrompt, resolve("."));
  sysPrompt = injectSkills(sysPrompt, resolve("."), cfg.skills_dir);
  history.addSystem(sysPrompt);

  let engine = new Engine(cfg, session, history, client, tools);

  const initialRawMode = process.stdin.isRaw;
  const useAlternateScreen = shouldUseAlternateScreen(cfg.tui_alternate_screen);
  screen.setup({ alternateScreen: useAlternateScreen });
  const transcript = new Transcript();
  const layout = new TuiLayout(transcript, useAlternateScreen ? "fullscreen" : "inline");

  let turnCount = 0;
  let engineRunning = false;
  let activeAbortController: AbortController | null = null;
  let activeTurnToken = 0;
  let activeTurnStartedAt = 0;
  let lastTurnDurationMs = 0;
  let lastCacheTokens = 0;
  let exitSummary: string | null = null;
  let activeSkillInstruction: string | null = null;
  let promptState = { value: "", cursor: 0, completions: [] as string[] };
  const queuedInputs: string[] = [];
  let runtimeView: TuiRuntimeViewModel | null = null;
  let liveInputController: InputController | null = null;
  let liveInputStop: (() => void) | null = null;
  let pendingRenderTimer: NodeJS.Timeout | null = null;
  let pendingRenderArgs: typeof promptState | null = null;
  let resizeRenderTimer: NodeJS.Timeout | null = null;
  let activeModal: TuiModalState | null = null;

  const setModal = (modal: typeof activeModal) => {
    activeModal = modal;
    requestImmediateRender();
  };

  const clearModal = () => {
    if (!activeModal) return;
    activeModal = null;
    requestImmediateRender();
  };

  const appendUiOutput = (message: unknown, isError = false) => {
    const text = typeof message === "string" ? message : JSON.stringify(message, null, 2);
    transcript.append(isError ? p.error(text) : text);
    transcript.scrollToBottom();
    requestImmediateRender();
  };

  const renderScreen = (input = promptState.value, cursor = promptState.cursor, completions = promptState.completions) => {
    if (pendingRenderTimer) {
      clearTimeout(pendingRenderTimer);
      pendingRenderTimer = null;
      pendingRenderArgs = null;
    }
    promptState = { value: input, cursor, completions };
    const modalLines = activeModal?.lines;
    layout.render({
      footer: footerPrompt(),
      prompt: r.promptSymbol(cfg.mode),
      statusLine: runtimeView?.activeStatusLine || undefined,
      input: modalLines ? "" : input,
      cursor: modalLines ? 0 : cursor,
      completions: modalLines ?? completions,
      completionLimit: modalLines?.length,
      freezeHistory: false,
    });
  };
  const requestRender = (input = promptState.value, cursor = promptState.cursor, completions = promptState.completions) => {
    pendingRenderArgs = { value: input, cursor, completions };
    if (pendingRenderTimer) return;
    pendingRenderTimer = setTimeout(() => {
      pendingRenderTimer = null;
      const args = pendingRenderArgs || promptState;
      pendingRenderArgs = null;
      renderScreen(args.value, args.cursor, args.completions);
    }, 33);
  };
  const requestImmediateRender = () => {
    if (pendingRenderTimer) {
      clearTimeout(pendingRenderTimer);
      pendingRenderTimer = null;
      pendingRenderArgs = null;
    }
    renderScreen();
  };

  const scrollTranscript = (direction: ScrollDirection, amount: number) => {
    const size = screen.termSize();
    const visibleRows = layout.visibleTranscriptRows({
      footer: footerPrompt(),
      prompt: r.promptSymbol(cfg.mode),
      statusLine: runtimeView?.activeStatusLine || undefined,
      input: promptState.value,
      completions: promptState.completions,
    }, size.rows, size.cols);
    const page = Math.max(1, visibleRows - 1);
    if (direction === "up") transcript.scrollUp(Number.isFinite(amount) ? amount : page);
    else if (direction === "down") transcript.scrollDown(Number.isFinite(amount) ? amount : page);
    else if (direction === "top") transcript.scrollToTop();
    else transcript.scrollToBottom();
    renderScreen();
  };

  runtimeView = new TuiRuntimeViewModel(transcript, {
    thinkingVisible: () => cfg.thinking_visible,
    turnStartedAt: () => activeTurnStartedAt,
    renderNow: requestImmediateRender,
    requestRender,
  });

  const runLiveCommand = async (input: string) => {
    const changed = await handleSlashCommand(input, cfg, session, history, costTracker, {
      renderPicker,
      clearModal,
      write: appendUiOutput,
      applyLoadedSession,
      rebuildRuntime,
      rebuildSystemPrompt,
      renderLoadedSession: () => renderSessionTranscript(true),
      setExitSummary: (message) => { exitSummary = message; },
      setActiveSkill: (instruction) => { activeSkillInstruction = instruction; },
      liveReadonly: true,
    });
    if (changed === true) modeObj = getMode(cfg.mode);
  };

  const abortActiveTurn = () => {
    if (!engineRunning) return;
    activeAbortController?.abort();
    engine.interrupt();
    transcript.append(r.interruptedMsg());
    requestImmediateRender();
  };

  const submitLiveInput = (rawInput: string) => {
    const input = rawInput.trim();
    if (!input) return;
    transcript.append(`\n${p.blue("›")} ${p.text(input)}`);
    transcript.scrollToBottom();
    if (isLiveReadonlyCommand(input)) {
      void runLiveCommand(input).catch((e: any) => {
        transcript.append(p.error(`\nError: ${e.message}\n`));
        requestImmediateRender();
      });
      return;
    }
    if (input.startsWith("/")) {
      const cmd = input.split(/\s+/)[0];
      transcript.append(p.warning(`  Command ${cmd} is not available while the agent is running. Use Esc to interrupt, or wait for the turn to finish.`));
      return;
    }
    queuedInputs.push(input);
    transcript.append(p.dim("  Queued for the next turn."));
  };

  liveInputController = new InputController({
    mode: "running",
    completionProvider: commandCompletionProvider,
    completionLimit: 8,
    clearOnSubmit: true,
    onRender: (state, meta) => {
      promptState = { value: state.value, cursor: state.cursor, completions: state.completions };
      if (meta.immediate) requestImmediateRender();
      else requestRender(state.value, state.cursor, state.completions);
    },
    onSubmit: (value) => {
      submitLiveInput(value);
      return true;
    },
    onInterrupt: () => {
      abortActiveTurn();
      return false;
    },
    onCtrlC: () => {
      abortActiveTurn();
      return false;
    },
    onModeCycle: () => {
      cfg.mode = nextModeName(cfg.mode);
      session.mode = cfg.mode;
      modeObj = getMode(cfg.mode);
      return r.promptSymbol(cfg.mode);
    },
    onScroll: scrollTranscript,
  });

  const onResize = () => {
    if (resizeRenderTimer) return;
    resizeRenderTimer = setTimeout(() => {
      resizeRenderTimer = null;
      requestImmediateRender();
    }, 16);
  };

  const startGlobalInput = () => {
    if (liveInputStop) return;
    liveInputController?.reset({ render: false });
    liveInputController?.setMode("running", false);
    liveInputStop = liveInputController?.attach({
      stdin: process.stdin,
      stdout: process.stdout,
      resizeTarget: process.stdout,
      onResize,
    }) ?? null;
  };

  const stopGlobalInput = () => {
    liveInputStop?.();
    liveInputStop = null;
    liveInputController?.reset({ render: false });
    if (resizeRenderTimer) {
      clearTimeout(resizeRenderTimer);
      resizeRenderTimer = null;
    }
  };

  const clearPrompt = () => renderScreen("", 0, []);

  const renderPicker = (idx: number, items: PickItem[], title: string, maxVisibleItems = 12, kind: TuiModalKind = "picker") => {
    setModal({ kind, lines: pickerModalLines(idx, items, title, maxVisibleItems) });
  };

  const footerItems = () => cfg.status_items.filter(item => !["cache", "cost", "tools", "hints"].includes(item));

  const footerPrompt = () =>
    r.footerConfigured(session.id, footerItems(), {
      mode: cfg.mode,
      model: cfg.model,
      workspace: session.workspace_path || resolve("."),
      tokens: session.cumulative_tokens_in + session.cumulative_tokens_out,
      contextLimit: cfg.context_limit,
      cacheTokens: lastCacheTokens,
      activeTools: runtimeView?.activeToolCount ?? 0,
      elapsedMs: engineRunning && activeTurnStartedAt ? Date.now() - activeTurnStartedAt : lastTurnDurationMs,
      cost: costTracker.totalCost,
    });

  const rebuildSystemPrompt = () => {
    const systemPrompt = injectSkills(
      injectAgentsMd(
        buildSystemPrompt(cfg, session.workspace_path, buildToolsDescription(tools.listAll())),
        session.workspace_path,
      ),
      session.workspace_path,
      cfg.skills_dir,
    );
    session.messages = [
      { role: "system", content: systemPrompt, tool_calls: null, tool_call_id: null, name: null, reasoning_content: null },
      ...session.messages.filter(message => message.role !== "system"),
    ];
  };

  const rebuildRuntime = () => {
    modeObj = getMode(cfg.mode);
    costTracker.model = cfg.model;
    client = new DeepSeekClient({ apiKey: cfg.api_key, baseUrl: cfg.base_url, model: cfg.model, provider: cfg.provider });
    engine = new Engine(cfg, session, history, client, tools);
  };

  const applyLoadedSession = (loaded: typeof session) => {
    Object.assign(session, loaded);
    if (session.workspace_path && existsSync(session.workspace_path)) {
      process.chdir(session.workspace_path);
    } else {
      session.workspace_path = resolve(".");
    }
    cfg.mode = loaded.mode as any;
    cfg.model = loaded.model;
    history.session = session;
    costTracker.hydrateFromSession(session);
    turnCount = session.turns.length || session.messages.filter(message => message.role === "user").length;
    rebuildSystemPrompt();
    rebuildRuntime();
  };

  const renderSessionTranscript = (loaded = false) => {
    layout.reset();
    runtimeView?.renderSessionTranscript({
      session,
      loaded,
      version: VERSION,
      model: cfg.model,
      mode: cfg.mode,
      toolCount: tools.size,
    });
  };
  renderSessionTranscript();

  const createUiCallbacks = (turnToken: number): UICallbacks => ({
    onRuntimeEvent(event) {
      if (turnToken !== activeTurnToken) return;
      if (activeAbortController?.signal.aborted) return;
      runtimeView?.handleRuntimeEvent(event);
    },
    async requestApproval(toolName, args, _description) {
      if (turnToken !== activeTurnToken || activeAbortController?.signal.aborted) return false;
      // Check permission ruleset first
      const permResult = checkPermission({
        toolName,
        toolArgs: args as Record<string, unknown>,
        patterns: Object.values(args as Record<string, unknown>).map(String),
      });
      if (permResult.action === "allow") return true;
      if (permResult.action === "deny") {
        transcript.append(p.dim(`  (auto-denied by policy: ${permResult.reason})`));
        renderScreen();
        return false;
      }

      // Check cache
      const cache = getApprovalCache();
      if (cache.isApproved(toolName, args as Record<string, unknown>)) return true;
      const denial = cache.isDenied(toolName, args as Record<string, unknown>);
      if (denial) {
        transcript.append(p.dim(`  (auto-denied: previously denied at ${new Date(denial.deniedAt).toLocaleTimeString()})`));
        renderScreen();
        return false;
      }

      const resumeLiveInput = !!liveInputStop;
      if (resumeLiveInput) stopGlobalInput();
      setModal({ kind: "approval", lines: approvalModalLines(toolName, (args || {}) as Record<string, unknown>) });
      return new Promise((resolve) => {
        let detachInput: (() => void) | null = null;
        let approvalInput: InputController | null = null;
        let settled = false;
        const abortSignal = activeAbortController?.signal;

        const finish = (decision: boolean, choice: "always" | "once" | "deny" | "abort"): true => {
          if (settled) return true;
          settled = true;
          detachInput?.();
          approvalInput?.dispose();
          abortSignal?.removeEventListener("abort", abortApproval);
          activeModal = null;

          if (turnToken !== activeTurnToken || activeAbortController?.signal.aborted) {
            renderScreen();
            resolve(false);
            return true;
          }

          if (choice === "always") {
            cache.rememberApproval(toolName, "always", args as Record<string, unknown>);
            rememberAlwaysAllow(toolName);
            transcript.append(p.success(`  Approved ${toolName} for this session.`));
          } else if (choice === "once") {
            cache.rememberApproval(toolName, "once", args as Record<string, unknown>);
            transcript.append(p.success(`  Approved ${toolName} once.`));
          } else if (choice === "deny") {
            cache.rememberDenial(toolName, DenialReason.USER_DENIED, args as Record<string, unknown>);
            rememberAlwaysDeny(toolName);
            transcript.append(p.warning(`  Denied ${toolName}.`));
          }

          renderScreen();
          if (resumeLiveInput && engineRunning) startGlobalInput();
          resolve(decision);
          return true;
        };
        const abortApproval = () => finish(false, "abort");
        if (abortSignal?.aborted) {
          abortApproval();
          return;
        }
        abortSignal?.addEventListener("abort", abortApproval, { once: true });

        approvalInput = new InputController({
          mode: "approval",
          editable: false,
          onUnhandledSequence: (sequence) => {
            const a = sequence.trim().toLowerCase();
            if (!a || a === "\r" || a === "\n") return false;
            if (a === "a" || a === "always") {
              return finish(true, "always");
            }
            if (a.startsWith("y")) return finish(true, "once");
            return finish(false, "deny");
          },
          onCtrlC: () => finish(false, "deny"),
          onInterrupt: () => finish(false, "deny"),
        });
        detachInput = approvalInput.attach({
          stdin: process.stdin,
          stdout: process.stdout,
          bracketedPaste: false,
        });
      });
    },
  });

  try {
    screen.enableBracketedPaste();
    renderScreen();

    while (true) {
      promptState = { value: "", cursor: 0, completions: [] };
      let input: string;
      if (queuedInputs.length) {
        input = queuedInputs.shift()!.trim();
        clearPrompt();
      } else {
        const result = await readInput(r.promptSymbol(cfg.mode), {
          onInterrupt: () => {
            if (engineRunning) {
              activeAbortController?.abort();
              engine.interrupt();
              transcript.append(r.interruptedMsg());
              renderScreen();
            }
          },
          onModeCycle: () => {
            cfg.mode = nextModeName(cfg.mode);
            session.mode = cfg.mode;
            modeObj = getMode(cfg.mode);
            return r.promptSymbol(cfg.mode);
          },
          onScroll: scrollTranscript,
          onRender: ({ value, cursor, completions }) => renderScreen(value, cursor, completions),
        });

        if (result.type === "eof") break;
        if (result.type !== "line") continue;

        input = result.value.trim();
        clearPrompt();
        if (!input) continue;
        transcript.append(`\n${p.blue("›")} ${p.text(input)}`);
        transcript.scrollToBottom();
        clearPrompt();
      }

      // Slash commands
      if (input.startsWith("/")) {
        const changed = await handleSlashCommand(input, cfg, session, history, costTracker, {
          renderPicker,
          clearModal,
          write: appendUiOutput,
          applyLoadedSession,
          rebuildRuntime,
          rebuildSystemPrompt,
          renderLoadedSession: () => renderSessionTranscript(true),
          setExitSummary: (message) => { exitSummary = message; },
          setActiveSkill: (instruction) => { activeSkillInstruction = instruction; },
        });
        if (changed === "exit") break;
        if (changed) modeObj = getMode(cfg.mode);
        renderScreen();
        continue;
      }

      turnCount++;

      // Capacity preview. Engine owns the actual refresh/verify/replan intervention.
      const capacityDecision = capacity.observe(history.approximateTokenCount(), cfg.context_limit);
      if (capacityDecision.action !== "no_intervention") {
        transcript.append(p.dim(`\nContext pressure: ${capacityDecision.risk} (${capacityDecision.action}).\n`));
        renderScreen();
      }

      // Run turn
      try {
        engineRunning = true;
        activeTurnStartedAt = Date.now();
        activeAbortController = new AbortController();
        const turnToken = ++activeTurnToken;
        const ui = createUiCallbacks(turnToken);
        runtimeView?.beginTurn();
        startGlobalInput();
        const skillInstruction = activeSkillInstruction;
        activeSkillInstruction = null;
        const result = await engine.runTurn(input, modeObj, ui, {
          signal: activeAbortController.signal,
          ephemeralInstructions: skillInstruction || undefined,
        });
        renderScreen();
        engineRunning = false;
        runtimeView?.finishTurn();
        const tokensIn = (result.usage?.prompt_tokens as number) || 0;
        const tokensOut = (result.usage?.completion_tokens as number) || 0;
        session.cumulative_tokens_in += tokensIn;
        session.cumulative_tokens_out += tokensOut;
        const cachedTokensIn = extractCachedInputTokens(result.usage);
        lastCacheTokens = cachedTokensIn;
        lastTurnDurationMs = Math.round(result.duration_s * 1000);
        const cost = costTracker.recordTurn(tokensIn, tokensOut, cachedTokensIn, result.duration_s).cost;
        session.cumulative_cost += cost;
        const turnIndex = session.turns.length + 1;
        session.turns.push({
          index: turnIndex,
          user_message: input,
          assistant_messages: session.messages.filter(message => message.role === "assistant").slice(-1),
          tool_calls: result.tool_calls,
          tool_results: result.tool_results,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          cost,
          duration_s: result.duration_s,
          artifact_ids: result.artifact_ids,
        });
        if (result.artifact_ids.length) {
          const turnKey = `turn:${turnIndex}`;
          session.artifact_index[turnKey] = [...new Set([...(session.artifact_index[turnKey] || []), ...result.artifact_ids])];
          session.artifact_index.session = [...new Set([...(session.artifact_index.session || []), ...result.artifact_ids])];
          for (const artifactId of result.artifact_ids) {
            linkArtifact(artifactId, "session", session.id, { turn_index: turnIndex });
            linkArtifact(artifactId, "turn", `${session.id}:${turnIndex}`, { session_id: session.id, turn_index: turnIndex });
          }
        }
        refreshSessionTitle(session);
        if (turnCount % 5 === 0) {
          try { saveSession(session); }
          catch (e: any) { transcript.append(p.warning(`\nCould not save session: ${e.message}`)); }
        }
        transcript.append("");
        renderScreen();
      } catch (e: any) {
        runtimeView?.finishTurn();
        engineRunning = false;
        if (isAbortError(e) || activeAbortController?.signal.aborted) {
          transcript.append("");
        } else {
          transcript.append(p.error(`\nError: ${e.message}\n`));
        }
        renderScreen();
      } finally {
        stopGlobalInput();
        engineRunning = false;
        activeTurnStartedAt = 0;
        activeAbortController = null;
        activeTurnToken++;
      }
    }
  } finally {
    screen.disableBracketedPaste();
    runtimeView?.dispose();
    if (pendingRenderTimer) {
      clearTimeout(pendingRenderTimer);
      pendingRenderTimer = null;
      pendingRenderArgs = null;
    }
    stopGlobalInput();
    layout.finish();
    screen.teardown({ finalNewline: false });
    restoreTTYInput(process.stdin, initialRawMode);
  }
  if (exitSummary) {
    console.log(exitSummary);
  } else {
    console.log(p.dim("Goodbye!"));
  }
}

type PickerRenderer = (idx: number, items: PickItem[], title: string, maxVisibleItems?: number, kind?: TuiModalKind) => void;

interface SlashCommandRuntime {
  renderPicker?: PickerRenderer;
  clearModal?: () => void;
  write?: (message: unknown, isError?: boolean) => void;
  applyLoadedSession: (loaded: ReturnType<typeof createSession>) => void;
  rebuildRuntime: () => void;
  rebuildSystemPrompt: () => void;
  renderLoadedSession: () => void;
  setExitSummary?: (message: string) => void;
  setActiveSkill?: (instruction: string) => void;
  liveReadonly?: boolean;
}

async function pickFromList(
  items: PickItem[],
  title = "Select",
  render?: PickerRenderer,
  clearRender?: () => void,
  kind: TuiModalKind = "picker",
): Promise<string | null> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY || !items.length) return null;

  let idx = 0;
  const len = items.length;
  let first = true;
  let previousTotalLines = 0;
  let resizeTimer: NodeJS.Timeout | null = null;

  const maxVisibleItems = () => Math.max(1, Math.min(len, (process.stdout.rows || 24) - 6));

  const renderPicker = () => {
    const visibleItems = maxVisibleItems();
    const totalLines = visibleItems + 3;
    const window = pickerWindow(items, idx, visibleItems);
    if (render) { render(idx, items, title, visibleItems, kind); return; }
    stdout.write("\x1b[?25l");
    if (!first && previousTotalLines > 0) stdout.write(`\x1b[${previousTotalLines}A`);
    first = false;
    if (window.start > 0) {
      stdout.write("\r\x1b[2K" + p.dim(`  ↑ ${window.start} newer session${window.start === 1 ? "" : "s"}`) + "\n");
    } else {
      stdout.write("\r\x1b[2K\n");
    }
    for (const entry of window.entries) {
      const item = entry.item;
      const prefix = entry.selected ? p.blue("❯ ") : "  ";
      const line = item.desc ? `${prefix}${item.name}  ${p.dim(item.desc)}` : `${prefix}${item.name}`;
      stdout.write("\r\x1b[2K" + line + "\n");
    }
    while (window.entries.length < visibleItems) stdout.write("\r\x1b[2K\n");
    if (window.end < window.total) {
      stdout.write("\r\x1b[2K" + p.dim(`  ↓ ${window.total - window.end} older session${window.total - window.end === 1 ? "" : "s"}`) + "\n");
    } else {
      stdout.write("\r\x1b[2K\n");
    }
    stdout.write("\r\x1b[2K" + p.dim(`${title}  ↑↓ select  Enter confirm  Esc cancel`) + "\n");
    previousTotalLines = totalLines;
  };

  return new Promise((resolve) => {
    let detachInput: (() => void) | null = null;
    let controller: InputController | null = null;
    let settled = false;
    if (!render) stdout.write("\r\x1b[2K\n");
    renderPicker();

    const handleKey = (key: string) => {
      if (settled) return true;
      const action = pickerActionForSequence(key);
      if (!action) return false;
      if (action === "confirm") { cleanup(); resolve(items[idx].name); return true; }
      if (action === "cancel") { cleanup(); resolve(null); return true; }
      const nextIndex = movePickerIndex(idx, len, action, maxVisibleItems());
      if (nextIndex !== idx) {
        idx = nextIndex;
        renderPicker();
      }
      return false;
    };

    const onResize = () => {
      if (resizeTimer) return;
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        idx = Math.max(0, Math.min(len - 1, idx));
        renderPicker();
      }, 16);
    };

    const cleanup = () => {
      if (settled) return;
      settled = true;
      detachInput?.();
      controller?.dispose();
      if (resizeTimer) {
        clearTimeout(resizeTimer);
        resizeTimer = null;
      }
      if (render) {
        clearRender?.();
      } else {
        stdout.write(`${previousTotalLines > 0 ? `\x1b[${previousTotalLines}A` : ""}\x1b[J\r`);
        stdout.write("\x1b[?25h");
      }
    };

    controller = new InputController({
      mode: "picker",
      editable: false,
      onUnhandledSequence: (key) => handleKey(key),
      onCtrlC: () => {
        cleanup();
        resolve(null);
        return true;
      },
    });
    detachInput = controller.attach({
      stdin,
      stdout,
      resizeTarget: stdout,
      bracketedPaste: false,
      onResize,
    });
  });
}

const MODELS: PickItem[] = [
  { name: "deepseek-v4-pro", desc: "1M context, reasoning, best for complex tasks" },
  { name: "deepseek-v4-flash", desc: "1M context, fast & cheap, best for parallel/simple" },
];

const PROVIDERS: PickItem[] = [
  { name: "deepseek", desc: "Official DeepSeek API" },
  { name: "deepseek-cn", desc: "DeepSeek China endpoint" },
  { name: "nvidia-nim", desc: "NVIDIA NIM hosted DeepSeek" },
  { name: "openrouter", desc: "OpenRouter DeepSeek routes" },
  { name: "novita", desc: "Novita AI DeepSeek routes" },
  { name: "fireworks", desc: "Fireworks AI DeepSeek routes" },
  { name: "sglang", desc: "Self-hosted SGLang endpoint" },
];

async function pickModel(
  current: string,
  render?: PickerRenderer,
  clearRender?: () => void,
): Promise<string | null> {
  const idx = MODELS.findIndex(m => m.name === current);
  const items = idx > 0 ? [...MODELS.slice(idx), ...MODELS.slice(0, idx)] : [...MODELS];
  return pickFromList(items, "Select model", render, clearRender);
}

async function pickProvider(
  current: string,
  render?: PickerRenderer,
  clearRender?: () => void,
): Promise<string | null> {
  const idx = PROVIDERS.findIndex(provider => provider.name === current);
  const items = idx > 0 ? [...PROVIDERS.slice(idx), ...PROVIDERS.slice(0, idx)] : [...PROVIDERS];
  return pickFromList(items, "Select provider", render, clearRender);
}

async function confirmPrompt(
  message: string,
  render?: PickerRenderer,
  clearRender?: () => void,
): Promise<boolean> {
  const selected = await pickFromList([
    { name: "no", desc: "Cancel" },
    { name: "yes", desc: "Delete permanently" },
  ], message, render, clearRender, "confirm");
  return selected === "yes";
}

async function handleSlashCommand(
  input: string, cfg: ReturnType<typeof loadConfig>, session: ReturnType<typeof createSession>,
  history: ConversationHistory, costTracker: CostTracker,
  runtime: SlashCommandRuntime,
): Promise<boolean | "exit"> {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const write = runtime.write ?? ((message: unknown) => {
    console.log(typeof message === "string" ? message : JSON.stringify(message, null, 2));
  });

  if (runtime.liveReadonly && !LIVE_READONLY_COMMANDS.has(cmd)) {
    write(p.warning(`Command ${cmd} is not available while the agent is running. Use Esc to interrupt, or wait for the turn to finish.`));
    return false;
  }

  switch (cmd) {
    case "/help":
      write(`
${p.blueBold("Commands")}
  /help          Show this help
  Shift+Tab      Cycle mode (plan → agent → yolo)
  /plan          Switch to Plan mode (read-only)
  /agent         Switch to Agent mode (interactive approval)
  /yolo          Switch to YOLO mode (auto-approved)
  /provider [p]  Show or switch provider
  /model [name]  Show or switch model (pro/flash)
  /capabilities  Show current provider/model capability matrix
  /reasoning     Cycle reasoning effort (off → high → max)
  /clear         Clear conversation history
  /save          Save current session
  /load <id>     Load a saved session
  /delete [id]   Delete a saved session
  /sessions      List saved sessions
  /exit          Save session and exit (resume next time)
  /restore       List/revert workspace snapshots
  /cost          Show detailed cost breakdown
  /tokens        Show token usage
  /tasks         Show task status
  /jobs          Show background shell jobs
  /mcp           Manage MCP servers
  /skills        List skills (--remote browses registry)
  /skill <name>  Apply/install/update/uninstall/trust skills
  /permissions   Show permission rules
  /version       Show version
  Ctrl+C         Exit
`);
      break;

    case "/plan":
      cfg.mode = "plan"; session.mode = "plan";
      write(p.modePlan("Switched to Plan mode (read-only)."));
      return true;
    case "/agent":
      cfg.mode = "agent"; session.mode = "agent";
      write(p.success("Switched to Agent mode (interactive approval)."));
      return true;
    case "/yolo":
      cfg.mode = "yolo"; session.mode = "yolo";
      write(p.warning("Switched to YOLO mode (auto-approved)."));
      return true;

    case "/provider": {
      let rawProvider: string | undefined = parts[1];
      if (!rawProvider) {
        rawProvider = await pickProvider(cfg.provider, runtime.renderPicker, runtime.clearModal) || undefined;
      }
      if (!rawProvider) {
        write(JSON.stringify({
          provider: cfg.provider,
          base_url: cfg.base_url,
          model: cfg.model,
          capability: providerCapability(cfg.provider as ApiProvider, cfg.model),
        }, null, 2));
        break;
      }
      const provider = parseProvider(rawProvider);
      const modelArg = parts[2] || cfg.model;
      const capability = providerCapability(provider, modelArg);
      (cfg as any).provider = provider;
      cfg.base_url = defaultBaseUrlForProvider(provider);
      cfg.model = capability.resolved_model;
      session.model = capability.resolved_model;
      runtime.rebuildRuntime();
      runtime.rebuildSystemPrompt();
      write(p.success(`Provider: ${provider}`));
      write(p.success(`Model: ${capability.resolved_model}`));
      write(p.dim(`Base URL: ${cfg.base_url}`));
      break;
    }

    case "/model": {
      const model = parts[1];
      if (model) {
        const capability = providerCapability(cfg.provider as ApiProvider, model);
        if (capability.resolved_model) {
          cfg.model = capability.resolved_model;
          session.model = capability.resolved_model;
          runtime.rebuildRuntime();
          write(p.success(`Model: ${capability.resolved_model}`));
          if (capability.deprecation) write(p.warning(`${capability.deprecation.alias} is deprecated; use ${capability.deprecation.replacement}`));
        } else {
          write(p.warning(`Unknown model: ${model}. Available: deepseek-v4-pro, deepseek-v4-flash`));
        }
      } else {
        // Interactive picker with arrow key support
        const selected = await pickModel(cfg.model, runtime.renderPicker, runtime.clearModal);
        if (selected) {
          cfg.model = selected;
          session.model = selected;
          runtime.rebuildRuntime();
          write(p.success(`Model: ${selected}`));
        }
      }
      break;
    }
    case "/capabilities": {
      const capability = providerCapability(cfg.provider as ApiProvider, cfg.model);
      write(JSON.stringify(capability, null, 2));
      break;
    }
    case "/reasoning": {
      const cycle: Record<string, string> = { off: "low", low: "medium", medium: "high", high: "max", max: "xhigh", xhigh: "off" };
      (cfg as any).reasoning_effort = cycle[cfg.reasoning_effort] || "high";
      write(p.success(`Reasoning effort: ${cfg.reasoning_effort}`));
      break;
    }
    case "/clear":
      session.messages = [];
      history.clear();
      clearPlanState();
      clearGoalState();
      clearAgentState();
      clearApprovalCache();
      clearTaskManager();
      clearPermissions();
      session.turns = [];
      session.cumulative_tokens_in = 0;
      session.cumulative_tokens_out = 0;
      session.cumulative_cost = 0;
      session.title = "Untitled session";
      costTracker.reset(cfg.model);
      runtime.rebuildSystemPrompt();
      write(p.success("Conversation cleared."));
      break;
    case "/save": {
      try {
        const id = saveSession(session);
        write(p.success(`Session saved: ${id} — ${session.title}`));
      } catch (e: any) {
        write(p.error(`Could not save session: ${e.message}`));
      }
      break;
    }
    case "/load": {
      const id = parts[1];
      if (id) {
        const loaded = loadSession(id);
        if (!loaded) { write(p.error(`Session not found: ${id}`)); break; }
        runtime.applyLoadedSession(loaded);
        runtime.renderLoadedSession();
        write(p.success(`Loaded session: ${loaded.title} (${loaded.messages.filter(message => message.role !== "system").length} messages)`));
        return true;
      }
      const sessions = listSessions();
      if (!sessions.length) { write(p.dim("No saved sessions.")); break; }
      const selected = await pickFromList(
        sessions.map(s => ({
          name: s.id,
          desc: `${s.title}  ${p.dim(`${s.updated_at?.slice(0, 16) || ""}  ${s.message_count} msgs  ${s.mode}  ${basename(s.workspace_path || "")}`)}`,
        })),
        "Select session to load",
        runtime.renderPicker,
        runtime.clearModal,
      );
      if (!selected) break;
      const loaded = loadSession(selected);
      if (!loaded) { write(p.error(`Session not found: ${selected}`)); break; }
      runtime.applyLoadedSession(loaded);
      runtime.renderLoadedSession();
      write(p.success(`Loaded session: ${loaded.title} (${loaded.messages.filter(message => message.role !== "system").length} messages)`));
      return true;
    }
    case "/delete": {
      let id: string | undefined = parts[1];
      const sessions = listSessions();
      if (!id) {
        if (!sessions.length) { write(p.dim("No saved sessions.")); break; }
        id = await pickFromList(
          sessions.map(s => ({
            name: s.id,
            desc: `${s.title}  ${p.dim(`${s.updated_at?.slice(0, 16) || ""}  ${s.message_count} msgs  ${s.mode}  ${basename(s.workspace_path || "")}`)}`,
          })),
          "Select session to delete",
          runtime.renderPicker,
          runtime.clearModal,
        ) || undefined;
        if (!id) break;
      }

      const loadedTarget = loadSession(id);
      const target = sessions.find(s => s.id === id) || (loadedTarget ? {
        id,
        title: loadedTarget.title || id,
        created_at: "",
        updated_at: "",
        mode: "",
        model: "",
        workspace_path: "",
        message_count: 0,
      } : null);
      if (!target) { write(p.error(`Session not found: ${id}`)); break; }
      const confirmed = await confirmPrompt(`Delete session ${id}?`, runtime.renderPicker, runtime.clearModal);
      if (!confirmed) { write(p.dim("Delete cancelled.")); break; }

      if (deleteSession(id)) {
        if (id === session.id) {
          session.id = createSession().id;
        }
        write(p.success(`Deleted session: ${id} — ${target.title}`));
      } else {
        write(p.error(`Could not delete session: ${id}`));
      }
      break;
    }
    case "/sessions": {
      const sessions = listSessions();
      if (!sessions.length) { write(p.dim("No saved sessions.")); break; }
      write(p.blueBold(`Saved sessions (${sessions.length}):`));
      for (const s of sessions.slice(0, 10)) {
        write(`  ${p.blue(s.id)} | ${s.title} | ${s.updated_at?.slice(0, 16) || ""} | ${s.message_count} msgs | ${s.mode} | ${basename(s.workspace_path || "")}`);
      }
      break;
    }
    case "/restore": {
      if (parts[1] === "revert") {
        const result = await revertLastTurn(resolve("."));
        write(p.success(result));
      } else {
        const snapshots = await restoreWorkspace(resolve("."));
        if (!snapshots.length) { write(p.dim("No snapshots available.")); break; }
        write(p.blueBold("Snapshots:"));
        for (const s of snapshots.slice(0, 10)) {
          write(`  ${p.blue(s.hash.slice(0, 8))} ${s.message} [${s.date?.slice(0, 19) || ""}]`);
        }
      }
      break;
    }
    case "/tokens": {
      const tokens = history.approximateTokenCount();
      const limit = cfg.context_limit;
      const pct = limit ? (tokens / limit) * 100 : 0;
      const bar = "█".repeat(Math.floor(pct / 5)) + "░".repeat(20 - Math.floor(pct / 5));
      write(`Context: [${bar}] ${tokens.toLocaleString()} / ${limit.toLocaleString()} tokens (${pct.toFixed(0)}%)`);
      write(formatCapacityDecision(new CapacityController().observe(tokens, limit)));
      break;
    }
    case "/tasks": {
      const tm = getTaskManager();
      const subcmd = parts[1];
      const id = parts[2];
      if (runtime.liveReadonly && ["cancel", "complete"].includes(subcmd || "")) {
        write(p.warning(`/${cmd.slice(1)} ${subcmd} is not available while the agent is running. Use Esc to interrupt, or wait for the turn to finish.`));
        break;
      }
      if (subcmd === "read" && id) {
        const task = tm.getTask(id) || tm.getHistory().find(item => item.id === id);
        write(task ? JSON.stringify(task, null, 2) : p.error(`Task not found: ${id}`));
        break;
      }
      if (subcmd === "cancel" && id) {
        write(tm.killTask(id) ? p.success(`Cancelled task ${id}.`) : p.error(`Task not active: ${id}`));
        break;
      }
      if (subcmd === "complete" && id) {
        write(tm.completeTask(id, parts.slice(3).join(" ") || undefined) ? p.success(`Completed task ${id}.`) : p.error(`Task not active: ${id}`));
        break;
      }
      const checklist = formatTodoState();
      if (checklist) write(checklist);
      const stats = tm.getTaskStats();
      write(p.blueBold(`Durable tasks: ${stats.active} active, ${stats.total} total`));
      write(`  Completed: ${stats.completed} | Failed: ${stats.failed} | Killed: ${stats.killed}`);
      if (Object.keys(stats.byType).length) {
        write("  By type: " + Object.entries(stats.byType).map(([k, v]) => `${k}:${v}`).join(" "));
      }
      const active = tm.getActiveTasks();
      for (const t of active.slice(0, 10)) {
        const dur = ((Date.now() - t.startTime) / 1000).toFixed(0);
        write(`  ${t.status === "running" ? "◎" : "○"} [${t.type}] ${t.description} (${dur}s)`);
      }
      break;
    }
    case "/jobs": {
      const subcmd = parts[1];
      const id = parts[2];
      if (runtime.liveReadonly && ["cancel", "prune"].includes(subcmd || "")) {
        write(p.warning(`/${cmd.slice(1)} ${subcmd} is not available while the agent is running. Use Esc to interrupt, or wait for the turn to finish.`));
        break;
      }
      if (subcmd === "cancel" && id) {
        write(getJobManager().cancel(id) ? p.success(`Cancelled job ${id}.`) : p.error(`Job not running: ${id}`));
        break;
      }
      if (subcmd === "show" && id) {
        const job = getJobManager().get(id);
        write(job ? formatJob(job, 4000) : p.error(`Job not found: ${id}`));
        break;
      }
      if (subcmd === "prune") {
        write(p.success(`Pruned ${getJobManager().prune()} old job(s).`));
        break;
      }
      const jobs = getJobManager().list();
      if (!jobs.length) {
        write(p.dim("No background jobs."));
        break;
      }
      for (const job of jobs.slice(0, 10)) {
        write(formatJob(job, 800));
        write("");
      }
      break;
    }
    case "/skills": {
      if (parts[1] === "--remote" || parts[1] === "remote") {
        try {
          write(await listRemoteSkills(cfg.skills_registry_url, cfg.skills_max_install_size_bytes));
        } catch (e: any) {
          write(p.error(`Could not fetch remote skills: ${e.message}`));
        }
        break;
      }
      write(listSkills(resolve("."), cfg.skills_dir));
      break;
    }
    case "/skill": {
      const subcmdOrName = parts[1];
      if (!subcmdOrName) {
        write(p.error("Usage: /skill <name|new|install <spec>|update <name>|uninstall <name>|trust <name>>"));
        break;
      }
      try {
        if (subcmdOrName === "install") {
          const spec = parts.slice(2).join(" ");
          if (!spec) { write(p.error("Usage: /skill install <github:owner/repo|https://...|registry-name>")); break; }
          const result = await installSkill(spec, {
            skillsDir: cfg.skills_dir,
            registryUrl: cfg.skills_registry_url,
            maxSizeBytes: cfg.skills_max_install_size_bytes,
          });
          runtime.rebuildSystemPrompt();
          write(p.success(`Installed skill '${result.skill.name}' at ${result.skill.path}`));
          break;
        }
        if (subcmdOrName === "update") {
          const name = parts[2];
          if (!name) { write(p.error("Usage: /skill update <name>")); break; }
          const result = await updateSkill(name, {
            skillsDir: cfg.skills_dir,
            registryUrl: cfg.skills_registry_url,
            maxSizeBytes: cfg.skills_max_install_size_bytes,
          });
          runtime.rebuildSystemPrompt();
          write(p.success(`Skill '${result.skill.name}' ${result.status}.`));
          break;
        }
        if (subcmdOrName === "uninstall") {
          const name = parts[2];
          if (!name) { write(p.error("Usage: /skill uninstall <name>")); break; }
          write(p.success(uninstallSkill(name, { skillsDir: cfg.skills_dir })));
          runtime.rebuildSystemPrompt();
          break;
        }
        if (subcmdOrName === "trust") {
          const name = parts[2];
          if (!name) { write(p.error("Usage: /skill trust <name>")); break; }
          write(p.success(trustSkill(name, { skillsDir: cfg.skills_dir, workspaceDir: resolve(".") })));
          break;
        }
        const result = activateSkill(subcmdOrName, { workspaceDir: resolve("."), skillsDir: cfg.skills_dir });
        if (!result.ok || !result.instruction) {
          write(p.error(result.message));
          break;
        }
        runtime.setActiveSkill?.(result.instruction);
        write(p.success(result.message));
      } catch (e: any) {
        write(p.error(`Skill error: ${e.message}`));
      }
      break;
    }
    case "/permissions": {
      const rules = getAllRules();
      const mem = getSessionMemory();
      write(p.blueBold(`Permissions: ${rules.length} rules`));
      write(`  Always allowed: ${mem.allow.join(", ") || "none"}`);
      write(`  Always denied: ${mem.deny.join(", ") || "none"}`);
      write("  Default rules:");
      for (const r of rules.slice(0, 20)) {
        write(`    ${r.permission}:${r.pattern} → ${r.action}`);
      }
      break;
    }
    case "/mcp": {
      const subcmd = parts[1] || "list";
      try {
        if (subcmd === "list") {
          write(JSON.stringify(getMCPManager(cfg).list(), null, 2));
          break;
        }
        if (subcmd === "reload") {
          const manager = await reloadMCPManager(cfg);
          write(JSON.stringify({ reloaded: true, servers: manager.list() }, null, 2));
          break;
        }
        if (subcmd === "enable" || subcmd === "disable") {
          const name = parts[2];
          if (!name) { write(p.error("Usage: /mcp enable|disable <name>")); break; }
          setMCPServerEnabled(name, subcmd === "enable");
          write(p.success(`${subcmd === "enable" ? "Enabled" : "Disabled"} MCP server ${name}. Run /mcp reload to apply.`));
          break;
        }
        if (subcmd === "remove" || subcmd === "delete") {
          const name = parts[2];
          if (!name) { write(p.error("Usage: /mcp remove <name>")); break; }
          removeMCPServer(name);
          write(p.success(`Removed MCP server ${name}. Run /mcp reload to apply.`));
          break;
        }
        if (subcmd === "add") {
          const name = parts[2];
          const command = parts[3];
          if (!name || !command) {
            write(p.error("Usage: /mcp add <name> <command> [args...]"));
            break;
          }
          addMCPServer({ name, transport: "stdio", command, args: parts.slice(4), env: {}, enabled: true });
          write(p.success(`Added MCP server ${name}. Run /mcp reload to apply.`));
          break;
        }
        write(p.error("Usage: /mcp [list|add|enable|disable|remove|reload]"));
      } catch (e: any) {
        write(p.error(`MCP error: ${e.message}`));
      }
      break;
    }
    case "/config": {
      const subcmd = parts[1] || "explain";
      if (subcmd === "validate") {
        const report = validateConfig();
        write(JSON.stringify(report, null, 2));
        break;
      }
      if (subcmd === "migrate") {
        const target = parts[2] || "user";
        const dryRun = parts.includes("--dry-run");
        const report = target === "project" ? migrateProjectConfig({ dryRun }) : migrateUserConfig({ dryRun });
        write(JSON.stringify(report, null, 2));
        break;
      }
      if (subcmd === "explain") {
        write(JSON.stringify(explainConfig(), null, 2));
        break;
      }
      write(p.error("Usage: /config [validate|migrate user|migrate project|explain] [--dry-run]"));
      break;
    }
    case "/cost":
      write(costTracker.formatDetailed());
      break;
    case "/exit": {
      try {
        const sid = saveSession(session);
        runtime.setExitSummary?.([
          p.dim("Goodbye!"),
          p.success(`Session saved as ${sid} — ${session.title}`),
          p.dim(`Resume with: seek    then: /load ${sid}`),
        ].join("\n"));
      } catch (e: any) {
        runtime.setExitSummary?.([
          p.dim("Goodbye!"),
          p.warning(`Could not save session: ${e.message}`),
        ].join("\n"));
      }
      return "exit";
    }
    case "/version":
      write(`seek-code v${VERSION}`);
      break;
    default:
      write(p.error(`Unknown command: ${cmd}`));
  }
  return false;
}

// CLI setup
const program = new Command();

function optionFromCli<T>(name: string, value: T): T | undefined {
  return program.getOptionValueSource(name) === "cli" ? value : undefined;
}

function configOverridesFromCliOptions(options: Record<string, any>): Record<string, unknown> {
  const tuiAlternateScreen = program.getOptionValueSource("altScreen") === "cli"
    ? options.altScreen === false ? "never" : "always"
    : undefined;
  return {
    model: optionFromCli("model", options.model),
    mode: optionFromCli("mode", options.mode),
    api_key: optionFromCli("apiKey", options.apiKey),
    provider: optionFromCli("provider", options.provider),
    base_url: optionFromCli("baseUrl", options.baseUrl),
    max_tokens: optionFromCli("maxTokens", parseOptionalInt(options.maxTokens)),
    reasoning_effort: optionFromCli("reasoningEffort", options.reasoningEffort),
    tui_alternate_screen: tuiAlternateScreen,
  };
}

program
  .name("seek")
  .description("Seek Code — a terminal-native coding agent powered by DeepSeek")
  .version(VERSION)
  .argument("[prompt...]", "One-shot prompt (omit for interactive REPL)")
  .option("-m, --model <model>", "Model to use", "deepseek-v4-pro")
  .option("--mode <mode>", "Interaction mode: plan, agent, yolo", "agent")
  .option("--api-key <key>", "DeepSeek API key")
  .option("--provider <provider>", "Provider: deepseek, deepseek-cn, nvidia-nim, openrouter, novita, fireworks, sglang")
  .option("--base-url <url>", "API base URL")
  .option("--max-tokens <n>", "Max tokens per response", "8192")
  .option("-r, --reasoning-effort <effort>", "Reasoning effort: off, low, medium, high, max, xhigh", "high")
  .option("--alt-screen", "Use fullscreen alternate screen")
  .option("--no-alt-screen", "Use inline mode with terminal-native scrollback")
  .action(async (promptParts: string[] | undefined, options) => {
    const cliOverrides = configOverridesFromCliOptions(options);
    const cfg = await ensureRuntimeApiKey(loadConfig(cliOverrides), cliOverrides);

    const prompt = (promptParts || []).join(" ").trim();
    if (prompt) {
      await runOneShot(cfg, prompt);
    } else {
      await maybePromptForUpdate();
      await runInteractive(cfg);
    }
  });

program.hook("preAction", async (_thisCommand, actionCommand) => {
  assertMinimumVersion({ commandName: actionCommand.name() });
});

program
  .command("update")
  .description("Check for and install the latest Seek Code version")
  .option("--check", "Only check whether an update is available")
  .option("--diagnose", "Print installation diagnostics without checking npm")
  .option("-y, --yes", "Install without prompting")
  .action(async (options) => {
    const result = await runUpdateCommand({
      yes: options.yes,
      checkOnly: options.check,
      diagnoseOnly: options.diagnose,
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
    });
    if (["failed", "locked", "unsupported"].includes(result)) process.exitCode = 1;
  });

program
  .command("serve")
  .description("Start the HTTP/SSE server")
  .option("-p, --port <port>", "Port to listen on", "8080")
  .option("-h, --host <host>", "Host to bind to", "0.0.0.0")
  .action(async (options) => {
    const cliOverrides = configOverridesFromCliOptions(program.opts());
    setupTools(await ensureRuntimeApiKey(loadConfig(cliOverrides), cliOverrides));
    const { runServer } = await import("./server/app.js");
    runServer(options.host, parseOptionalInt(options.port) ?? 8080);
  });

program
  .command("config")
  .description("Validate, migrate, or explain Seek Code configuration")
  .argument("[action]", "validate, migrate, or explain", "validate")
  .option("--target <target>", "Migration target: user or project", "user")
  .option("--dry-run", "Show migration actions without writing")
  .option("--json", "Emit JSON output", true)
  .action(async (action, options) => {
    const cliOverrides = configOverridesFromCliOptions(program.opts());
    if (action === "validate") {
      const report = validateConfig(cliOverrides);
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.ok ? 0 : 1;
      return;
    }
    if (action === "migrate") {
      const report = options.target === "project"
        ? migrateProjectConfig({ dryRun: options.dryRun })
        : migrateUserConfig({ dryRun: options.dryRun });
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    if (action === "explain") {
      console.log(JSON.stringify(explainConfig(cliOverrides), null, 2));
      return;
    }
    throw new Error(`Unknown config action: ${action}`);
  });

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(p.error(`Error: ${message}`));
  process.exitCode = 1;
});
