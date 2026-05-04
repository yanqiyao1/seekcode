/** DeepSeek-blue color palette using chalk. */

import chalk from "chalk";

export const theme = {
  primary: chalk.hex("#00afff"),        // deep sky blue
  primaryBold: chalk.hex("#00afff").bold,
  primaryDim: chalk.hex("#00afff").dim,

  user: chalk.whiteBright,
  assistant: chalk.hex("#00afff"),
  system: chalk.gray,
  tool: chalk.hex("#8fbc8f"),           // dark sea green
  thinking: chalk.hex("#b0c4de"),       // light steel blue
  thinkingDim: chalk.hex("#b0c4de").dim,

  modePlan: chalk.cyan,
  modeAgent: chalk.green,
  modeYolo: chalk.yellow,
  statusTokens: chalk.yellow,
  statusCost: chalk.hex("#76ee00"),     // chartreuse2
  statusModel: chalk.cyan.dim,

  error: chalk.hex("#cd5c5c"),          // indian red
  warning: chalk.hex("#ffd700"),        // gold
  success: chalk.hex("#76ee00"),
  info: chalk.hex("#00afff"),
  dim: chalk.gray,
  muted: chalk.dim,

  prompt: chalk.whiteBright.bold,
  banner: chalk.hex("#00afff").bold,
  approval: chalk.yellow.bold,
  toolName: chalk.yellow.bold,
  toolResult: chalk.dim,
} as const;
