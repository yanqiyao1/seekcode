/** Tracks active tool-call transcript lines by tool name. */

export class ActiveToolLines {
  private readonly byName = new Map<string, number[]>();

  start(name: string, line: number): void {
    const lines = this.byName.get(name) ?? [];
    lines.push(line);
    this.byName.set(name, lines);
  }

  finish(name: string): number | undefined {
    const lines = this.byName.get(name);
    const line = lines?.shift();
    if (!lines?.length) this.byName.delete(name);
    return line;
  }

  clear(): void {
    this.byName.clear();
  }

  get size(): number {
    return [...this.byName.values()].reduce((sum, lines) => sum + lines.length, 0);
  }
}
