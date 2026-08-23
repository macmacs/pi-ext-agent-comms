#!/usr/bin/env bash
set -euo pipefail

# Respawn smoke-test helper for two role-file peers (orchestrator + researcher).
#
#   just respawn-demo                      # print the scripted steps
#   just respawn-demo sid researcher       # current registered session id
#   just respawn-demo verify researcher    # verify the outcome on disk

# The role recipe pins --project team, so the demo project is fixed.
PROJECT="team"
ACTION="${1:-plan}"
NAME="${2:-researcher}"
NOTE="respawned for the smoke test"
if [[ $# -ge 3 ]]; then shift 2; NOTE="$*"; fi
REGISTRY_DIR="$HOME/.pi/coms/projects/$PROJECT/agents"

say() { printf '%s\n' "$*"; }

plan() {
  say "Respawn demo (scripted, two terminals)"
  say "======================================"
  say ""
  say "1. Terminal A — orchestrator peer:"
  say "       just role orchestrator"
  say "   Terminal B — researcher peer:"
  say "       just role researcher"
  say ""
  say "2. Wait for both peers to register, then snapshot the researcher's current sid:"
  say "       just respawn-demo sid researcher"
  say ""
  say "3. In the orchestrator TUI, prompt the agent:"
  say "       call coms_request_respawn targeting researcher with note"
  say "       \"$NOTE\", then wait for the researcher to confirm."
  say ""
  say "   The orchestrator agent sends the request; the researcher agent decides"
  say "   whether to agree. An ack timeout surfaces if it never answers."
  say ""
  say "4. On the researcher TUI, if the confirm-destructive extension is active,"
  say "   a \"Clear session?\" gate appears before the session is replaced — approve"
  say "   it. Headless (non-interactive) peers skip this gate."
  say ""
  say "5. Observe the researcher: same pid, same TUI, identity preserved, and the"
  say "   kickoff note \"$NOTE\" appears as the fresh session's first message."
  say ""
  say "6. Verify on disk:"
  say "       just respawn-demo verify researcher \"$NOTE\""
  say ""
  say "   Expected: registry session_id changed (step 2 vs now), pid unchanged,"
  say "   and the session jsonl carrying that session_id shows the kickoff note."
}

sid() {
  local reg="$REGISTRY_DIR/$NAME.json"
  [[ -f "$reg" ]] || { say "no registry file at $reg — is the peer running?" >&2; exit 1; }
  grep -o '"session_id": *"[^"]*"' "$reg" | head -1 | sed 's/.*"\([^"]*\)"$/\1/'
}

verify() {
  local reg="$REGISTRY_DIR/$NAME.json"
  [[ -f "$reg" ]] || { say "FAIL: no registry file at $reg" >&2; exit 1; }
  local reg_sid pid started
  reg_sid=$(grep -o '"session_id": *"[^"]*"' "$reg" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
  pid=$(grep -o '"pid": *[0-9]*' "$reg" | head -1 | sed 's/.*: *//')
  started=$(grep -o '"started_at": *"[^"]*"' "$reg" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')

  # Session dir for this repo's cwd (encoded dir name contains the repo basename).
  # All peers launched from this repo share it, so pick the jsonl whose boot
  # event carries the registry session_id (the invariant respawn must uphold),
  # not simply the newest file by mtime.
  local session_dir
  session_dir=$(ls -dt "$HOME"/.pi/agent/sessions/*pi-ext-agent-comms* 2>/dev/null | head -1)
  [[ -n "$session_dir" ]] || { say "FAIL: no session dir found under ~/.pi/agent/sessions/" >&2; exit 1; }

  local boot_file="" boot_sid=""
  local f s
  for f in "$session_dir"/*.jsonl; do
    [[ -f "$f" ]] || continue
    s=$(grep -m1 '"event":"boot"' "$f" | grep -o '"session_id":"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/') || true
    if [[ -n "$s" && "$s" = "$reg_sid" ]]; then
      boot_file="$f"; boot_sid="$s"
      break
    fi
  done

  say "registry:   session_id=$reg_sid  pid=$pid  started_at=$started"
  if [[ -n "$boot_file" ]]; then
    say "session file: $boot_file"
    say "boot event: session_id=$boot_sid"
  else
    say "session file: none of $session_dir boots with $reg_sid"
  fi

  local ok=1
  [[ -n "$boot_sid" ]] || {
    say "FAIL: registry session_id does not match the boot session_id in any session file" >&2
    ok=0
  }
  if [[ -n "$boot_file" ]] && grep -m1 '"role":"user"' "$boot_file" | grep -qF "$NOTE"; then
    say "kickoff note \"$NOTE\": FOUND in first user message"
  else
    say "FAIL: kickoff note \"$NOTE\" not found in the respawned session's first user message" >&2
    ok=0
  fi
  [[ "$ok" = 1 ]] && say "PASS: respawn verified end to end" || exit 1
}

case "$ACTION" in
  plan) plan ;;
  sid) sid ;;
  verify) verify ;;
  *) say "usage: respawn-demo.sh [plan|sid NAME|verify NAME [NOTE]]" >&2; exit 1 ;;
esac
