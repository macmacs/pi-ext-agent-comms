import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";

function getStatus(ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1]): string {
  const model = ctx.model?.name || ctx.model?.id || "no-model";
  const usage = ctx.getContextUsage();
  const contextPercent = usage?.percent != null ? `${Math.round(usage.percent)}%` : "?%";
  return ` | ${model} | ${contextPercent}`;
}

function pushToTmux(status: string) {
  const pane = process.env.TMUX_PANE;
  if (!pane) return;
  try {
    execFileSync("tmux", ["set-option", "-p", "-t", pane, "@pi_status", status]);
    execFileSync("tmux", ["refresh-client", "-S"]);
  } catch {}
}

function clearTmux() {
  const pane = process.env.TMUX_PANE;
  if (!pane) return;
  try {
    execFileSync("tmux", ["set-option", "-p", "-t", pane, "-u", "@pi_status"]);
    execFileSync("tmux", ["refresh-client", "-S"]);
  } catch {}
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    pushToTmux(getStatus(ctx));
    ctx.ui.setFooter(() => ({ dispose: () => {}, invalidate() {}, render: () => [] }));
  });

  pi.on("model_select", async (_event, ctx) => {
    pushToTmux(getStatus(ctx));
  });

  pi.on("turn_end", async (_event, ctx) => {
    pushToTmux(getStatus(ctx));
  });

  pi.on("session_shutdown", async () => {
    clearTmux();
  });
}
