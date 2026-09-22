// Warm and cold respawn shapes (ticket 16).
//
// Boots pi --mode rpc in scratch dirs with this checkout installed as a
// local-path package, then drives both respawn paths and asserts what lands in
// the fresh session:
//
//   cold (respawn_cold)  -> the note is a custom message (in LLM context,
//                           rendered as a note) and NO user message is
//                           injected, so nothing looks like a pending prompt
//   warm (/coms-respawn) -> the kickoff arrives as a real user message (the
//                           trigger a model answers)
//
// With a model configured (the dev machine) the warm path is also asserted to
// run a turn on its own. CI has no model, where pi accepts a prompt but cannot
// start a turn, so that one check is reported as skipped there and the rest
// still run.
//
//   node tests/coms-respawn.mjs
//
// Exit code 0 = every case passed.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const REPO = path.resolve(import.meta.dirname, "..");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "coms-respawn-"));
const AGENT = path.join(ROOT, "agent");
const XDG = path.join(ROOT, "xdg");
const COMS = path.join(ROOT, "coms");
const CWD = path.join(ROOT, "cwd");
const NAME = "check-respawn";
const POOL = "check-respawn";

process.env.PI_COMS_DIR = COMS;
const coms = await import(pathToFileURL(path.join(REPO, "extensions/coms.ts")).href);

let passed = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

fs.mkdirSync(CWD, { recursive: true });
fs.mkdirSync(AGENT, { recursive: true });
fs.writeFileSync(path.join(AGENT, "settings.json"), JSON.stringify({ packages: [{ source: REPO }] }, null, 2) + "\n");

let stderr = "";
const child = spawn("pi", ["--mode", "rpc", "--cname", NAME, "--project", POOL], {
  cwd: CWD,
  env: { ...process.env, PI_CODING_AGENT_DIR: AGENT, XDG_CONFIG_HOME: XDG, PI_COMS_DIR: COMS },
  stdio: ["pipe", "pipe", "pipe"],
});

const pending = new Map();
let seq = 0;
child.stderr.on("data", (d) => (stderr += d.toString()));
child.on("error", (err) => (stderr += `SPAWN ERROR ${err.message}`));
child.stdout.on("data", (d) => {
  for (const line of d.toString().split("\n")) {
    if (!line.trim()) continue;
    let j = null;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.type === "response" && j.id && pending.has(j.id)) {
      const waiter = pending.get(j.id);
      pending.delete(j.id);
      clearTimeout(waiter.timer);
      waiter.resolve(j);
    }
  }
});

function rpc(cmd, timeoutMs = 10_000) {
  const id = `h${++seq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`rpc timeout: ${cmd.type}`));
    }, timeoutMs);
    pending.set(id, { resolve, timer });
    child.stdin.write(JSON.stringify({ ...cmd, id }) + "\n");
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = async () => (await rpc({ type: "get_state" })).data ?? {};
const messages = async () => (await rpc({ type: "get_messages" })).data?.messages ?? [];
function textOf(m) {
  const c = m?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .filter((x) => x && x.type === "text")
      .map((x) => x.text)
      .join(" ");
  }
  return "";
}

/** Registry entry for our name in the scratch pool, optionally not this coms session. */
async function waitForEntry(notSessionId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = coms
      .readAllRegistryEntries(POOL)
      .find((e) => e.name === NAME && (!notSessionId || e.session_id !== notSessionId));
    if (hit) return hit;
    await sleep(250);
  }
  return null;
}

try {
  let boot = null;
  const bootDeadline = Date.now() + 25_000;
  while (Date.now() < bootDeadline) {
    try {
      boot = await state();
      if (boot.sessionId) break;
    } catch {
      /* retry */
    }
    await sleep(300);
  }
  check("boot: rpc answers get_state", !!boot?.sessionId, stderr.slice(0, 300));

  // Can this environment run a turn at all? A plain prompt is the probe: with
  // model credentials a turn starts; without them pi accepts the prompt but
  // never runs it (and sendUserMessage from the respawn path cannot deliver
  // either). The warm assertions below only make sense when turns work.
  let modelWorks = false;
  if (boot?.sessionId) {
    await rpc({ type: "prompt", message: "reply with ok" }).catch(() => undefined);
    const probeDeadline = Date.now() + 10_000;
    while (Date.now() < probeDeadline) {
      const s = await state();
      if (s.isStreaming || (s.messageCount ?? 0) > 1) {
        modelWorks = true;
        break;
      }
      await sleep(300);
    }
    if (modelWorks) {
      // The cold path's guardrail skips a busy peer; let the probe turn finish.
      const idleDeadline = Date.now() + 30_000;
      while (Date.now() < idleDeadline) {
        const s = await state();
        if (!s.isStreaming) break;
        await sleep(300);
      }
      await sleep(800);
    }
  }

  const first = await waitForEntry(null);
  check("boot: session registered in the scratch pool", !!first, JSON.stringify(coms.readAllRegistryEntries(POOL)).slice(0, 300));

  if (first) {
    // ── cold first (the warm kickoff turn could keep the peer busy) ─────────
    const env = {
      type: "respawn_cold",
      msg_id: "cold-1",
      sender_session: "harness",
      sender_endpoint: path.join(ROOT, "harness.sock"),
      hops: 0,
      timestamp: new Date().toISOString(),
      note: "Cold note from the harness.",
      sender_name: "harness",
      sender_cwd: ROOT,
    };
    const ack = await coms.sendEnvelope(first.endpoint, env).catch((err) => ({ error: String(err) }));
    check("cold: envelope acked as queued", ack?.type === "ack" && ack?.queued === true, JSON.stringify(ack));

    const afterCold = await waitForEntry(first.session_id);
    check("cold: a fresh session replaced the old one", !!afterCold, stderr.slice(0, 300));
    if (afterCold) {
      const msgs = await messages();
      check(
        "cold: note arrives as a custom message",
        msgs.some((m) => m.customType === "coms-respawn-note" && textOf(m).includes("Cold note from the harness")),
        JSON.stringify(msgs).slice(0, 500),
      );
      check(
        "cold: no kickoff user message is injected",
        !msgs.some((m) => m.role === "user"),
        JSON.stringify(msgs).slice(0, 500),
      );

      // ── warm ──────────────────────────────────────────────────────────────
      // Fire and forget: the command replaces the session while handling the
      // prompt, so its RPC response may never arrive. The entry change below
      // is the real observable.
      child.stdin.write(JSON.stringify({ type: "prompt", message: "/coms-respawn", id: "warm1" }) + "\n");
      const afterWarm = await waitForEntry(afterCold.session_id);
      check("warm: a fresh session replaced the previous one", !!afterWarm, stderr.slice(0, 300));
      if (afterWarm) {
        const msgs = await messages();
        if (modelWorks) {
          check(
            "warm: kickoff arrives as a user message",
            msgs.some((m) => m.role === "user" && textOf(m).includes("You respawned to shed stale context")),
            JSON.stringify(msgs).slice(0, 500),
          );
        } else {
          console.log("  skip warm delivery check (this environment cannot run turns: no model credentials)");
        }
        check(
          "warm: no note-style custom message",
          !msgs.some((m) => m.customType === "coms-respawn-note"),
          JSON.stringify(msgs).slice(0, 300),
        );
        if (modelWorks) {
          let turned = false;
          const turnDeadline = Date.now() + 25_000;
          while (Date.now() < turnDeadline) {
            const s = await state();
            if (s.isStreaming || (s.messageCount ?? 0) > 1) {
              turned = true;
              break;
            }
            await sleep(400);
          }
          check("warm: the fresh session runs a turn on its own", turned, `messageCount=${(await state()).messageCount}`);
        } else {
          console.log("  skip warm turn check (this environment cannot run turns: no model credentials)");
        }
      }
    }
  }
} finally {
  try {
    child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
}

console.log(`\n${passed} checks passed, ${failures.length} failed`);
console.log(`scratch: ${ROOT}`);
if (failures.length > 0) {
  console.log(`failures:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
