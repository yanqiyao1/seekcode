import { RuntimeApiClient, type RuntimeApiClientOptions } from "../server/runtime-client.js";
import type { TuiRuntimeViewModel } from "./runtime-view-model.js";

export async function replayServerRuntimeThread(
  view: TuiRuntimeViewModel,
  options: RuntimeApiClientOptions & { threadId: string; sinceSeq?: number },
): Promise<number> {
  const client = new RuntimeApiClient(options);
  const items = await client.getThreadItems(options.threadId, options.sinceSeq || 0);
  view.replayRuntimeItems(items);
  return items.at(-1)?.seq || options.sinceSeq || 0;
}
