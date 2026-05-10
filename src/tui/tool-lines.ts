/** Tracks active tool-call transcript lines by tool call id. */

export class ActiveToolLines {
  private readonly byId = new Map<string, number>();

  start(id: string, line: number): void {
    this.byId.set(id, line);
  }

  finish(id: string): number | undefined {
    const line = this.byId.get(id);
    if (line !== undefined) this.byId.delete(id);
    return line;
  }

  current(id: string): number | undefined {
    return this.byId.get(id);
  }

  earliestLine(): number | undefined {
    let earliest: number | undefined;
    for (const line of this.byId.values()) {
      if (earliest === undefined || line < earliest) earliest = line;
    }
    return earliest;
  }

  clear(): void {
    this.byId.clear();
  }

  get size(): number {
    return this.byId.size;
  }
}
