/**
 * Agent Team — Dispatcher-only orchestrator with grid dashboard
 *
 * The primary Pi agent has NO codebase tools. It can ONLY delegate work
 * to specialist agents via the `dispatch_agent` tool. Each specialist
 * maintains its own Pi session for cross-invocation memory.
 *
 * Loads agent definitions from agents/*.md, .claude/agents/*.md, .pi/agents/*.md.
 * Teams are defined in .pi/agents/teams.yaml — on boot a select dialog lets
 * you pick which team to work with. Only team members are available for dispatch.
 *
 * Commands:
 *   /agents-team          — switch active team
 *   /agents-list          — list loaded agents
 *   /agents-grid N        — set column count (default 2)
 *
 * Usage: pi -e extensions/agent-team.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text, type AutocompleteItem, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { spawn } from "child_process";
import { readdirSync, readFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync, realpathSync } from "fs";
import { join, resolve } from "path";
import { applyExtensionDefaults } from "./lib/themeMap.ts";

// ── Types ────────────────────────────────────────

interface AgentDef {
	name: string;
	description: string;
	tools: string;
	extensions: string[];
	systemPrompt: string;
	model?: string;      // Optional per-agent model override (e.g. "google/gemini-2.5-pro")
	timeout?: number;    // Optional per-agent timeout in seconds (default: 600)
	file: string;
}

interface OrchestratorDef {
	name: string;
	description: string;
	tools: string[];
	whitelist: string[];
	systemPrompt: string;
	file: string;
}

interface AgentState {
	def: AgentDef;
	status: "idle" | "running" | "done" | "error" | "timeout" | "cancelled";
	task: string;
	toolCount: number;
	elapsed: number;
	lastWork: string;
	contextPct: number;
	sessionFile: string | null;
	runCount: number;
	resolvedModel?: string;  // The model that was actually used ("default" if same as session)
	timer?: ReturnType<typeof setInterval>;
	childPid?: number;      // Active child process PID — used to kill lingering processes on re-spawn
	outputPath?: string;    // Path to the most recent saved output file for this agent
}

// ── Display Name Helper ──────────────────────────

function displayName(name: string): string {
	return name.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function stripProvider(modelId?: string): string {
	if (!modelId) return "default";
	const parts = modelId.split('/');
	return parts[parts.length - 1];
}

// ── Teams YAML Parser ────────────────────────────

function resolveWhitelistedPath(inputPath: string, cwd: string, whitelist: string[]): { allowed: boolean; resolvedPath?: string; reason?: string } {
	const normalizedInput = inputPath.trim();
	if (normalizedInput.startsWith("/") || /^[A-Za-z]:[\\/]/.test(normalizedInput)) {
		return { allowed: false, reason: "Absolute paths are not allowed." };
	}
	if (normalizedInput.includes("..")) {
		return { allowed: false, reason: "Path traversal ('..') is not allowed." };
	}

	let resolvedTarget: string;
	try {
		resolvedTarget = realpathSync(resolve(cwd, normalizedInput));
	} catch {
		return { allowed: false, reason: `File does not exist or cannot be resolved: ${inputPath}` };
	}

	for (const dir of whitelist) {
		if (!dir.trim()) continue;
		let resolvedDir: string;
		try {
			resolvedDir = realpathSync(resolve(cwd, dir.trim()));
		} catch {
			continue; // whitelisted dir doesn't exist yet, skip
		}
		// Ensure the resolved target is inside (or equal to) the whitelisted dir
		if (
			resolvedTarget === resolvedDir ||
			resolvedTarget.startsWith(resolvedDir + "/") ||
			resolvedTarget.startsWith(resolvedDir + "\\")
		) {
			return { allowed: true, resolvedPath: resolvedTarget };
		}
	}

	return { allowed: false, reason: `Path '${inputPath}' is outside the allowed directories.` };
}

function parseTeamsYaml(raw: string): Record<string, string[]> {
	const teams: Record<string, string[]> = {};
	let current: string | null = null;
	for (const line of raw.split("\n")) {
		const teamMatch = line.match(/^(\S[^:]*):$/);
		if (teamMatch) {
			current = teamMatch[1].trim();
			teams[current] = [];
			continue;
		}
		const itemMatch = line.match(/^\s+-\s+(.+)$/);
		if (itemMatch && current) {
			teams[current].push(itemMatch[1].trim());
		}
	}
	return teams;
}

// ── Frontmatter Parser ───────────────────────────

function parseAgentFile(filePath: string): AgentDef | null {
	try {
		const raw = readFileSync(filePath, "utf-8");
		const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
		if (!match) return null;

		const frontmatter: Record<string, string> = {};
		for (const line of match[1].split("\n")) {
			const idx = line.indexOf(":");
			if (idx > 0) {
				frontmatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
			}
		}

		if (!frontmatter.name) return null;

		return {
			name: frontmatter.name,
			description: frontmatter.description || "",
			tools: frontmatter.tools || "read,grep,find,ls",
			extensions: frontmatter.extensions
				? frontmatter.extensions.split(",").map((e) =>	e.trim()).filter(Boolean)
				: [],
			model: frontmatter.model || undefined,
			timeout: frontmatter.timeout ? parseInt(frontmatter.timeout, 10) : undefined,
			systemPrompt: match[2].trim(),
			file: filePath,
		};
	} catch {
		return null;
	}
}

function parseOrchestratorFile(filePath: string): OrchestratorDef | null {
	try {
		const raw = readFileSync(filePath, "utf-8");
		const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
		if (!match) return null;

		const frontmatter: Record<string, string> = {};
		for (const line of match[1].split("\n")) {
			const idx = line.indexOf(":");
			if (idx > 0) {
				frontmatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
			}
		}

		if (!frontmatter.name) return null;

		const parseList = (raw?: string) =>
			(raw || "")
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);

		return {
			name: frontmatter.name,
			description: frontmatter.description || "",
			tools: parseList(frontmatter.tools),
			whitelist: parseList(frontmatter.whitelist),
			systemPrompt: match[2].trim(),
			file: filePath,
		};
	} catch {
		return null;
	}
}

const DEFAULT_ORCHESTRATOR_TOOLS = ["dispatch_agent", "dispatch_agents", "read_agent_output"];
const DEFAULT_ORCHESTRATOR_WHITELIST: string[] = [];

function scanAgentDirs(cwd: string): AgentDef[] {
	const dirs = [
		join(cwd, "agents"),
		join(cwd, ".claude", "agents"),
		join(cwd, ".pi", "agents"),
	];

	const agents: AgentDef[] = [];
	const seen = new Set<string>();

	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		try {
			for (const file of readdirSync(dir)) {
				if (!file.endsWith(".md")) continue;
				if (file === "agent-team-orchestrator.md") continue; // orchestrator config, not an agent
				const fullPath = resolve(dir, file);
				const def = parseAgentFile(fullPath);
				if (def && !seen.has(def.name.toLowerCase())) {
					seen.add(def.name.toLowerCase());
					agents.push(def);
				}
			}
		} catch {}
	}

	return agents;
}

// ── Extension path resolution ────────────────────

function resolveExtPath(ext: string, cwd: string): string {
	if (ext.startsWith("npm:") || ext.startsWith("git:")) return ext;
	if (ext.startsWith("/") || /^[A-Za-z]:[\/\\]/.test(ext)) return ext;
	return resolve(cwd, ext);
}

// ── Extension ────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const agentStates: Map<string, AgentState> = new Map();
	let allAgentDefs: AgentDef[] = [];
	let orchestratorDef: OrchestratorDef | null = null;
	let teams: Record<string, string[]> = {};
	let activeTeamName = "";
	let gridCols = 2;
	let widgetCtx: any;
	let sessionDir = "";
	let outputBaseDir = "";
	let contextWindow = 0;

	function loadAgents(cwd: string) {
		// Create session storage dir
		sessionDir = join(cwd, ".pi", "agent-sessions");
		if (!existsSync(sessionDir)) {
			mkdirSync(sessionDir, { recursive: true });
		}
		outputBaseDir = join(cwd, ".pi", "outputs");
		if (!existsSync(outputBaseDir)) {
			mkdirSync(outputBaseDir, { recursive: true });
		}

		// Load all agent definitions
		allAgentDefs = scanAgentDirs(cwd);

		// Load orchestrator definition (optional)
		const orchestratorPath = join(cwd, ".pi", "agents", "agent-team-orchestrator.md");
		orchestratorDef = existsSync(orchestratorPath) ? parseOrchestratorFile(orchestratorPath) : null;

		// Load teams from .pi/agents/teams.yaml
		const teamsPath = join(cwd, ".pi", "agents", "teams.yaml");
		if (existsSync(teamsPath)) {
			try {
				teams = parseTeamsYaml(readFileSync(teamsPath, "utf-8"));
			} catch {
				teams = {};
			}
		} else {
			teams = {};
		}

		// If no teams defined, create a default "all" team
		if (Object.keys(teams).length === 0) {
			teams = { all: allAgentDefs.map(d => d.name) };
		}
	}

	function activateTeam(teamName: string) {
		activeTeamName = teamName;
		const members = teams[teamName] || [];
		const defsByName = new Map(allAgentDefs.map(d => [d.name.toLowerCase(), d]));

		agentStates.clear();
		for (const member of members) {
			const def = defsByName.get(member.toLowerCase());
			if (!def) continue;
			const key = def.name.toLowerCase().replace(/\s+/g, "-");
			const sessionFile = join(sessionDir, `${key}.json`);
			agentStates.set(def.name.toLowerCase(), {
				def,
				status: "idle",
				task: "",
				toolCount: 0,
				elapsed: 0,
				lastWork: "",
				contextPct: 0,
				sessionFile: existsSync(sessionFile) ? sessionFile : null,
				runCount: 0,
			});
		}

		// Auto-size grid columns based on team size
		const size = agentStates.size;
		gridCols = size <= 3 ? size : size === 4 ? 2 : 3;
	}

	// ── Grid Rendering ───────────────────────────

	function renderCard(state: AgentState, colWidth: number, theme: any): string[] {
		const w = Math.max(1, colWidth - 2);  // Guard against negative/zero
		const truncate = (s: string, max: number) => {
			const cleaned = s.replace(/\t/g, "        ");  // Tab width 8, not 2
			if (visibleWidth(cleaned) <= max) return cleaned;
			return truncateToWidth(cleaned, Math.max(0, max - 3)) + "...";
		};

		const statusColor = state.status === "idle" ? "dim"
			: state.status === "running" ? "accent"
			: state.status === "done" ? "success"
			: state.status === "timeout" ? "warning"
			: state.status === "cancelled" ? "warning" : "error";
		const statusIcon = state.status === "idle" ? "○"
			: state.status === "running" ? "●"
			: state.status === "done" ? "✓"
			: state.status === "timeout" ? "⏱"
			: state.status === "cancelled" ? "⊘" : "✗";

		const name = displayName(state.def.name);
		const modelLabel = state.resolvedModel || "default";
		const sep = " — ";
		const combined = name + sep + modelLabel;

		let nameStr: string;
		let nameVisible: number;
		if (visibleWidth(combined) <= w) {
			nameStr = theme.fg("accent", theme.bold(name)) + theme.fg("dim", sep + modelLabel);
			nameVisible = 1 + visibleWidth(combined);  // Include leading space
		} else {
			const nameTruncated = truncate(name, w);
			nameStr = theme.fg("accent", theme.bold(nameTruncated));
			nameVisible = 1 + visibleWidth(nameTruncated);  // Include leading space
		}

		const statusStr = `${statusIcon} ${state.status}`;
		const timeStr = state.status !== "idle" ? ` ${Math.round(state.elapsed / 1000)}s` : "";
		const statusLine = theme.fg(statusColor, statusStr + timeStr);
		const statusVisible = 1 + statusStr.length + timeStr.length;

		// Context bar: 5 blocks + percent
		const filled = Math.max(0, Math.min(5, Math.ceil(state.contextPct / 20)));
		const bar = "#".repeat(filled) + "-".repeat(5 - filled);
		const ctxStr = `[${bar}] ${Math.ceil(state.contextPct)}%`;
		const ctxLine = theme.fg("dim", ctxStr);
		const ctxVisible = 1 + ctxStr.length;

		const workRaw = state.task
			? (state.lastWork || state.task)
			: state.def.description;
		const workText = truncate(workRaw, Math.min(50, w - 1));
		const workLine = theme.fg("muted", workText);
		const workVisible = 1 + visibleWidth(workText);

		const top = "┌" + "─".repeat(w) + "┐";
		const bot = "└" + "─".repeat(w) + "┘";
		const border = (content: string, visLen: number) =>
			theme.fg("dim", "│") + content + " ".repeat(Math.max(0, w - visLen)) + theme.fg("dim", "│");

		return [
			theme.fg("dim", top),
			border(" " + nameStr, nameVisible),
			border(" " + statusLine, statusVisible),
			border(" " + ctxLine, ctxVisible),
			border(" " + workLine, workVisible),
			theme.fg("dim", bot),
		];
	}

	function updateWidget() {
		if (!widgetCtx) return;

		widgetCtx.ui.setWidget("agent-team", (_tui: any, theme: any) => {
			const text = new Text("", 0, 1);

			return {
				render(width: number): string[] {
					if (agentStates.size === 0) {
						text.setText(theme.fg("dim", "No agents found. Add .md files to agents/"));
						return text.render(width);
					}

					const cols = Math.min(gridCols, agentStates.size);
					const gap = 1;
					const rawColWidth = Math.floor((width - gap * (cols - 1)) / cols);
				const colWidth = Math.max(8, rawColWidth);  // Minimum 8 for border + name
					const agents = Array.from(agentStates.values());
					const rows: string[][] = [];

					for (let i = 0; i < agents.length; i += cols) {
						const rowAgents = agents.slice(i, i + cols);
						const cards = rowAgents.map(a => renderCard(a, colWidth, theme));

						while (cards.length < cols) {
							cards.push(Array(6).fill(" ".repeat(colWidth)));
						}

						const cardHeight = cards[0].length;
						for (let line = 0; line < cardHeight; line++) {
							rows.push(cards.map(card => card[line] || ""));
						}
					}

					const output = rows.map(cols => cols.join(" ".repeat(gap)));
					text.setText(output.join("\n"));
					return text.render(width);
				},
				invalidate() {
					text.invalidate();
				},
			};
		});
	}

	// ── Dispatch Agent (returns Promise) ─────────

	function dispatchAgent(
		agentName: string,
		task: string,
		ctx: any,
		modelOverride?: string,
		signal?: AbortSignal,
		timeoutOverride?: number,
	): Promise<{ output: string; exitCode: number; elapsed: number; timedOut?: boolean }> {
		// Bail out immediately if already cancelled
		if (signal?.aborted) {
			return Promise.resolve({ output: "Cancelled", exitCode: 1, elapsed: 0 });
		}
		const key = agentName.toLowerCase();
		const state = agentStates.get(key);
		if (!state) {
			return Promise.resolve({
				output: `Agent "${agentName}" not found. Available: ${Array.from(agentStates.values()).map(s => displayName(s.def.name)).join(", ")}`,
				exitCode: 1,
				elapsed: 0,
			});
		}

		if (state.status === "running") {
			return Promise.resolve({
				output: `Agent "${displayName(state.def.name)}" is already running. Wait for it to finish.`,
				exitCode: 1,
				elapsed: 0,
			});
		}

		// Guard: if a previous spawn left a lingering child (e.g. timed-out process
		// still in SIGTERM grace period), SIGKILL it before allowing a new spawn.
		if (state.childPid) {
			try {
				process.kill(state.childPid, "SIGKILL");
			} catch {
				// Process already exited — safe to ignore
			}
			state.childPid = undefined;
		}

		state.status = "running";
		state.task = task;
		state.toolCount = 0;
		state.elapsed = 0;
		state.lastWork = "";
		state.runCount++;
		updateWidget();

		const DEFAULT_AGENT_TIMEOUT_S = 600;
		const agentTimeoutMs = (timeoutOverride || state.def.timeout || DEFAULT_AGENT_TIMEOUT_S) * 1000;

		const startTime = Date.now();
		state.timer = setInterval(() => {
			state.elapsed = Date.now() - startTime;
			updateWidget();
		}, 1000);

		const fallbackModel = "openrouter/google/gemini-3-flash-preview";
		const sessionModelFlag = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : fallbackModel;

		// Priority: tool param override > agent definition model > session model > fallback
		const model = modelOverride || state.def.model || sessionModelFlag;

		// Store model label for card display: "default" if same as session model, else strip provider prefix
		const isDefault = model === sessionModelFlag;
		state.resolvedModel = isDefault ? "default" : stripProvider(model);

		// Session file for this agent
		const agentKey = state.def.name.toLowerCase().replace(/\s+/g, "-");
		const agentSessionFile = join(sessionDir, `${agentKey}.json`);

		// Build args — first run creates session, subsequent runs resume
		const args = [
			"--mode", "json",
			"-p",
			"--no-extensions",
			...state.def.extensions.flatMap((ext) =>	["-e", resolveExtPath(ext, ctx.cwd)]),
			"--model", model,
			"--tools", state.def.tools,
			"--thinking", "off",
			"--append-system-prompt", state.def.systemPrompt,
			"--session", agentSessionFile,
		];

		// Continue existing session if we have one
		if (state.sessionFile) {
			args.push("-c");
		}

		args.push(task);

		const textChunks: string[] = [];
		const stderrChunks: string[] = [];

		return new Promise((resolve, reject) => {
			const proc = spawn("pi", args, {
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env },
			});

			state.childPid = proc.pid;

			// Kill the child process when the user presses Escape (abort signal fires)
			let wasAborted = false;
			let wasTimedOut = false;
			const timeoutTimer = setTimeout(() => {
				wasTimedOut = true;
				clearInterval(state.timer);
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
				state.status = "timeout";
				state.lastWork = `Timed out after ${Math.round(agentTimeoutMs / 1000)}s`;
				state.childPid = undefined;
				updateWidget();
			}, agentTimeoutMs);

			const killProc = () => {
				wasAborted = true;
				clearTimeout(timeoutTimer);
				clearInterval(state.timer);
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
				state.status = "cancelled";
				state.lastWork = "Cancelled by user";
				state.childPid = undefined;
				updateWidget();
			};
			if (signal?.aborted) killProc();
			else signal?.addEventListener("abort", killProc, { once: true });

			let buffer = "";

			proc.stdout!.setEncoding("utf-8");
			proc.stdout!.on("data", (chunk: string) => {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const event = JSON.parse(line);
						if (event.type === "message_update") {
							const delta = event.assistantMessageEvent;
							if (delta?.type === "text_delta") {
								textChunks.push(delta.delta || "");
								const full = textChunks.join("");
								const last = full.split("\n").filter((l: string) => l.trim()).pop() || "";
								state.lastWork = last;
								updateWidget();
							}
						} else if (event.type === "tool_execution_start") {
							state.toolCount++;
							updateWidget();
						} else if (event.type === "message_end") {
							const msg = event.message;
							if (msg?.usage && contextWindow > 0) {
								state.contextPct = ((msg.usage.input || 0) / contextWindow) * 100;
								updateWidget();
							}
							// Fallback: if text_deltas missed content, grab full text from final message
							if (msg?.content && textChunks.join("").length === 0) {
								const fullText = msg.content
									.filter((c: any) => c.type === "text")
									.map((c: any) => c.text || "")
									.join("");
								if (fullText) textChunks.push(fullText);
							}
						} else if (event.type === "agent_end") {
							const msgs = event.messages || [];
							const last = [...msgs].reverse().find((m: any) => m.role === "assistant");
							if (last?.usage && contextWindow > 0) {
								state.contextPct = ((last.usage.input || 0) / contextWindow) * 100;
								updateWidget();
							}
						}
					} catch {}
				}
			});

			proc.stderr!.setEncoding("utf-8");
			proc.stderr!.on("data", (chunk: string) => {
				const MAX_STDERR = 1024 * 1024; // 1 MB cap
				const total = stderrChunks.reduce((sum, c) => sum + c.length, 0);
				if (total < MAX_STDERR) {
					stderrChunks.push(chunk);
				}
			});

			proc.on("close", (code) => {
				signal?.removeEventListener("abort", killProc);
				clearTimeout(timeoutTimer);
				state.childPid = undefined;

				if (buffer.trim()) {
					try {
						const event = JSON.parse(buffer);
						if (event.type === "message_update") {
							const delta = event.assistantMessageEvent;
							if (delta?.type === "text_delta") textChunks.push(delta.delta || "");
						}
					} catch {}
				}

				clearInterval(state.timer);
				state.elapsed = Date.now() - startTime;
				const full = textChunks.join("");

				if (wasTimedOut) {
					state.status = "timeout";
					updateWidget();
					resolve({
						output: full,
						exitCode: 1,
						elapsed: state.elapsed,
						timedOut: true,
					});
					return;
				}

				if (wasAborted) {
					state.status = "cancelled";
					state.lastWork = "Cancelled by user";
					updateWidget();
					reject(new Error("aborted"));
					return;
				}

				state.status = code === 0 ? "done" : "error";

				// Mark session file as available for resume
				if (code === 0) {
					state.sessionFile = agentSessionFile;
				}

				state.lastWork = full.split("\n").filter((l: string) => l.trim()).pop() || "";
				updateWidget();

				// Persist full output to disk for the orchestrator to inspect
				try {
					if (!existsSync(outputBaseDir)) mkdirSync(outputBaseDir, { recursive: true });
					const uniquePath = join(outputBaseDir, `${agentKey}_${Date.now()}.md`);
					let outputBody = full;
					if (stderrChunks.length > 0) {
						outputBody += "\n\n--- stderr ---\n" + stderrChunks.join("");
					}
					// Clean up previous output file for this agent to prevent accumulation
					if (state.outputPath && existsSync(state.outputPath)) {
						try { unlinkSync(state.outputPath); } catch {}
					}
					writeFileSync(uniquePath, outputBody, "utf-8");
					state.outputPath = uniquePath;
				} catch {}

				ctx.ui.notify(
					`${displayName(state.def.name)} ${state.status} in ${Math.round(state.elapsed / 1000)}s`,
					state.status === "done" ? "success" : state.status === "timeout" || state.status === "cancelled" ? "warning" : "error"
				);

				resolve({
					output: full,
					exitCode: code ?? 1,
					elapsed: state.elapsed,
				});
			});

			proc.on("error", (err) => {
				signal?.removeEventListener("abort", killProc);
				clearTimeout(timeoutTimer);
				clearInterval(state.timer);
				state.childPid = undefined;
				state.status = "error";
				state.lastWork = `Error: ${err.message}`;
				updateWidget();
				resolve({
					output: `Error spawning agent: ${err.message}`,
					exitCode: 1,
					elapsed: Date.now() - startTime,
				});
			});
		});
	}

	// ── Concurrency helper ───────────────────────

	async function mapWithConcurrencyLimit<TIn, TOut>(
		items: TIn[],
		concurrency: number,
		fn: (item: TIn, index: number) => Promise<TOut>,
	): Promise<TOut[]> {
		if (items.length === 0) return [];
		const limit = Math.max(1, Math.min(concurrency, items.length));
		const results: TOut[] = new Array(items.length);
		let nextIndex = 0;

		const workers = new Array(limit).fill(null).map(async () => {
			while (true) {
				const current = nextIndex++;
				if (current >= items.length) return;
				results[current] = await fn(items[current], current);
			}
		});

		await Promise.all(workers);
		return results;
	}

	// ── dispatch_agent Tool (registered at top level) ──

	pi.registerTool({
		name: "dispatch_agent",
		label: "Dispatch Agent",
		description: "Dispatch a task to a specialist agent. The agent will execute the task and return the result. Use the system prompt to see available agent names.",
		parameters: Type.Object({
			agent: Type.String({ description: "Agent name (case-insensitive)" }),
			task: Type.String({ description: "Task description for the agent to execute" }),
			model: Type.Optional(Type.String({ description: "Override the model for this dispatch. Format: provider/id (e.g. google/gemini-2.5-pro). Uses agent default or session model if omitted." })),
			timeout: Type.Optional(Type.Number({ minimum: 1, description: "Override the timeout for this dispatch in seconds. Uses agent default (from .md frontmatter) or 600s if omitted." })),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { agent, task, model, timeout } = params as { agent: string; task: string; model?: string; timeout?: number };

			// Resolve model label for display (same priority as dispatchAgent)
			const fallbackModel = "openrouter/google/gemini-3-flash-preview";
			const sessionModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : fallbackModel;
			const resolvedModel = model || agentStates.get(agent.toLowerCase())?.def.model || sessionModel;
			const modelUsed = resolvedModel === sessionModel ? "default" : stripProvider(resolvedModel);

			try {
				if (onUpdate) {
					onUpdate({
						content: [{ type: "text", text: `Dispatching to ${agent}...` }],
						details: { agent, task, status: "dispatching", modelUsed },
					});
				}

				const result = await dispatchAgent(agent, task, ctx, model, signal, timeout);

				const agentKey = agent.toLowerCase().replace(/\s+/g, "-");
				const state = agentStates.get(agentKey);
				const outputPath = state?.outputPath || join(outputBaseDir, `${agentKey}.md`);
				const MAX_PREVIEW = 2500;
				let preview = result.output;
				if (result.output.length > MAX_PREVIEW) {
					preview = truncatePreview(result.output, MAX_PREVIEW);
				}

				const status = result.timedOut ? "timeout" : result.exitCode === 0 ? "done" : "error";
				const summary = `[${agent}] ${status} in ${Math.round(result.elapsed / 1000)}s`;

				return {
					content: [{ type: "text", text: `${summary}\n\n${preview}\n\n[Full output: ${outputPath}]` }],
					details: {
						agent,
						task,
						status,
						modelUsed,
						elapsed: result.elapsed,
						exitCode: result.exitCode,
						fullOutput: result.output,
						outputPath,
						timedOut: result.timedOut || false,
					},
				};
			} catch (err: any) {
				if (signal?.aborted) {
					return {
						content: [{ type: "text", text: `Agent ${agent} cancelled by user.` }],
						details: { agent, task, status: "cancelled", modelUsed, elapsed: 0, exitCode: 1, fullOutput: "", outputPath: "", timedOut: false },
					};
				}
				return {
					content: [{ type: "text", text: `Error dispatching to ${agent}: ${err?.message || err}` }],
					details: { agent, task, status: "error", modelUsed, elapsed: 0, exitCode: 1, fullOutput: "", outputPath: "" },
				};
			}
		},

		renderCall(args, theme) {
			const agentName = (args as any).agent || "?";
			const task = (args as any).task || "";
			const preview = task.length > 60 ? task.slice(0, 57) + "..." : task;
			return new Text(
				theme.fg("toolTitle", theme.bold("dispatch_agent ")) +
				theme.fg("accent", agentName) +
				theme.fg("dim", " — ") +
				theme.fg("muted", preview),
				0, 0,
			);
		},

		renderResult(result, options, theme) {
			const details = result.details as any;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			// Streaming/partial result while agent is still running
			if (options.isPartial || details.status === "dispatching") {
				return new Text(
					theme.fg("accent", `● ${details.agent || "?"}`) +
					theme.fg("dim", " working..."),
					0, 0,
				);
			}

			const icon = details.status === "done" ? "✓"
				: details.status === "cancelled" ? "⊘"
				: details.status === "timeout" ? "⏱" : "✗";
			const color = details.status === "done" ? "success"
				: details.status === "cancelled" ? "warning"
				: details.status === "timeout" ? "warning" : "error";
			const elapsed = typeof details.elapsed === "number" ? Math.round(details.elapsed / 1000) : 0;
			const modelTag = details.modelUsed ? ` · ${stripProvider(details.modelUsed)}` : "";
			const header = theme.fg(color, `${icon} ${details.agent}`) +
				theme.fg("dim", ` ${elapsed}s${modelTag}`);

			if (options.expanded && details.fullOutput) {
				const output = truncateRender(details.fullOutput, 12000);
				return new Text(header + "\n" + theme.fg("muted", output), 0, 0);
			}

			return new Text(header, 0, 0);
		},
	});

	// ── dispatch_agents Tool (plural, controlled concurrency) ──

	pi.registerTool({
		name: "dispatch_agents",
		label: "Dispatch Agents",
		description: `Dispatch multiple specialist agents with controlled concurrency. Agents are executed in the order provided, but up to \`concurrency\` agents may run simultaneously.\n\nUse this when you need to run multiple agents at once while respecting API provider limits. Order is preserved — results are returned in the same order as the input array.\n\nFor a single agent, use \`dispatch_agent\` instead.`,

		parameters: Type.Object({
			agents: Type.Array(
				Type.Object({
					agent: Type.String({ description: "Agent name (case-insensitive)" }),
					task: Type.String({ description: "Task description for the agent to execute" }),
					model: Type.Optional(Type.String({ description: "Override the model for this dispatch. Format: provider/id (e.g. google/gemini-2.5-pro). Uses agent default or session model if omitted." })),
					timeout: Type.Optional(Type.Number({ minimum: 1, description: "Override the timeout for this agent in seconds. Uses agent default or 600s if omitted." })),
				}),
				{ description: "Array of agent tasks. Executed in order with controlled concurrency. Minimum 1 item.", minItems: 1 },
			),
			concurrency: Type.Optional(Type.Number({
				description: "Maximum number of agents to run simultaneously. Default: 3. Order is preserved regardless of this value.",
				default: 3,
				minimum: 1,
			})),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { agents, concurrency } = params as {
				agents: { agent: string; task: string; model?: string; timeout?: number }[];
				concurrency?: number;
			};

			if (!agents || agents.length === 0) {
				return {
					content: [{ type: "text", text: "No agents provided." }],
					details: { results: [], status: "error" },
				};
			}

			const maxConcurrency = Math.max(1, Math.min(concurrency ?? 3, agents.length));

			const allResults: Array<{
				agent: string;
				task: string;
				status: "done" | "error" | "cancelled" | "timeout";
				elapsed: number;
				exitCode: number;
				output: string;
				fullOutput: string;
				outputPath: string;
				modelUsed: string;
			} | null> = new Array(agents.length).fill(null);

			const emitUpdate = () => {
				if (!onUpdate) return;
				const done = allResults.filter(r => r !== null).length;
				const running = agents.length - done;
				onUpdate({
					content: [{ type: "text", text: `Dispatch: ${done}/${agents.length} done, ${running} running (max ${maxConcurrency} concurrent)...` }],
					details: { results: allResults.filter(r => r !== null), total: agents.length, concurrency: maxConcurrency, status: "dispatching" },
				});
			};

			const runResults = await mapWithConcurrencyLimit(agents, maxConcurrency, async (config, idx) => {
				if (signal?.aborted) {
					const cancelledResult = {
						agent: config.agent,
						task: config.task,
						status: "cancelled" as const,
						elapsed: 0,
						exitCode: -1,
						output: "Cancelled by user",
						fullOutput: "",
						outputPath: "",
						modelUsed: "",
					};
					allResults[idx] = cancelledResult;
					emitUpdate();
					return cancelledResult;
				}

				// Resolve model label for display
				const fallbackModel = "openrouter/google/gemini-3-flash-preview";
				const sessionModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : fallbackModel;
				const resolvedModel = config.model || agentStates.get(config.agent.toLowerCase())?.def.model || sessionModel;
				const modelUsed = resolvedModel === sessionModel ? "default" : stripProvider(resolvedModel);

				try {
					const result = await dispatchAgent(config.agent, config.task, ctx, config.model, signal, config.timeout);

					const agentKey = config.agent.toLowerCase().replace(/\s+/g, "-");
					const state = agentStates.get(agentKey);
					const outputPath = state?.outputPath || join(outputBaseDir, `${agentKey}.md`);

					const MAX_PREVIEW = 2500;
					let preview = result.output;
					if (result.output.length > MAX_PREVIEW) {
						preview = truncatePreview(result.output, MAX_PREVIEW);
					}

					const status = result.timedOut ? "timeout" : result.exitCode === 0 ? "done" : "error";
					const resultObj = {
						agent: config.agent,
						task: config.task,
						status,
						elapsed: result.elapsed,
						exitCode: result.exitCode,
						output: `${preview}\n\n[Full output: ${outputPath}]`,
						fullOutput: result.output,
						outputPath,
						modelUsed,
					};

					allResults[idx] = resultObj;
					emitUpdate();
					return resultObj;
				} catch (err: any) {
					const status = signal?.aborted ? "cancelled" : "error";
					const resultObj = {
						agent: config.agent,
						task: config.task,
						status: status as "cancelled" | "error",
						elapsed: 0,
						exitCode: 1,
						output: signal?.aborted ? "Cancelled by user" : `Error: ${err?.message || err}`,
						fullOutput: "",
						outputPath: "",
						modelUsed,
					};

					allResults[idx] = resultObj;
					emitUpdate();
					return resultObj;
				}
			});

			const finalStatus = signal?.aborted
				? "cancelled"
				: runResults.every(r => r.status === "done")
				? "done"
				: "partial";

			// Build combined response
			const summaryLines = runResults.map(r => {
				const icon = r.status === "done" ? "✓"
					: r.status === "cancelled" ? "⊘"
					: r.status === "timeout" ? "⏱" : "✗";
				return `  ${icon} ${displayName(r.agent)} (${Math.round(r.elapsed / 1000)}s) [${r.modelUsed}]`;
			});
			const summary = `### Dispatch Results\n${summaryLines.join("\n")}\n\n---\n\n`;

			const sections = runResults.map(r => {
				const icon = r.status === "done" ? "✓" : r.status === "cancelled" ? "⊘" : "✗";
				const modelInfo = r.modelUsed ? ` — model: ${r.modelUsed}` : "";
				return `## [${icon}] ${displayName(r.agent)} (${Math.round(r.elapsed / 1000)}s)${modelInfo}\n\n${r.output}`;
			});

			return {
				content: [{ type: "text", text: summary + sections.join("\n\n---\n\n") }],
				details: {
					results: runResults,
					status: finalStatus,
					concurrency: maxConcurrency,
					total: agents.length,
				},
			};
		},

		renderCall(args, theme) {
			const items = (args as any).agents || [];
			const names = items.map((a: any) => displayName(a.agent || "?")).join(", ");
			const concurrency = (args as any).concurrency;
			const concurrencyHint = typeof concurrency === "number" ? ` (max ${concurrency} concurrent)` : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("dispatch_agents ")) +
				theme.fg("accent", `${items.length} agent${items.length === 1 ? "" : "s"}`) +
				theme.fg("dim", " — ") +
				theme.fg("muted", names + concurrencyHint),
				0, 0,
			);
		},

		renderResult(result, options, theme) {
			const details = result.details as any;
			if (!details?.results) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (options.isPartial || details.status === "dispatching") {
				const done = details.results?.length || 0;
				const total = details.total || done;
				return new Text(
					theme.fg("accent", `◉ ${done}/${total} agents`) +
					theme.fg("dim", ` dispatching (max ${details.concurrency || "?"} concurrent)...`),
					0, 0,
				);
			}

			const lines = (details.results as any[]).map((r: any) => {
				const icon = r.status === "done" ? "✓"
					: r.status === "cancelled" ? "⊘"
					: r.status === "timeout" ? "⏱" : "✗";
				const color = r.status === "done" ? "success"
					: r.status === "cancelled" ? "warning"
					: r.status === "timeout" ? "warning" : "error";
				const elapsed = typeof r.elapsed === "number" ? Math.round(r.elapsed / 1000) : 0;
				const modelTag = r.modelUsed ? ` [${r.modelUsed}]` : "";
				return theme.fg(color, `${icon} ${displayName(r.agent)}`) +
					theme.fg("dim", ` ${elapsed}s${modelTag}`);
			});

			const header = lines.join(theme.fg("dim", " · "));

			if (options.expanded && details.results) {
				const expanded = (details.results as any[]).map((r: any) => {
					const output = r.fullOutput
						? truncateRender(r.fullOutput, 12000)
						: r.output || "";
					const modelTag = r.modelUsed ? ` — model: ${r.modelUsed}` : "";
					return theme.fg("accent", `── ${displayName(r.agent)}${modelTag} ──`) + "\n" + theme.fg("muted", output);
				});
				return new Text(header + "\n\n" + expanded.join("\n\n"), 0, 0);
			}

			return new Text(header, 0, 0);
		},
	});

	// ── read_agent_output Tool ──

	const OUTPUT_MAX_BYTES = 50 * 1024; // 50 KB — matches Pi's internal tool cap

	function sliceOutput(text: string, offset?: number, limit?: number): string {
		if (offset === undefined && limit === undefined) return text;
		const lines = text.split("\n");
		const start = offset !== undefined ? Math.max(1, offset) - 1 : 0;  // 1-based → 0-based
		const end = limit !== undefined ? Math.min(start + limit, lines.length) : lines.length;
		const sliced = lines.slice(start, end);
		const totalLines = lines.length;
		const fromLine = start + 1;
		const toLine = Math.min(start + (limit || totalLines), totalLines);
		return `Lines ${fromLine}-${toLine} of ${totalLines}:\n${sliced.join("\n")}`;
	}

	function truncateOutput(text: string): string {
		if (Buffer.byteLength(text, "utf-8") <= OUTPUT_MAX_BYTES) return text;
		const half = Math.floor(OUTPUT_MAX_BYTES / 2);
		const bytes = new TextEncoder().encode(text);
		const head = new TextDecoder().decode(bytes.slice(0, half));
		const tail = new TextDecoder().decode(bytes.slice(-half));
		return `${head}\n\n... [middle truncated — use read_agent_output with offset/limit to read specific lines] ...\n\n${tail}`;
	}

	function truncatePreview(text: string, maxLen: number): string {
		if (text.length <= maxLen) return text;
		const idx = text.lastIndexOf("\n", maxLen);
		const cutAt = idx > 0 ? idx : maxLen;
		return text.slice(0, cutAt) + "\n\n... [truncated — use read_agent_output with offset/limit to read specific lines]";
	}

	function truncateRender(text: string, maxLen: number): string {
		return text.length > maxLen ? text.slice(0, maxLen) + "\n... [truncated]" : text;
	}

	pi.registerTool({
		name: "read_agent_output",
		label: "Read Agent Output",
		description: "Read the saved output of a completed specialist agent. If the agent's output was truncated in the dispatch result, call this tool to get the full text. Supports offset/limit to read specific line ranges from large outputs.",
		parameters: Type.Object({
			agent: Type.String({ description: "Agent name (case-insensitive)" }),
			offset: Type.Optional(Type.Number({ minimum: 1, description: "1-based line number to start reading from. Defaults to 1 (beginning)." })),
			limit: Type.Optional(Type.Number({ minimum: 1, description: "Maximum number of lines to read. Defaults to all lines from offset to end." })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { agent, offset, limit } = params as { agent: string; offset?: number; limit?: number };
			const agentKey = agent.toLowerCase().replace(/\s+/g, "-");
			const state = agentStates.get(agentKey);
			let outputPath = state?.outputPath;

			if (!outputPath) {
				// Extension may have reloaded — scan for most recent timestamped file
				const prefix = `${agentKey}_`;
				const suffix = ".md";
				const candidates = readdirSync(outputBaseDir)
					.filter((f) => f.startsWith(prefix) && f.endsWith(suffix))
					.map((f) => {
						const tsStr = f.slice(prefix.length, -suffix.length);
						const ts = parseInt(tsStr, 10);
						return { file: f, ts: isNaN(ts) ? 0 : ts };
					})
					.filter((c) => c.ts > 0)
					.sort((a, b) => b.ts - a.ts);
				if (candidates.length > 0) {
					outputPath = join(outputBaseDir, candidates[0].file);
				}
			}

			if (!outputPath) {
				outputPath = join(outputBaseDir, `${agentKey}.md`);
			}

			if (!existsSync(outputPath)) {
				return {
					content: [{ type: "text", text: `No output file found for agent "${agent}" at ${outputPath}.` }],
					details: { agent, outputPath, found: false },
				};
			}

			let full = readFileSync(outputPath, "utf-8");
			const totalLines = full.split("\n").length;
			const hasRange = offset !== undefined || limit !== undefined;

			let result: string;
			let truncated: boolean;
			if (hasRange) {
				// Selective line range — slice first, then truncate if still over limit
				const sliced = sliceOutput(full, offset, limit);
				truncated = Buffer.byteLength(sliced, "utf-8") > OUTPUT_MAX_BYTES;
				result = truncated ? truncateOutput(sliced) : sliced;
			} else {
				// Full read — truncate if over limit
				truncated = Buffer.byteLength(full, "utf-8") > OUTPUT_MAX_BYTES;
				result = truncated ? truncateOutput(full) : full;
			}

			return {
				content: [{ type: "text", text: result }],
				details: { agent, outputPath, found: true, truncated, totalLines, offset, limit },
			};
		},

		renderCall(args, theme) {
			const a = args as any;
			const agentName = a.agent || "?";
			const off = a.offset;
			const lim = a.limit;
			const range = off || lim ? ` L${off || 1}${lim ? `-L${(off || 1) + lim - 1}` : ""}` : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("read_agent_output ")) +
				theme.fg("accent", agentName) +
				(range ? theme.fg("dim", range) : ""),
				0, 0,
			);
		},

		renderResult(result, options, theme) {
			const details = (result.details || {}) as any;
			if (options.isPartial) {
				return new Text(theme.fg("accent", "● read_agent_output") + theme.fg("dim", " working..."), 0, 0);
			}
			const text = result.content[0];
			if (!details.found) {
				return new Text(theme.fg("error", `✗ ${details.agent || "?"} — not found`), 0, 0);
			}
			const rangeInfo = details.offset || details.limit
				? ` L${details.offset || 1}${details.limit ? `-L${(details.offset || 1) + details.limit - 1}` : ""}${details.totalLines ? `/${details.totalLines}` : ""}`
				: details.totalLines ? ` (${details.totalLines} lines)` : "";
			if (options.expanded && text?.type === "text") {
				const output = truncateRender(text.text, 12000);
				return new Text(theme.fg("success", `✓ ${details.agent}${rangeInfo}`) + "\n" + theme.fg("muted", output), 0, 0);
			}
			return new Text(theme.fg("success", `✓ ${details.agent}`) + theme.fg("dim", `${rangeInfo} output loaded`), 0, 0);
		},
	});

	// ── read_team_doc Tool ───────────────────────────

	pi.registerTool({
		name: "read_team_doc",
		label: "Read Team Document",
		description: "Read a file from the orchestrator's whitelisted project directories (e.g., docs, findings, wiki, agent outputs). Use this to inspect documents produced by agents or shared knowledge bases without dispatching an agent. Supports offset/limit for large files.",
		parameters: Type.Object({
			path: Type.String({ description: "Relative path within a whitelisted directory, e.g., ./docs/report.md or findings/summary.md" }),
			offset: Type.Optional(Type.Number({ minimum: 1, description: "1-based line number to start reading from. Defaults to 1 (beginning)." })),
			limit: Type.Optional(Type.Number({ minimum: 1, description: "Maximum number of lines to read. Defaults to all lines from offset to end." })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { path: inputPath, offset, limit } = params as { path: string; offset?: number; limit?: number };
			const cwd = _ctx.cwd;
			const whitelist = orchestratorDef?.whitelist || DEFAULT_ORCHESTRATOR_WHITELIST;

			const check = resolveWhitelistedPath(inputPath, cwd, whitelist);
			if (!check.allowed) {
				return {
					content: [{ type: "text", text: `Cannot read "${inputPath}": ${check.reason}` }],
					details: { path: inputPath, allowed: false, reason: check.reason },
				};
			}

			const outputPath = check.resolvedPath!;
			let full = readFileSync(outputPath, "utf-8");
			const totalLines = full.split("\n").length;
			const hasRange = offset !== undefined || limit !== undefined;

			let result: string;
			let truncated: boolean;
			if (hasRange) {
				const sliced = sliceOutput(full, offset, limit);
				truncated = Buffer.byteLength(sliced, "utf-8") > OUTPUT_MAX_BYTES;
				result = truncated ? truncateOutput(sliced) : sliced;
			} else {
				truncated = Buffer.byteLength(full, "utf-8") > OUTPUT_MAX_BYTES;
				result = truncated ? truncateOutput(full) : full;
			}

			return {
				content: [{ type: "text", text: result }],
				details: { path: inputPath, outputPath, found: true, truncated, totalLines, offset, limit },
			};
		},

		renderCall(args, theme) {
			const a = args as any;
			const p = a.path || "?";
			return new Text(
				theme.fg("toolTitle", theme.bold("read_team_doc ")) +
				theme.fg("accent", p),
				0, 0,
			);
		},

		renderResult(result, options, theme) {
			const details = (result.details || {}) as any;
			if (options.isPartial) {
				return new Text(theme.fg("accent", "● read_team_doc") + theme.fg("dim", " working..."), 0, 0);
			}
			const text = result.content[0];
			if (!details.found) {
				return new Text(theme.fg("error", `✗ ${details.path || "?"} — ${details.reason || "not allowed"}`), 0, 0);
			}
			const rangeInfo = details.offset || details.limit
				? ` L${details.offset || 1}${details.limit ? `-L${(details.offset || 1) + details.limit - 1}` : ""}${details.totalLines ? `/${details.totalLines}` : ""}`
				: details.totalLines ? ` (${details.totalLines} lines)` : "";
			if (options.expanded && text?.type === "text") {
				const output = truncateRender(text.text, 12000);
				return new Text(theme.fg("success", `✓ ${details.path}${rangeInfo}`) + "\n" + theme.fg("muted", output), 0, 0);
			}
			return new Text(theme.fg("success", `✓ ${details.path}`) + theme.fg("dim", `${rangeInfo} loaded`), 0, 0);
		},
	});

	// ── Commands ─────────────────────────────────

	pi.registerCommand("agents-team", {
		description: "Select a team to work with",
		handler: async (_args, ctx) => {
			widgetCtx = ctx;
			const teamNames = Object.keys(teams);
			if (teamNames.length === 0) {
				ctx.ui.notify("No teams defined in .pi/agents/teams.yaml", "warning");
				return;
			}

			const options = teamNames.map(name => {
				const members = teams[name].map(m => displayName(m));
				return `${name} — ${members.join(", ")}`;
			});

			const choice = await ctx.ui.select("Select Team", options);
			if (choice === undefined) return;

			const idx = options.indexOf(choice);
			const name = teamNames[idx];
			activateTeam(name);
			updateWidget();
			ctx.ui.setStatus("agent-team", `Team: ${name} (${agentStates.size})`);
			ctx.ui.notify(`Team: ${name} — ${Array.from(agentStates.values()).map(s => displayName(s.def.name)).join(", ")}`, "info");
		},
	});

	pi.registerCommand("agents-list", {
		description: "List all loaded agents",
		handler: async (_args, _ctx) => {
			widgetCtx = _ctx;
			const names = Array.from(agentStates.values())
				.map(s => {
					const session = s.sessionFile ? "resumed" : "new";
					const exts = s.def.extensions.length ? ` [ext: ${s.def.extensions.join(", ")}]` : "";
					const modelLabel = s.def.model ? stripProvider(s.def.model) : "default";
					return `${displayName(s.def.name)} (${s.status}, ${session}, runs: ${s.runCount}, model: ${modelLabel})${exts}: ${s.def.description}`;
				})
				.join("\n");
			_ctx.ui.notify(names || "No agents loaded", "info");
		},
	});

	pi.registerCommand("agents-grid", {
		description: "Set grid columns: /agents-grid <1-6>",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items = ["1", "2", "3", "4", "5", "6"].map(n => ({
				value: n,
				label: `${n} columns`,
			}));
			const filtered = items.filter(i => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : items;
		},
		handler: async (args, _ctx) => {
			widgetCtx = _ctx;
			const n = parseInt(args?.trim() || "", 10);
			if (n >= 1 && n <= 6) {
				gridCols = n;
				_ctx.ui.notify(`Grid set to ${gridCols} columns`, "info");
				updateWidget();
			} else {
				_ctx.ui.notify("Usage: /agents-grid <1-6>", "error");
			}
		},
	});

	// ── System Prompt Override ───────────────────

	pi.on("before_agent_start", async (_event, _ctx) => {
		// Build dynamic agent catalog from active team only
		const agentCatalog = Array.from(agentStates.values())
			.map(s => {
				const modelLabel = s.def.model ? stripProvider(s.def.model) : "default";
				const timeoutLabel = s.def.timeout ? `${s.def.timeout}s` : "default (600s)";
				return `### ${displayName(s.def.name)}\n**Dispatch as:** \`${s.def.name}\`\n${s.def.description}\n**Tools:** ${s.def.tools}${s.def.extensions.length ? `\n**Extensions:** ${s.def.extensions.join(", ")}` : ""}\n**Model:** \`${modelLabel}\`\n**Timeout:** \`${timeoutLabel}\``;
			})
			.join("\n\n");

		const teamMembers = Array.from(agentStates.values()).map(s => displayName(s.def.name)).join(", ");

		const whitelistDirs = orchestratorDef?.whitelist || DEFAULT_ORCHESTRATOR_WHITELIST;
		const whitelistStr = whitelistDirs.length > 0
			? whitelistDirs.map(d => `- \`${d}\``).join("\n")
			: "(none configured)";

		const fallbackPrompt = `You are a dispatcher agent. You coordinate specialist agents to accomplish tasks.
You do NOT have direct access to the codebase. You MUST delegate all work through
agents using the dispatch_agent tool.

## Active Team: ${activeTeamName}
Members: ${teamMembers}
You can ONLY dispatch to agents listed below. Do not attempt to dispatch to agents outside this team.

## How to Work
- Analyze the user's request and break it into clear sub-tasks
- Choose the right agent(s) for each sub-task
- Dispatch tasks using the dispatch_agent tool (single) or dispatch_agents tool (multiple)
- When using dispatch_agents, set concurrency=1 for strict sequential order, or higher for parallel execution
- dispatch_agent blocks re-dispatching an agent that is already running; dispatch_agents allows the same agent to appear multiple times with different tasks and runs them in parallel
- Review results and dispatch follow-up agents if needed
- If a task fails, try a different agent or adjust the task description
- Summarize the outcome for the user

## Rules
- NEVER try to read, write, or execute code directly — you have no such tools
- ALWAYS use dispatch_agent to get work done
- ALWAYS use read_agent_output to retrieve a previously dispatched agent's full output — do NOT dispatch another agent just to re-read a file
- When you see "... [truncated]" in an agent's output, immediately call read_agent_output with that agent's name to get the full text
- For large outputs, use read_agent_output with offset and limit to read specific line ranges (e.g. {agent: "scout", offset: 50, limit: 100})
- All agents share the same working directory and filesystem. Concurrent agents may race on shared files — direct them to use unique temporary filenames if isolation is needed
- Each agent has a default timeout (shown in catalog). Use the \`timeout\` parameter to override per-dispatch. Minimum 1 second.
- If an agent times out (⏱), it receives SIGTERM first, then SIGKILL after a 5-second grace period — break the task into smaller pieces and retry
- If the user interrupts a batch dispatch, queued agents are cancelled before they start; running agents are killed with SIGTERM → SIGKILL after 5 seconds
- You can chain agents: use scout to explore, then builder to implement
- You can dispatch the same agent multiple times with different tasks
- Keep tasks focused — one clear objective per dispatch

## Agents

${agentCatalog}`;

		const basePrompt = orchestratorDef?.systemPrompt || fallbackPrompt;
		const systemPrompt = basePrompt
			.replace(/{{TEAM_NAME}}/g, activeTeamName)
			.replace(/{{TEAM_MEMBERS}}/g, teamMembers)
			.replace(/{{AGENT_CATALOG}}/g, agentCatalog)
			.replace(/{{WHITELIST}}/g, whitelistStr);

		return { systemPrompt };
	});

	// ── Session Start ────────────────────────────

	pi.on("session_start", async (_event, _ctx) => {
		applyExtensionDefaults(import.meta.url, _ctx);
		// Clear widgets from previous session
		if (widgetCtx) {
			widgetCtx.ui.setWidget("agent-team", undefined);
		}
		widgetCtx = _ctx;
		contextWindow = _ctx.model?.contextWindow || 0;

		// Wipe old agent session files so subagents start fresh
		const sessDir = join(_ctx.cwd, ".pi", "agent-sessions");
		if (existsSync(sessDir)) {
			for (const f of readdirSync(sessDir)) {
				if (f.endsWith(".json")) {
					try { unlinkSync(join(sessDir, f)); } catch {}
				}
			}
		}

		loadAgents(_ctx.cwd);

		// Default to first team — use /agents-team to switch
		const teamNames = Object.keys(teams);
		if (teamNames.length > 0) {
			activateTeam(teamNames[0]);
		}

		// Dispatcher tools available to orchestrator
		const activeTools = orchestratorDef?.tools?.length > 0 ? orchestratorDef.tools : DEFAULT_ORCHESTRATOR_TOOLS;
		pi.setActiveTools(activeTools);

		_ctx.ui.setStatus("agent-team", `Team: ${activeTeamName} (${agentStates.size})`);
		const members = Array.from(agentStates.values()).map(s => displayName(s.def.name)).join(", ");
		_ctx.ui.notify(
			`Team: ${activeTeamName} (${members})\n` +
			`Team sets loaded from: .pi/agents/teams.yaml\n\n` +
			`/agents-team          Select a team\n` +
			`/agents-list          List active agents and status\n` +
			`/agents-grid <1-6>    Set grid column count`,
			"info",
		);
		updateWidget();

		// Footer: model | team | context bar
		_ctx.ui.setFooter((_tui, theme, _footerData) => ({
			dispose: () => {},
			invalidate() {},
			render(width: number): string[] {
				const model = _ctx.model?.id || "no-model";
				const usage = _ctx.getContextUsage();
				const pct = usage ? usage.percent : 0;
				const filled = Math.round(pct / 10);
				const bar = "#".repeat(filled) + "-".repeat(10 - filled);

				const left = theme.fg("dim", ` ${model}`) +
					theme.fg("muted", " · ") +
					theme.fg("accent", activeTeamName);
				const right = theme.fg("dim", `[${bar}] ${Math.round(pct)}% `);
				const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));

				return [truncateToWidth(left + pad + right, width)];
			},
		}));
	});
}
