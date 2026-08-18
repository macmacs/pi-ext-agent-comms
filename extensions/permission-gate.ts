import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Commands to auto-block, with the guidance the agent sees. [pattern, reason].
const deny: [RegExp, string][] = [
  [/env(\s|$)/, "Reading the environment is not allowed."],
  [/pip\s+install/, "Use `uv` instead of pip."],
  [/security\s+find-/, "Reading credentials from the keychain is not allowed."],
  [/git\s+credential\s+fill(\s|$)/, "Reading git credentials is not allowed."],
  [/git\s+push(\s|$)/, "The user will push."],
  [/pass\s+(?!(?:ls|find|grep|help|version)\b)/, "Reading credentials is not allowed."],
  [/find\s+\//, "Do not find on the entire system."],
  [/kubectl\s+get\s+secrets?\s+.*(-o|--output)/, "Reading secrets is not allowed."],
];

// Commands to confirm with the user case-by-case in the TUI.
const prompt: RegExp[] = [/rm\s+(-rf?|--recursive)/, /sudo(\s|$)/];

// Match at a command boundary: start of string or after a shell separator
// (| & ; && || newline).
const atBoundary = (pattern: RegExp) =>
  new RegExp(`(^|[|&;\\n]\\s*)\\s*` + pattern.source);

type Action = { type: "deny"; reason: string } | { type: "prompt" };

// Compiled rules, deny first so its guidance wins over a prompt.
const rules: { test: RegExp; action: Action }[] = [
  ...deny.map(([pattern, reason]) => ({
    test: atBoundary(pattern),
    action: { type: "deny", reason } as const,
  })),
  ...prompt.map((pattern) => ({
    test: atBoundary(pattern),
    action: { type: "prompt" } as const,
  })),
];

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    const command = event.input.command as string;
    const rule = rules.find(({ test }) => test.test(command));

    if (!rule) return undefined;

    // Auto-deny: no UI needed, works headless too.
    if (rule.action.type === "deny") {
      return { block: true, reason: rule.action.reason };
    }

    // Prompt: needs a UI. Block if there's none.
    if (!ctx.hasUI) {
      return {
        block: true,
        reason: "Command requires confirmation but no UI is available.",
      };
    }

    // Signal to co-loaded extensions (e.g. coms) that we're blocked.
    process.emit("pi:agent_blocked", true);
    let choice: string;
    try {
      choice = await ctx.ui.select(
        `⚠️ The agent wants to run a restricted command:\n\n  ${command}\n\nAllow execution?`,
        ["Yes", "No"],
      );
    } finally {
      process.emit("pi:agent_blocked", false);
    }

    // Block if the user selects anything other than "Yes"
    if (choice !== "Yes") {
      return { block: true, reason: "Blocked by user." };
    }

    // Return undefined to let it execute
    return undefined;
  });
}
