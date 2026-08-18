/**
 * example-border-segment — a minimal client of editor-host.
 *
 * Shows how any extension can add content to the input editor's border without
 * owning the editor. Here: the current git branch in the top-right corner.
 *
 * The whole pattern is three lines:
 *   1. import getEditorHost from editor-host.ts
 *   2. registerSegment({ owner, zone, get })
 *   3. requestRender() whenever your data changes
 *
 * Zones: top_left | top_right | bottom_left | bottom_right. Colour your own
 * text; the host draws the separators. Return null from get() to hide.
 *
 * Load it alongside anything else that uses the host, e.g.:
 *   pi -e extensions/coms.ts -e extensions/example-border-segment.ts
 *
 * editor-host.ts does not need to be on the command line — importing it is
 * enough; the first client to call installEditorHost() takes the editor slot.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { getEditorHost, installEditorHost } from "./editor-host.ts";

function gitBranch(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export default function (pi: ExtensionAPI) {
  const host = getEditorHost();

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    // Ensure the shared editor host owns the editor (no-op if already taken).
    installEditorHost(ctx);

    let branch = gitBranch();
    host.registerSegment({
      owner: "example-branch",
      zone: "top_right",
      get: () => (branch ? ctx.ui.theme.fg("dim", `${branch}`) : null),
    });

    // Refresh occasionally so the branch stays current after a checkout.
    const timer = setInterval(() => {
      const next = gitBranch();
      if (next !== branch) {
        branch = next;
        host.requestRender();
      }
    }, 5000);

    pi.on("session_shutdown", async () => {
      clearInterval(timer);
      host.unregisterOwner("example-branch");
    });
  });
}
