/** Workspace restore and turn revert logic. */

import { SideGit } from "./side-git.js";

export async function restoreWorkspace(workspace = "."): Promise<Array<{ hash: string; message: string; date: string }>> {
  const sg = new SideGit(workspace);
  await sg.init();
  return sg.listSnapshots();
}

export async function revertToSnapshot(hash: string, workspace = "."): Promise<boolean> {
  const sg = new SideGit(workspace);
  await sg.init();
  return sg.restoreTo(hash);
}

export async function revertLastTurn(workspace = "."): Promise<string> {
  const sg = new SideGit(workspace);
  await sg.init();
  const snapshots = await sg.listSnapshots(20);
  const pre = snapshots.find(s => s.message.startsWith("pre-turn-"));
  if (!pre) return "No pre-turn snapshot found.";
  const ok = await sg.restoreTo(pre.hash);
  return ok ? `Reverted to ${pre.hash.slice(0, 8)}` : "Failed to revert.";
}
