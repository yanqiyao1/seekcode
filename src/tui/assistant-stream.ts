/** Maintains transcript line state for one streaming assistant response. */

import { Transcript } from "./transcript.js";
import { renderMarkdown } from "../ui/markdown.js";

export class AssistantStream {
  private active = false;
  private startLine = 0;
  private lineCount = 0;
  private raw = "";

  append(transcript: Transcript, text: string): void {
    if (!this.active) {
      const reusingBlankLine = Boolean(transcript.lines.length && !transcript.lines.at(-1)?.text.trim());
      if (!transcript.lines.length || transcript.lines.at(-1)?.text.trim()) {
        this.startLine = transcript.lines.length;
      } else {
        this.startLine = transcript.lines.length - 1;
      }
      this.active = true;
      this.lineCount = reusingBlankLine ? 1 : 0;
      this.raw = "";
    }
    this.raw += text;
    this.lineCount = transcript.replaceRange(this.startLine, this.lineCount, renderMarkdown(this.raw));
  }

  reset(): void {
    this.active = false;
    this.startLine = 0;
    this.lineCount = 0;
    this.raw = "";
  }
}
