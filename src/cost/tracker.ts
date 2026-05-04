/** Per-turn and cumulative cost tracking. */

import { calculateCost } from "./pricing.js";
import type { Session } from "../session/types.js";

export interface TurnCost {
  tokensIn: number;
  tokensOut: number;
  cachedTokensIn: number;
  cost: number;
  durationS: number;
}

export class CostTracker {
  model: string;
  turns: TurnCost[] = [];

  constructor(model = "deepseek-chat") { this.model = model; }

  reset(model = this.model): void {
    this.model = model;
    this.turns = [];
  }

  hydrateFromSession(session: Session): void {
    this.model = session.model;
    if (session.turns?.length) {
      this.turns = session.turns.map(turn => ({
        tokensIn: turn.tokens_in || 0,
        tokensOut: turn.tokens_out || 0,
        cachedTokensIn: 0,
        cost: turn.cost || 0,
        durationS: turn.duration_s || 0,
      }));
      return;
    }
    if (session.cumulative_tokens_in || session.cumulative_tokens_out || session.cumulative_cost) {
      this.turns = [{
        tokensIn: session.cumulative_tokens_in || 0,
        tokensOut: session.cumulative_tokens_out || 0,
        cachedTokensIn: 0,
        cost: session.cumulative_cost || 0,
        durationS: 0,
      }];
      return;
    }
    this.turns = [];
  }

  recordTurn(tokensIn: number, tokensOut: number, cachedTokensIn = 0, durationS = 0): TurnCost {
    const cost = calculateCost(this.model, tokensIn, tokensOut, cachedTokensIn);
    const tc: TurnCost = { tokensIn, tokensOut, cachedTokensIn, cost, durationS };
    this.turns.push(tc);
    return tc;
  }

  get totalTokensIn(): number { return this.turns.reduce((s, t) => s + t.tokensIn, 0); }
  get totalTokensOut(): number { return this.turns.reduce((s, t) => s + t.tokensOut, 0); }
  get totalCost(): number { return this.turns.reduce((s, t) => s + t.cost, 0); }
  get turnCount(): number { return this.turns.length; }

  formatSummary(): string {
    return `Tokens: ${this.totalTokensIn.toLocaleString()} in / ${this.totalTokensOut.toLocaleString()} out | Cost: $${this.totalCost.toFixed(4)} | Turns: ${this.turnCount}`;
  }

  formatDetailed(): string {
    const lines = ["Turn | Tokens In | Tokens Out | Cost", "-".repeat(50)];
    this.turns.forEach((t, i) => lines.push(`${(i + 1).toString().padStart(4)} | ${t.tokensIn.toLocaleString().padStart(9)} | ${t.tokensOut.toLocaleString().padStart(10)} | $${t.cost.toFixed(4)}`));
    lines.push("-".repeat(50));
    lines.push(`Total | ${this.totalTokensIn.toLocaleString().padStart(9)} | ${this.totalTokensOut.toLocaleString().padStart(10)} | $${this.totalCost.toFixed(4)}`);
    return lines.join("\n");
  }
}
