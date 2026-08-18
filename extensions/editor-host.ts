/**
 * editor-host — a shared owner of the input editor's border chrome.
 *
 * Only ONE extension may own the editor (setEditorComponent is a single slot).
 * This extension takes that slot and turns it into a multi-tenant surface:
 * other extensions register border *segments* (rendering) and *key handlers*
 * (input) into a plain shared object on globalThis. The host composes the
 * segments onto the top/bottom border lines and routes keystrokes through the
 * registered handlers before falling back to normal editor behaviour.
 *
 * Load-order independent: whoever touches globalThis.__piEditorHost first
 * creates it. Clients may register before the host loads; the host renders
 * whatever it finds. If the host never loads, registrations are simply inert.
 *
 * Client contract (see getEditorHost below):
 *
 *   const host = getEditorHost();
 *   const off = host.registerSegment({
 *     owner: "coms", zone: "bottom_right", order: 0,
 *     get: () => `@${name}`,
 *   });
 *   const offKeys = host.registerKeyHandler({
 *     owner: "coms", order: 0,
 *     handle: (data, api) => { ... return true if consumed ... },
 *   });
 *   host.requestRender(); // repaint when your data changes
 *   // call off() / offKeys() to remove.
 *
 * Usage: pi -e extensions/editor-host.ts (load before/with clients)
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { CustomEditor } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

// ━━ Shared contract (kept minimal & stable across host/client boundary) ━━━━

export type EditorHostZone =
  | "top_left"
  | "top_right"
  | "bottom_left"
  | "bottom_right";

export interface EditorHostSegment {
  owner: string;
  zone: EditorHostZone;
  /** Lower renders first (leftmost / innermost). Default 0. */
  order?: number;
  /** Read live on every render. Return null/empty to hide. Colour it yourself. */
  get: () => string | null | undefined;
}

export interface EditorHostKeyApi {
  isShowingAutocomplete(): boolean;
  requestRender(): void;
}

export interface EditorHostKeyHandler {
  owner: string;
  /** Lower runs first. Default 0. */
  order?: number;
  /** Return true to consume the key and stop the chain. */
  handle: (data: string, api: EditorHostKeyApi) => boolean;
}

/** Transform the fully-composed editor lines. Applied in registration order. */
export interface EditorHostDecorator {
  owner: string;
  order?: number;
  decorate: (lines: string[]) => string[];
}

export interface EditorHost {
  version: number;
  segments: EditorHostSegment[];
  keyHandlers: EditorHostKeyHandler[];
  decorators: EditorHostDecorator[];
  /** True once some extension has taken the editor slot. */
  installed: boolean;
  /** Set by the host once it owns the editor; no-op until then. */
  requestRender: () => void;
  /** Live proxy to the owning editor; false until installed. */
  isShowingAutocomplete: () => boolean;
  registerSegment(seg: EditorHostSegment): () => void;
  registerKeyHandler(h: EditorHostKeyHandler): () => void;
  registerDecorator(d: EditorHostDecorator): () => void;
  /** Remove everything a given owner registered. */
  unregisterOwner(owner: string): void;
}

const HOST_KEY = "__piEditorHost";

/**
 * Get (creating if needed) the shared host registry. Safe to call from any
 * extension regardless of load order. Under jiti each extension has its own
 * module cache, so the registry MUST live on globalThis, not module scope.
 */
export function getEditorHost(): EditorHost {
  const g = globalThis as unknown as Record<string, EditorHost | undefined>;
  let host = g[HOST_KEY];
  if (!host) {
    const h: EditorHost = {
      version: 1,
      segments: [],
      keyHandlers: [],
      decorators: [],
      installed: false,
      requestRender: () => {},
      isShowingAutocomplete: () => false,
      registerSegment(seg) {
        h.segments.push(seg);
        h.requestRender();
        return () => {
          h.segments = h.segments.filter((s) => s !== seg);
          h.requestRender();
        };
      },
      registerKeyHandler(handler) {
        h.keyHandlers.push(handler);
        return () => {
          h.keyHandlers = h.keyHandlers.filter((x) => x !== handler);
        };
      },
      registerDecorator(dec) {
        h.decorators.push(dec);
        h.requestRender();
        return () => {
          h.decorators = h.decorators.filter((x) => x !== dec);
          h.requestRender();
        };
      },
      unregisterOwner(owner) {
        h.segments = h.segments.filter((s) => s.owner !== owner);
        h.keyHandlers = h.keyHandlers.filter((x) => x.owner !== owner);
        h.decorators = h.decorators.filter((x) => x.owner !== owner);
        h.requestRender();
      },
    };
    g[HOST_KEY] = h;
    host = h;
  }
  return host;
}

// ━━ The editor that owns the border chrome ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const byOrder = <T extends { order?: number }>(a: T, b: T) =>
  (a.order ?? 0) - (b.order ?? 0);

class HostEditor extends CustomEditor {
  constructor(
    private _tui: any,
    theme: any,
    keybindings: any,
    private host: EditorHost,
  ) {
    super(_tui, theme, keybindings);
  }

  override handleInput(data: string): void {
    const api: EditorHostKeyApi = {
      isShowingAutocomplete: () => this.isShowingAutocomplete(),
      requestRender: () => this._tui.requestRender(),
    };
    for (const h of [...this.host.keyHandlers].sort(byOrder)) {
      try {
        if (h.handle(data, api)) return;
      } catch {
        /* a misbehaving client must not break input */
      }
    }
    super.handleInput(data);
  }

  /** Detect the border's ansi style prefix so our dashes match its colour. */
  private borderDash(line: string): string {
    const idx = line.indexOf("─");
    const style = idx > 0 ? line.slice(0, idx) : "";
    return style ? `${style}─\x1b[0m` : "─";
  }

  private segvalues(zone: EditorHostZone): string[] {
    return this.host.segments
      .filter((s) => s.zone === zone)
      .sort(byOrder)
      .map((s) => {
        try {
          return s.get();
        } catch {
          return null;
        }
      })
      .filter((v): v is string => !!v && v.length > 0);
  }

  private composeLine(line: string, width: number, side: "top" | "bottom"): string {
    const d = this.borderDash(line);
    const leftSegs = this.segvalues(`${side}_left` as EditorHostZone);
    const rightSegs = this.segvalues(`${side}_right` as EditorHostZone);
    const left = leftSegs.length ? `${d} ${leftSegs.join(` ${d} `)} ` : "";
    const right = rightSegs.length ? ` ${rightSegs.join(` ${d} `)} ${d}` : "";
    if (!left && !right) return line;
    const lw = visibleWidth(left);
    const rw = visibleWidth(right);
    const mid = truncateToWidth(line, Math.max(0, width - lw - rw), "");
    return left + mid + right;
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    if (lines.length > 0) {
      lines[0] = this.composeLine(lines[0]!, width, "top");
      const last = lines.length - 1;
      if (last !== 0) lines[last] = this.composeLine(lines[last]!, width, "bottom");
    }
    let out = lines;
    for (const dec of [...this.host.decorators].sort(byOrder)) {
      try {
        out = dec.decorate(out);
      } catch {
        /* ignore */
      }
    }
    return out;
  }
}

// ━━ Installer (idempotent) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Take the editor slot for the host, if nobody has yet. Safe to call from any
 * client's session_start — first caller wins, later calls are no-ops. Because
 * importing this module gives you the factory, a client can install the chrome
 * itself without editor-host.ts being passed via -e.
 */
export function installEditorHost(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  const host = getEditorHost();
  if (host.installed) return;
  host.installed = true;
  ctx.ui.setEditorComponent((tui, theme, kb) => {
    const editor = new HostEditor(tui, theme, kb, host);
    host.requestRender = () => tui.requestRender();
    host.isShowingAutocomplete = () => editor.isShowingAutocomplete();
    return editor;
  });
}

/** Release the editor slot and reset live proxies. */
export function uninstallEditorHost(ctx: ExtensionContext): void {
  const host = getEditorHost();
  host.installed = false;
  host.requestRender = () => {};
  host.isShowingAutocomplete = () => false;
  try {
    ctx.ui?.setEditorComponent(undefined);
  } catch {
    /* ignore */
  }
}

// ━━ Default export ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export default function (pi: ExtensionAPI) {
  getEditorHost();

  pi.on("session_start", async (_event, ctx) => {
    installEditorHost(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    uninstallEditorHost(ctx);
  });
}
