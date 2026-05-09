import { basename } from "node:path";
import { saveSession, loadSession, listSessions, deleteSession } from "../session/store.js";
import { createSession } from "../session/types.js";
import { p } from "../ui/palette.js";
import { confirmPrompt, pickFromList } from "./picker.js";
import type { SlashCommandHandler } from "./types.js";

function sessionItemDescription(session: ReturnType<typeof listSessions>[number]): string {
  return `${session.title}  ${p.dim(`${session.updated_at?.slice(0, 16) || ""}  ${session.message_count} msgs  ${session.mode}  ${basename(session.workspace_path || "")}`)}`;
}

export const saveCommand: SlashCommandHandler = ({ session, write }) => {
  try {
    const id = saveSession(session);
    write(p.success(`Session saved: ${id} — ${session.title}`));
  } catch (e: any) {
    write(p.error(`Could not save session: ${e.message}`));
  }
};

export const loadCommand: SlashCommandHandler = async ({ parts, runtime, write }) => {
  const id = parts[1];
  if (id) {
    const loaded = loadSession(id);
    if (!loaded) {
      write(p.error(`Session not found: ${id}`));
      return;
    }
    runtime.applyLoadedSession(loaded);
    runtime.renderLoadedSession();
    write(p.success(`Loaded session: ${loaded.title} (${loaded.messages.filter(message => message.role !== "system").length} messages)`));
    return true;
  }

  const sessions = listSessions();
  if (!sessions.length) {
    write(p.dim("No saved sessions."));
    return;
  }
  const selected = await pickFromList(
    sessions.map(s => ({ name: s.id, desc: sessionItemDescription(s) })),
    "Select session to load",
    runtime.renderPicker,
    runtime.clearModal,
  );
  if (!selected) return;
  const loaded = loadSession(selected);
  if (!loaded) {
    write(p.error(`Session not found: ${selected}`));
    return;
  }
  runtime.applyLoadedSession(loaded);
  runtime.renderLoadedSession();
  write(p.success(`Loaded session: ${loaded.title} (${loaded.messages.filter(message => message.role !== "system").length} messages)`));
  return true;
};

export const deleteCommand: SlashCommandHandler = async ({ parts, session, runtime, write }) => {
  let id: string | undefined = parts[1];
  const sessions = listSessions();
  if (!id) {
    if (!sessions.length) {
      write(p.dim("No saved sessions."));
      return;
    }
    id = await pickFromList(
      sessions.map(s => ({ name: s.id, desc: sessionItemDescription(s) })),
      "Select session to delete",
      runtime.renderPicker,
      runtime.clearModal,
    ) || undefined;
    if (!id) return;
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
  if (!target) {
    write(p.error(`Session not found: ${id}`));
    return;
  }
  const confirmed = await confirmPrompt(`Delete session ${id}?`, runtime.renderPicker, runtime.clearModal);
  if (!confirmed) {
    write(p.dim("Delete cancelled."));
    return;
  }

  if (deleteSession(id)) {
    if (id === session.id) {
      session.id = createSession().id;
    }
    write(p.success(`Deleted session: ${id} — ${target.title}`));
  } else {
    write(p.error(`Could not delete session: ${id}`));
  }
};

export const sessionsCommand: SlashCommandHandler = ({ write }) => {
  const sessions = listSessions();
  if (!sessions.length) {
    write(p.dim("No saved sessions."));
    return;
  }
  write(p.blueBold(`Saved sessions (${sessions.length}):`));
  for (const s of sessions.slice(0, 10)) {
    write(`  ${p.blue(s.id)} | ${s.title} | ${s.updated_at?.slice(0, 16) || ""} | ${s.message_count} msgs | ${s.mode} | ${basename(s.workspace_path || "")}`);
  }
};

export const exitCommand: SlashCommandHandler = ({ session, runtime }) => {
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
};
