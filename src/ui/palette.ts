/** Seek Code Blue palette — single source of truth for all CLI colors. */

import chalk from "chalk";

// Primary brand
const blue = (s: string) => chalk.hex("#00afff")(s);
const blueBold = (s: string) => chalk.hex("#00afff").bold(s);
const blueDim = (s: string) => chalk.hex("#00afff").dim(s);

// Semantic
const success = (s: string) => chalk.hex("#5cb85c")(s);
const error = (s: string) => chalk.hex("#d9534f")(s);
const warning = (s: string) => chalk.hex("#f0ad4e")(s);
const info = (s: string) => chalk.hex("#5bc0de")(s);

// Content
const text = (s: string) => chalk.white(s);
const dim = (s: string) => chalk.hex("#888888")(s);
const subtle = (s: string) => chalk.hex("#666666")(s);
const thinking = (s: string) => chalk.hex("#7799bb")(s);

// Tool-specific
const toolName = (s: string) => chalk.hex("#f0ad4e").bold(s);
const bashColor = (s: string) => chalk.hex("#aa44aa")(s);

// Diff
const diffAdd = (s: string) => chalk.hex("#69db7c")(s);
const diffDel = (s: string) => chalk.hex("#ffa8b4")(s);

// Mode indicators
const modePlan = (s: string) => chalk.hex("#5bc0de")(s);
const modeAgent = (s: string) => chalk.hex("#5cb85c")(s);
const modeYolo = (s: string) => chalk.hex("#f0ad4e")(s);

export const p = {
  blue, blueBold, blueDim,
  success, error, warning, info,
  text, dim, subtle, thinking,
  toolName, bashColor,
  diffAdd, diffDel,
  modePlan, modeAgent, modeYolo,
} as const;

export const box = { h: "─", v: "│", tl: "┌", tr: "┐", bl: "└", br: "┘" } as const;
