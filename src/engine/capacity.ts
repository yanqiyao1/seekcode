/** Capacity-aware context pressure guardrails. */

export type RiskBand = "low" | "medium" | "high";
export type GuardrailAction = "no_intervention" | "targeted_context_refresh" | "verify_with_tool_replay" | "verify_and_replan";

export interface CapacityDecision {
  used_tokens: number;
  context_limit: number;
  used_ratio: number;
  risk: RiskBand;
  action: GuardrailAction;
  reason: string;
}

export interface CapacityConfig {
  lowRiskMax?: number;
  mediumRiskMax?: number;
  severeMinSlack?: number;
}

export class CapacityController {
  private lowRiskMax: number;
  private mediumRiskMax: number;
  private severeMinSlack: number;

  constructor(config: CapacityConfig = {}) {
    this.lowRiskMax = config.lowRiskMax ?? 0.50;
    this.mediumRiskMax = config.mediumRiskMax ?? 0.72;
    this.severeMinSlack = config.severeMinSlack ?? 0.08;
  }

  observe(usedTokens: number, contextLimit: number): CapacityDecision {
    const safeLimit = Math.max(1, contextLimit);
    const ratio = Math.max(0, usedTokens) / safeLimit;
    const slack = 1 - ratio;
    if (slack <= this.severeMinSlack) {
      return {
        used_tokens: usedTokens,
        context_limit: contextLimit,
        used_ratio: ratio,
        risk: "high",
        action: "verify_and_replan",
        reason: "context window is nearly exhausted",
      };
    }
    if (ratio > this.mediumRiskMax) {
      return {
        used_tokens: usedTokens,
        context_limit: contextLimit,
        used_ratio: ratio,
        risk: "high",
        action: "targeted_context_refresh",
        reason: "context pressure is high; compact before continuing",
      };
    }
    if (ratio > this.lowRiskMax) {
      return {
        used_tokens: usedTokens,
        context_limit: contextLimit,
        used_ratio: ratio,
        risk: "medium",
        action: "verify_with_tool_replay",
        reason: "context pressure is moderate",
      };
    }
    return {
      used_tokens: usedTokens,
      context_limit: contextLimit,
      used_ratio: ratio,
      risk: "low",
      action: "no_intervention",
      reason: "context pressure is low",
    };
  }
}

export function formatCapacityDecision(decision: CapacityDecision): string {
  return [
    `risk: ${decision.risk}`,
    `action: ${decision.action}`,
    `context: ${decision.used_tokens.toLocaleString()} / ${decision.context_limit.toLocaleString()} (${(decision.used_ratio * 100).toFixed(1)}%)`,
    `reason: ${decision.reason}`,
  ].join("\n");
}
