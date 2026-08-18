# Agnostic Review Agents

This directory contains the agnostic (repo-independent) layer of the two-layer review agent system.

Each `*-agent.md` file here encodes:
- Review lens — the core question this reviewer answers
- Decision criteria — what counts as a real finding
- Calibration — what NOT to flag; silence bias
- Output format — exact finding structure

These agents are automatically merged with repo-specific supplements found in `{repo}/.claude/agents/`.
Matching is by filename. The `name` frontmatter field must match between layers.

A repo team adding `dry-agent.md` to their `.claude/agents/` will have it merged with this base agent.
A repo team adding a custom `foo-agent.md` with no counterpart here will run it standalone (repo-only mode).
