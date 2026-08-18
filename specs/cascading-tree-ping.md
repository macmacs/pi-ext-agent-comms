# Cascading Tree Ping

## Problem

The current `refreshPool()` ping runs independently on every agent on a 10s timer,
pinging all display pool members. This is O(N²) socket connections per cycle and is
architecturally mismatched with the relay tree introduced for grandchild visibility.

Specifically: relayed cards (grandchildren+) have no registry entry in the ancestor's
display pool, so they never get pinged, their `staleCount` climbs, and they are evicted
after ~70s. The current workaround (keepalive broadcasts + `relayedAt` TTL) is a patch
on top of a design that no longer fits.

## Goal

Replace the flat per-agent ping cycle with a single cascading tree ping initiated from
the root, where each node fans the ping down to its children, collects responses, and
returns an aggregated subtree snapshot. Every node ends up with fresh data for its full
subtree from a single coordinated cycle.

## Topology assumptions

- **Root**: agent with no parent (`!process.env.PI_PARENT_SESSION`)
- **Children**: agents registered in parent's pool via `--project <parentName>`
- **Siblings**: agents sharing the same parent pool (same `--project` value)
- **Naming encodes hierarchy**: `amber-basin-grove` is a grandchild of `amber`

In a flat peer setup (no tree, all agents are roots) each agent runs its own cascade
which terminates immediately (no children). Behaviour is equivalent to current flat ping.

## New envelope types

### `tree_ping`
Sent by a node to each of its direct children.

```ts
interface TreePingEnvelope extends Envelope {
  type: "tree_ping";
  request_id: string;       // shared across one full cascade cycle
  max_depth: number;        // remaining depth budget (decrements each hop)
}
```

### `tree_pong`
Response from a child carrying its own card plus its subtree.

```ts
interface TreePongNode {
  session_id: string;
  card: AgentCard;
  children: TreePongNode[];  // recursively populated
}

interface TreePong {
  type: "tree_pong";
  request_id: string;
  node: TreePongNode;
}
```

## Protocol

1. **Root** sends `tree_ping` to each direct child (registry entries in its display pool
   whose names are direct children by naming convention).
2. **Each recipient** fans `tree_ping` (decremented `max_depth`) to ITS own direct
   children in parallel, waits for their `tree_pong` responses with a per-hop timeout
   (suggested: 3s), then responds to its caller with a `tree_pong` containing its own
   card and all collected child nodes.
3. **Nodes that receive no child responses** (leaf nodes or timed-out children) respond
   immediately with an empty `children` array.
4. **Root** receives one `tree_pong` per direct child, walks the combined tree, and
   populates `peerCards` for all descendants.
5. **Intermediate nodes** also update their own `peerCards` from the subtree data they
   receive before responding upstream — so every node gets a fresh picture of its full
   subtree, not just the root.

## Lateral (sibling) pings

Siblings are agents sharing the same parent pool. They need lateral pings for pool
widget rendering and `@`-mention completion — these are not captured by the vertical
tree cascade.

Siblings continue to ping each other directly as today (standard `ping`/`pong`
envelopes). This is unchanged from the current design.

## Timer ownership

- **Root only** runs the cascade ping timer (every `PING_INTERVAL_MS = 10s`).
- **Non-root agents** do NOT run an independent `refreshPool` timer. They respond to
  incoming `tree_ping` requests reactively.
- **Sibling ping** timer runs on every non-root agent for lateral awareness (same 10s
  cadence, but only pings siblings — agents in the same parent pool that are NOT
  parent or child).
- **Root detection**: `!process.env.PI_PARENT_SESSION`

## Timeout and partial responses

- Per-hop timeout: 3s. If a child doesn't respond within 3s, it contributes an empty
  node (no children) and is marked stale.
- Total cascade latency upper bound: `max_depth × 3s`. At `max_depth = 5` that's 15s,
  well within the 10s ping interval for typical trees (depth ≤ 3).
- Stale detection: a node absent from the cascade response for N consecutive cycles
  (suggested N=3) is evicted from peerCards.

## peerCards changes

- `relay_depth` field on stored cards is no longer needed — the cascade gives the root
  full tree data directly. Remove as part of this work.
- `staleCount` applies to all cards uniformly — no special-casing for relayed vs direct.
  If a node doesn't appear in the cascade response, its staleCount increments. At
  `staleCount > (N=3)` it is evicted.
- `relayedAt` and the `RELAY_TTL_MS` keepalive-broadcast workaround are removed.

## Interaction with relay events

Relay events (join/leave status broadcasts) are kept unchanged. They provide **immediate**
visibility when a new subagent appears or shuts down — before the next ping cycle fires.
The cascade ping provides **periodic freshness** (liveness, context %, running state).
These are complementary:

- Event arrives → card appears in peerCards immediately
- Cascade fires → card is confirmed alive and data is refreshed
- No event + absent from cascade for N cycles → card is evicted

## Keepalive broadcasts

`broadcastStatus(agentRunning)` added to the keepalive timer (as of the relay events
PR) can be removed once the cascade ping is in place — it was a workaround to refresh
relayed cards. The cascade ping handles freshness.

## Changes required

**`coms.ts`**
- Add `tree_ping` / `tree_pong` envelope types
- Add `handleTreePing(socket, env)` — fan out, await children, aggregate, respond
- Replace `refreshPool()` with:
  - `runCascadePing()` (root only) — sends `tree_ping` to direct children, walks
    combined `TreePong` result, updates peerCards for all descendants
  - `refreshSiblings()` (non-root) — pings only sibling entries in display pool
- Root detection in `session_start` to choose which timer to start
- Remove `relay_depth`, `relayedAt`, `RELAY_TTL_MS` from peerCards and stale loop
- Remove `broadcastStatus(agentRunning)` from keepalive timer

**No changes to `subagent-widget.ts`**

## Out of scope

- Bit-packed subtree health representation (premature at typical tree sizes of 5-20 nodes)
- Diff-only card updates (premature optimisation)
- Cross-machine trees (unix sockets are local only; out of scope for now)
