import type { Session } from "./types.js";

const SESSION_TITLE_MAX_LEN = 120;
const DEFAULT_SESSION_TITLE = "Untitled session";

export function summarizeForLabel(text: string, maxLen = SESSION_TITLE_MAX_LEN): string {
  const firstLine = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")[0]?.trim() || "";
  if (!firstLine) return DEFAULT_SESSION_TITLE;
  if (Array.from(firstLine).length <= maxLen) return firstLine;
  return Array.from(firstLine).slice(0, Math.max(0, maxLen - 3)).join("") + "...";
}

export function deriveSessionTitle(session: Pick<Session, "messages">): string {
  const firstUser = session.messages.find(message => message.role === "user" && (message.content || "").trim());
  return firstUser?.content ? summarizeForLabel(firstUser.content) : DEFAULT_SESSION_TITLE;
}

export function refreshSessionTitle(session: Session): string {
  session.title = deriveSessionTitle(session);
  return session.title;
}
