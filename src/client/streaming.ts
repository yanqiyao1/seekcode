/** Stream accumulator helpers used by the UI layer. */

export class StreamAccumulator {
  content = "";
  reasoning = "";
  toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();

  addContent(text: string): void {
    this.content += text;
  }

  addReasoning(text: string): void {
    this.reasoning += text;
  }

  addToolCallDelta(index: number, tcId = "", name = "", args = ""): void {
    if (!this.toolCalls.has(index)) {
      this.toolCalls.set(index, { id: "", name: "", arguments: "" });
    }
    const acc = this.toolCalls.get(index)!;
    if (tcId) acc.id = tcId;
    if (name) acc.name = name;
    if (args) acc.arguments += args;
  }

  get isEmpty(): boolean {
    return !this.content && !this.reasoning && this.toolCalls.size === 0;
  }
}
