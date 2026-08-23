# Respawn mechanism facts: what newSession does to a pi session

Research for wayfinder ticket "Respawn mechanism facts: what newSession does to a pi session".

## Answer in one paragraph

Respawn is `ctx.newSession({ parentSession, setup, withSession })`, called from an extension **command handler** after `ctx.waitForIdle()`. The identity goes into the new session via `setup` (append a user message to the new SessionManager) and the kickoff / trigger note via `withSession` (`ctx.sendUserMessage(...)`). A **tool** cannot drive session replacement directly: the proven pattern is the tool queues an extension command via `pi.sendUserMessage("/cmd", { deliverAs: "followUp" })` and the command handler does the work (see `examples/extensions/reload-runtime.ts`).

## Facts with sources

All sources under `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/`.

### The primitive: ctx.newSession

`docs/extensions.md` section "ctx.newSession(options?)":

```typescript
const parentSession = ctx.sessionManager.getSessionFile();
const kickoff = "Continue in the replacement session";

const result = await ctx.newSession({
  parentSession,
  setup: async (sm) => {
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Context from previous session..." }],
      timestamp: Date.now(),
    });
  },
  withSession: async (ctx) => {
    // Use only the replacement-session ctx here.
    await ctx.sendUserMessage(kickoff);
  },
});

if (result.cancelled) {
  // An extension cancelled the new session
}
```

- `parentSession`: parent session file recorded in the new session header.
- `setup`: mutate the new session's `SessionManager` before `withSession` runs. This is the identity re-injection point: append the role as a user message so it is the first message of the fresh session.
- `withSession`: runs post-switch work against a fresh `ReplacedSessionContext`, which has `sendMessage()` and `sendUserMessage()` helpers bound to the replacement session. This is the trigger-note injection point.
- `result.cancelled`: true when a `session_before_switch` handler cancelled.

### Lifecycle on session replacement

`docs/extensions.md` "Session replacement lifecycle and footguns" and the lifecycle diagram:

```
/new (new session) or /resume (switch session)
  ├─► session_before_switch (can cancel)
  ├─► session_shutdown          (old extension instance)
  ├─► session_start { reason: "new" | "resume", previousSessionFile? }
  └─► resources_discover { reason: "startup" }
```

- Extensions are **reloaded and rebound** for the new session; the new extension instance receives `session_start`. `withSession` still executes in the original closure, not the new instance.
- Footguns: captured old `pi` / old command `ctx` objects are stale after replacement and throw; captured `ctx.sessionManager` is the old manager; re-subscribe event listeners after replacement. Only plain data (strings, ids, serialized config) survives cleanly.
- `session_before_switch` can cancel via `return { cancel: true }` (`event.reason` is `"new"` or `"resume"`).
- SDK level (`docs/sdk.md`): `AgentSessionRuntime.newSession()` owns replacement; `runtime.session` changes; extensions must be re-bound via `runtime.session.bindExtensions(...)`.

### System prompt across sessions

- The system prompt is regenerated for the new session from the same config (settings, templates, AGENTS.md): same config yields the same system prompt. `state.systemPrompt` is readable (`docs/sdk.md`).
- A pinned override is possible via `ResourceLoader` `systemPromptOverride` (`docs/sdk.md`), so a role can live in the system prompt if desired.

### Tool context limitation and the proven pattern

`docs/extensions.md` "ctx.reload()" section:

- Tools run with `ExtensionContext` and cannot call `ctx.reload()` directly; the same restriction applies to session replacement (tool execute runs mid-turn).
- The documented pattern (`examples/extensions/reload-runtime.ts`): register a command that does the work (`await ctx.waitForIdle()` then act), and register a tool that queues it: `pi.sendUserMessage("/reload-runtime", { deliverAs: "followUp" })`.
- `ctx.waitForIdle()` waits for the agent to fully settle, including retries and queued continuations.

### RPC / headless modes

`docs/rpc.md`:

- `new_session` command exists, with optional `parentSession`; response `{cancelled}` mirrors the extension cancel path.
- `switch_session { sessionPath }`, `get_session_state` (exposes `sessionFile`, `sessionId`, `sessionName`).
- So a respawn can also be driven externally via RPC, and `--mode json` / `--mode rpc` peers are not excluded from the mechanism.

### Message injection primitives

`docs/extensions.md`:

- `pi.sendMessage(customMessage, { deliverAs: "steer" | "followUp" | "nextTurn", triggerTurn })` - custom messages participate in LLM context.
- `pi.sendUserMessage(text, { deliverAs, expandPromptTemplates })` - a real user message; always triggers a turn; required `deliverAs` when streaming.

## Consequences for the respawn design

1. The whole respawn = `ctx.newSession` with identity in `setup` and trigger note in `withSession`.
2. Tool `coms_respawn` must follow the queue-a-command pattern; the command handler is the only safe place to call `newSession`.
3. Everything in coms.ts tied to the old session (socket, registry entry, widgets) must be torn down in `session_shutdown` and rebuilt in `session_start` - coms already does exactly this.
4. The old session file stays on disk; the new session has a fresh `sessionId` and file.
