// Live transport round-trip check (ticket 14).
//
// Boots one real `pi --mode rpc` session in scratch dirs (local-path package
// install of this checkout, scratch PI_CODING_AGENT_DIR / XDG_CONFIG_HOME /
// PI_COMS_DIR), waits for its registry entry, then exercises the transport:
//
//   - inbound: harness -> live session, `ping` envelope, expect a `pong` card
//   - malformed: raw line -> live session, expect a `nack`
//   - outbound: exported sendEnvelope -> a harness-owned socket, expect the
//     exact framed JSON line and an `ack` reply
//
// No model, no LLM turn, nothing real touched. RPC mode has no direct tool
// call, so this stops at the transport (see the ticket).
//
//   node tests/coms-roundtrip.mjs
//
// Exit code 0 = every case passed.

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const REPO = path.resolve(import.meta.dirname, "..");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "coms-roundtrip-"));
const AGENT = path.join(ROOT, "agent");
const XDG = path.join(ROOT, "xdg");
const COMS = path.join(ROOT, "coms");
const CWD = path.join(ROOT, "cwd");
const NAME = "check-peer";
const POOL = "check-pool";

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

function ping(msgId) {
  return {
    type: "ping",
    msg_id: msgId,
    sender_session: "harness-session",
    sender_endpoint: path.join(ROOT, "harness.sock"),
    hops: 0,
    timestamp: new Date().toISOString(),
  };
}

function rawDial(endpoint, line) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ path: endpoint });
    let buf = "";
    const timer = setTimeout(() => {
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(null);
    }, 5000);
    sock.on("connect", () => sock.write(line + "\n"));
    sock.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(timer);
        try {
          sock.end();
        } catch {
          /* ignore */
        }
        resolve(buf.slice(0, nl));
      }
    });
    sock.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

async function waitForEntry(pool, name, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = coms.readAllRegistryEntries(pool).find((e) => e.name === name);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

fs.mkdirSync(CWD, { recursive: true });
fs.mkdirSync(AGENT, { recursive: true });
fs.writeFileSync(path.join(AGENT, "settings.json"), JSON.stringify({ packages: [{ source: REPO }] }, null, 2) + "\n");

let stdout = "";
let stderr = "";
const child = spawn("pi", ["--mode", "rpc", "--cname", NAME, "--project", POOL], {
  cwd: CWD,
  env: { ...process.env, PI_CODING_AGENT_DIR: AGENT, XDG_CONFIG_HOME: XDG, PI_COMS_DIR: COMS },
  stdio: ["pipe", "pipe", "pipe"],
});
child.stdout.on("data", (d) => (stdout += d.toString()));
child.stderr.on("data", (d) => (stderr += d.toString()));
child.on("error", (err) => (stderr += `SPAWN ERROR ${err.message}`));

let server = null;
try {
  const entry = await waitForEntry(POOL, NAME);
  check(
    "live: session registers in the project pool",
    !!entry,
    `stderr: ${stderr.slice(0, 300)} stdout: ${stdout.slice(0, 300)}`,
  );

  if (entry) {
    check("live: registry entry keeps the requested name", entry.name === NAME, entry.name);
    check("live: registry pid is the pi process", entry.pid === child.pid, `${entry.pid} vs ${child.pid}`);
    check(
      "live: endpoint is the session socket",
      entry.endpoint === path.join(COMS, "sockets", `${entry.session_id}.sock`),
      entry.endpoint,
    );
    check("live: socket file exists", fs.existsSync(entry.endpoint), entry.endpoint);
    check("live: registry cwd is the spawn cwd", entry.cwd === CWD, entry.cwd);

    const pong = await coms.sendEnvelope(entry.endpoint, ping("m1")).catch((err) => ({ error: String(err) }));
    check("inbound: ping answers with a pong", pong && pong.type === "pong" && pong.msg_id === "m1", JSON.stringify(pong));
    check("inbound: pong carries the session card", pong && pong.agent_card?.name === NAME, JSON.stringify(pong?.agent_card));

    const nackLine = await rawDial(entry.endpoint, "{not json");
    let nack = null;
    try {
      nack = JSON.parse(nackLine);
    } catch {
      /* leave null */
    }
    check(
      "inbound: malformed line is nacked",
      nack && nack.type === "nack" && nack.error === "malformed envelope",
      String(nackLine),
    );
  }

  // Outbound: the same send path a live peer would use, aimed at our socket.
  const fakeDir = path.join(ROOT, "fake");
  fs.mkdirSync(fakeDir, { recursive: true });
  const fakeEndpoint = path.join(fakeDir, "fake.sock");
  let seen = null;
  const gotLine = new Promise((resolve) => {
    server = net.createServer((sock) => {
      let buf = "";
      sock.on("data", (d) => {
        buf += d.toString();
        const nl = buf.indexOf("\n");
        if (nl >= 0) {
          seen = buf.slice(0, nl);
          sock.write(JSON.stringify({ type: "ack", msg_id: "m2" }) + "\n");
          sock.end();
          resolve();
        }
      });
    });
    server.once("error", () => resolve());
    server.listen(fakeEndpoint, () => undefined);
  });
  await new Promise((r) => setTimeout(r, 250));
  const ack = await coms.sendEnvelope(fakeEndpoint, ping("m2")).catch((err) => ({ error: String(err) }));
  await gotLine;
  check("outbound: sendEnvelope reaches the peer socket", ack && ack.type === "ack" && ack.msg_id === "m2", JSON.stringify(ack));
  let framed = null;
  try {
    framed = JSON.parse(seen);
  } catch {
    /* leave null */
  }
  check(
    "outbound: one JSON line with the envelope fields",
    framed &&
      framed.type === "ping" &&
      framed.msg_id === "m2" &&
      framed.sender_session === "harness-session" &&
      framed.hops === 0,
    String(seen),
  );

  const dead = await coms
    .sendEnvelope(path.join(COMS, "sockets", "no-such.sock"), ping("m3"))
    .then(() => null)
    .catch((err) => err);
  check("negative: dead endpoint rejects", !!dead, String(dead));
  check("negative: missing pool has no entries", coms.readAllRegistryEntries("no-such-pool").length === 0);
  check("negative: unknown peer is not registered", !coms.readAllRegistryEntries(POOL).some((e) => e.name === "ghost"));
} finally {
  try {
    child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  try {
    server?.close();
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
