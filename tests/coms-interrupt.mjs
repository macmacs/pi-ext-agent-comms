// Inbox and coms_interrupt, end to end.
//
// Boots pi --mode rpc in scratch dirs with this checkout installed as a
// local-path package. The model is a fake OpenAI-compatible server run by this
// harness, so turns are real and no credentials are needed. Its replies are
// scripted by the last message it sees:
//
//   "start"      -> a bash tool call: sleep 30   (a long busy turn)
//   "short"      -> a bash tool call: sleep 2    (a short busy turn)
//   "INTERRUPT"  -> text PONG
//   anything else -> text ok
//
// Cases:
//   idle interrupt, no prompt -> notice stored, no turn, nothing dropped
//   busy peer, 2 queued msgs   -> interrupt stops the turn, drops both, and
//                                 only the interrupt prompt runs afterwards
//   busy peer, 1 queued msg    -> without an interrupt it is delivered once
//                                 the turn settles (the inbox still pumps)
//   hop limit                  -> nack
//
//   node tests/coms-interrupt.mjs
//
// Exit code 0 = every case passed.

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const REPO = path.resolve(import.meta.dirname, "..");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "coms-interrupt-"));
const AGENT = path.join(ROOT, "agent");
const XDG = path.join(ROOT, "xdg");
const COMS = path.join(ROOT, "coms");
const CWD = path.join(ROOT, "cwd");
const NAME = "check-interrupt";
const POOL = "check-interrupt";

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── fake model ───────────────────────────────────────────────────────────────
const requests = []; // last-message text of every model request, in order
function lastText(body) {
  const msgs = body?.messages ?? [];
  const last = msgs[msgs.length - 1];
  if (!last) return "";
  if (last.role === "tool") return "<tool>";
  const c = last.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => x?.text ?? "").join(" ");
  return "";
}
function chunk(delta, finish = null) {
  return `data: ${JSON.stringify({
    id: "fake",
    object: "chat.completion.chunk",
    created: 0,
    model: "fake-1",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}
let callSeq = 0;
const fake = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      /* empty */
    }
    const text = lastText(body);
    requests.push(text);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const tool = (cmd) => {
      res.write(
        chunk({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `call_${++callSeq}`,
              type: "function",
              function: { name: "bash", arguments: JSON.stringify({ command: cmd }) },
            },
          ],
        }),
      );
      res.write(chunk({}, "tool_calls"));
    };
    if (text === "<tool>") {
      res.write(chunk({ role: "assistant", content: "ok" }));
      res.write(chunk({}, "stop"));
    } else if (text.includes("INTERRUPT")) {
      res.write(chunk({ role: "assistant", content: "PONG" }));
      res.write(chunk({}, "stop"));
    } else if (/\bstart\b/.test(text)) {
      tool("sleep 30");
    } else if (/\bshort\b/.test(text)) {
      tool("sleep 2");
    } else {
      res.write(chunk({ role: "assistant", content: "ok" }));
      res.write(chunk({}, "stop"));
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const PORT = fake.address().port;

// ── scratch pi ───────────────────────────────────────────────────────────────
fs.mkdirSync(CWD, { recursive: true });
fs.mkdirSync(AGENT, { recursive: true });
fs.writeFileSync(path.join(AGENT, "settings.json"), JSON.stringify({ packages: [{ source: REPO }] }, null, 2) + "\n");
fs.writeFileSync(
  path.join(AGENT, "models.json"),
  JSON.stringify(
    {
      providers: {
        fake: {
          baseUrl: `http://127.0.0.1:${PORT}/v1`,
          api: "openai-completions",
          apiKey: "fake",
          models: [{ id: "fake-1" }],
        },
      },
    },
    null,
    2,
  ) + "\n",
);

let stderr = "";
const child = spawn("pi", ["--mode", "rpc", "--model", "fake/fake-1", "--cname", NAME, "--project", POOL], {
  cwd: CWD,
  env: { ...process.env, PI_CODING_AGENT_DIR: AGENT, XDG_CONFIG_HOME: XDG, PI_COMS_DIR: COMS },
  stdio: ["pipe", "pipe", "pipe"],
});
const pending = new Map();
let seq = 0;
child.stderr.on("data", (d) => (stderr += d.toString()));
child.on("error", (err) => (stderr += `SPAWN ERROR ${err.message}`));
let outBuf = "";
child.stdout.on("data", (d) => {
  outBuf += d.toString();
  let nl;
  while ((nl = outBuf.indexOf("\n")) >= 0) {
    const line = outBuf.slice(0, nl);
    outBuf = outBuf.slice(nl + 1);
    let j = null;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.type === "response" && j.id && pending.has(j.id)) {
      const w = pending.get(j.id);
      pending.delete(j.id);
      clearTimeout(w.timer);
      w.resolve(j);
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
const state = async () => (await rpc({ type: "get_state" })).data ?? {};
const messages = async () => (await rpc({ type: "get_messages" })).data?.messages ?? [];
function textOf(m) {
  const c = m?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((x) => x?.type === "text").map((x) => x.text).join(" ");
  return "";
}
async function until(fn, timeoutMs, stepMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(stepMs);
  }
  return false;
}
async function waitIdle(timeoutMs = 20_000) {
  return until(async () => !(await state()).isStreaming, timeoutMs);
}

let envSeq = 0;
function envelope(type, extra) {
  return {
    type,
    msg_id: `${type}-${++envSeq}`,
    sender_session: "harness",
    sender_endpoint: path.join(ROOT, "harness.sock"),
    sender_name: "harness",
    sender_cwd: ROOT,
    hops: 0,
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

try {
  const booted = await until(async () => {
    try {
      return !!(await state()).sessionId;
    } catch {
      return false;
    }
  }, 25_000, 300);
  check("boot: rpc answers get_state", booted, stderr.slice(0, 300));
  let entry = null;
  await until(() => (entry = coms.readAllRegistryEntries(POOL).find((e) => e.name === NAME)), 20_000);
  check("boot: registered in the scratch pool", !!entry);
  if (!entry) throw new Error("no registry entry");
  const send = (env) => coms.sendEnvelope(entry.endpoint, env).catch((err) => ({ error: String(err) }));

  // ── idle interrupt, no prompt ──────────────────────────────────────────
  {
    const ack = await send(envelope("interrupt", { prompt: null }));
    check("idle: ack says not aborted, nothing dropped", ack?.type === "ack" && ack.aborted === false && ack.dropped === 0, JSON.stringify(ack));
    await sleep(800);
    const msgs = await messages();
    check(
      "idle: notice stored as coms-inbound",
      msgs.some((m) => m.customType === "coms-inbound" && textOf(m).includes("INTERRUPT from harness") && textOf(m).includes("Wait for new instructions")),
      JSON.stringify(msgs).slice(0, 400),
    );
    check("idle: no model request was made", requests.length === 0, JSON.stringify(requests));
  }

  // ── busy peer with a stale backlog ─────────────────────────────────────
  {
    const t0 = Date.now();
    await rpc({ type: "prompt", message: "start" });
    const busy = await until(() => requests.length >= 1, 10_000);
    check("busy: the long turn started", busy, JSON.stringify(requests));
    await sleep(800); // bash is now sleeping

    const a1 = await send(envelope("prompt", { prompt: "STALE-1" }));
    const a2 = await send(envelope("prompt", { prompt: "STALE-2" }));
    check("busy: queued prompts are acked", a1?.type === "ack" && a2?.type === "ack", JSON.stringify([a1, a2]));

    const ack = await send(envelope("interrupt", { prompt: "INTERRUPT test: say pong" }));
    check("busy: ack says aborted and 2 dropped", ack?.aborted === true && ack?.dropped === 2, JSON.stringify(ack));

    const pong = await until(() => requests.some((r) => r.includes("INTERRUPT")), 15_000);
    check("busy: the interrupt prompt ran", pong, JSON.stringify(requests));
    await waitIdle();
    check("busy: the 30s sleep was cut short", Date.now() - t0 < 25_000, `${Date.now() - t0}ms`);

    // Past one keepalive tick (10s), so the safety-net pump had its chance too.
    await sleep(11_000);
    check("busy: no stale prompt ever reached the model", !requests.some((r) => r.includes("STALE")), JSON.stringify(requests));
    const msgs = await messages();
    check(
      "busy: no stale prompt in the transcript",
      !msgs.some((m) => textOf(m).includes("STALE-1") && !textOf(m).includes("INTERRUPT")),
      JSON.stringify(msgs.map((m) => [m.role, m.customType, textOf(m).slice(0, 60)])),
    );
    const notice = msgs.find((m) => m.customType === "coms-inbound" && textOf(m).includes("INTERRUPT test"));
    check(
      "busy: notice says stopped and lists the dropped ids",
      notice && textOf(notice).includes("stopped your turn") && textOf(notice).includes("Dropped 2 queued"),
      notice ? textOf(notice) : "no notice",
    );
    const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
    check("busy: last reply is PONG", lastAssistant && textOf(lastAssistant).includes("PONG"), JSON.stringify(lastAssistant).slice(0, 300));
  }

  // ── queued message without interrupt still arrives ─────────────────────
  {
    await rpc({ type: "prompt", message: "short" });
    await until(() => requests.some((r) => r === "short"), 10_000);
    await sleep(300);
    const ack = await send(envelope("prompt", { prompt: "QUEUED-1" }));
    check("queue: prompt acked while busy", ack?.type === "ack", JSON.stringify(ack));
    const delivered = await until(() => requests.some((r) => r.includes("QUEUED-1")), 20_000);
    check("queue: delivered once the turn settled", delivered, JSON.stringify(requests));
    const ix = requests.findIndex((r) => r.includes("QUEUED-1"));
    const toolIx = requests.lastIndexOf("<tool>");
    check("queue: delivered after the busy turn, not inside it", ix > toolIx, JSON.stringify(requests));
  }

  // ── hop limit ──────────────────────────────────────────────────────────
  {
    const ack = await send(envelope("interrupt", { hops: 99 }));
    check("hops: over the limit is nacked", ack?.type === "nack" || /hops exceeded/.test(String(ack?.error)), JSON.stringify(ack));
  }
} catch (err) {
  check("harness ran to the end", false, String(err));
} finally {
  try {
    child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  fake.close();
}

console.log(`\n${passed} checks passed, ${failures.length} failed`);
console.log(`scratch: ${ROOT}`);
if (failures.length > 0) {
  console.log(`stderr: ${stderr.slice(0, 600)}`);
  console.log(`failures:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
process.exit(0);
