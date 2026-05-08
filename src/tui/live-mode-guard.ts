import { p } from "../ui/palette.js";

export const RUNNING_MODE_SWITCH_BLOCKED_MESSAGE =
  "Agent is working. Mode switching is disabled until the current turn finishes. Use Esc to interrupt first.";

export function denyModeSwitchWhileRunning(
  write: (message: string) => void,
  prompt: string,
): string {
  write(p.warning(`  ${RUNNING_MODE_SWITCH_BLOCKED_MESSAGE}`));
  return prompt;
}
