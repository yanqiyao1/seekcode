import type { Config } from "../config.js";
import type { CostTracker } from "../cost/tracker.js";
import type { ConversationHistory } from "../session/history.js";
import type { Session } from "../session/types.js";
import type { TuiModalKind } from "../tui/modal.js";
import type { PickItem } from "../ui/picker.js";

export type SlashCommandResult = boolean | "exit" | { type: "prompt"; input: string; label?: string };
export type SlashCommandWrite = (message: unknown, isError?: boolean) => void;
export type PickerRenderer = (
  idx: number,
  items: PickItem[],
  title: string,
  maxVisibleItems?: number,
  kind?: TuiModalKind,
) => void;

export interface SlashCommandRuntime {
  renderPicker?: PickerRenderer;
  clearModal?: () => void;
  write?: SlashCommandWrite;
  getRequestTokenCount?: () => number;
  applyLoadedSession: (loaded: Session) => void;
  rebuildRuntime: () => void;
  rebuildSystemPrompt: () => void;
  renderLoadedSession: () => void;
  setExitSummary?: (message: string) => void;
  setActiveSkill?: (instruction: string) => void;
  clearActiveSkill?: () => void;
  liveReadonly?: boolean;
}

export interface SlashCommandContext {
  input: string;
  parts: string[];
  cmd: string;
  cfg: Config;
  session: Session;
  history: ConversationHistory;
  costTracker: CostTracker;
  runtime: SlashCommandRuntime;
  write: SlashCommandWrite;
}

export type SlashCommandHandler = (
  context: SlashCommandContext,
) => Promise<SlashCommandResult | void> | SlashCommandResult | void;
