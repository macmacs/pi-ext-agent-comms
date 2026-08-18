/**
 * Pi Pi — Meta-agent that builds Pi agents
 *
 * A team of domain-specific research experts (extensions, themes, skills,
 * settings, TUI) operate in PARALLEL to gather documentation and patterns.
 * The primary agent synthesizes their findings and WRITES the actual files.
 *
 * Each expert fetches fresh Pi documentation via firecrawl on first query.
 * Experts are read-only researchers. The primary agent is the only writer.
 *
 * Commands:
 *   /experts          — list available experts and their status
 *   /experts-grid N   — set dashboard column count (default 3)
 *   /experts-model    — set or clear session-wide model override for an expert
 *
 * Usage: pi -e extensions/pi-pi.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { spawn } from "child_process";
import { readdirSync, readFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { applyExtensionDefaults } from "./lib/themeMap.ts";

// ── Types ────────────────────────────────────────

interface ExpertDef {
	name: string;
	description: string;
	tools: string;
	extensions: string[];
	systemPrompt: string;
	model?: string;      // Optional per-expert model defined in .md frontmatter
	timeout?: number;    // Optional per-expert timeout in seconds (default: 300)
	file: string;
}

interface ExpertState {
	def: ExpertDef;
	status: "idle" | "researching" | "done" | "error" | "cancelled" | "timeout";
	question: string;
	elapsed: number;
	lastLine: string;
	queryCount: number;
	runtimeModel?: string; // Session-wide override chosen by the orchestrator
	runningModel?: string; // Model currently being used (only when status === "researching")
	timer?: ReturnType<typeof setInterval>;
	outputPath?: string;    // Path to the most recent saved output file for this expert
}

// ── Helpers ──────────────────────────────────────

function displayName(name: string): string {
	return name.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function stripProvider(modelId?: string): string {
	if (!modelId) return "default";
	const parts = modelId.split('/');
	return parts[parts.length - 1];
}

function parseAgentFile(filePath: string): ExpertDef | null {
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
				? frontmatter.extensions.split(",").map((e) => e.trim()).filter(Boolean)
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

// ── Extension path resolution ────────────────────

function resolveExtPath(ext: string, cwd: string): string {
	if (ext.startsWith("npm:") || ext.startsWith("git:")) return ext;
	if (ext.startsWith("/") || /^[A-Za-z]:[\/\\]/.test(ext)) return ext;
	return resolve(cwd, ext);
}

// ── Expert card colors ────────────────────────────
// Each expert gets a unique hue: bg fills the card interior,
// br is the matching border foreground (brighter shade of same hue).
const EXPERT_COLORS: Record<string, { bg: string; br: string }> = {
	"agent-expert":      { bg: "\x1b[48;2;20;30;75m",  br: "\x1b[38;2;70;110;210m"  }, // navy
	"config-expert":     { bg: "\x1b[48;2;18;65;30m",  br: "\x1b[38;2;55;175;90m"   }, // forest
	"ext-expert":        { bg: "\x1b[48;2;80;18;28m",  br: "\x1b[38;2;210;65;85m"   }, // crimson
	"keybinding-expert": { bg: "\x1b[48;2;50;22;85m",  br: "\x1b[38;2;145;80;220m"  }, // violet
	"prompt-expert":     { bg: "\x1b[48;2;80;55;12m",  br: "\x1b[38;2;215;150;40m"  }, // amber
	"skill-expert":      { bg: "\x1b[48;2;12;65;75m",  br: "\x1b[38;2;40;175;195m"  }, // teal
	"theme-expert":      { bg: "\x1b[48;2;80;18;62m",  br: "\x1b[38;2;210;55;160m"  }, // rose
	"tui-expert":        { bg: "\x1b[48;2;28;42;80m",  br: "\x1b[38;2;85;120;210m"  }, // slate
	"cli-expert":        { bg: "\x1b[48;2;60;80;20m",  br: "\x1b[38;2;160;210;55m"  }, // olive/lime
};
const FG_RESET = "\x1b[39m";
const BG_RESET = "\x1b[49m";

// ── Extension ────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const experts: Map<string, ExpertState> = new Map();
	let gridCols = 3;
	let widgetCtx: any;

	function loadExperts(cwd: string) {
		// Pi Pi experts live in their own dedicated directory
		const piPiDir = join(cwd, ".pi", "agents", "pi-pi");

		experts.clear();

		if (!existsSync(piPiDir)) return;
		try {
			for (const file of readdirSync(piPiDir)) {
				if (!file.endsWith(".md")) continue;
				if (file === "pi-orchestrator.md") continue;
				const fullPath = resolve(piPiDir, file);
				const def = parseAgentFile(fullPath);
				if (def) {
					const key = def.name.toLowerCase();
					if (!experts.has(key)) {
						experts.set(key, {
							def,
							status: "idle",
							question: "",
							elapsed: 0,
							lastLine: "",
							queryCount: 0,
						});
					}
				}
			}
		} catch {}
	}

	// ── Grid Rendering ───────────────────────────

	function renderCard(state: ExpertState, colWidth: number, theme: any): string[] {
		const w = Math.max(1, colWidth - 2);
		const truncate = (s: string, max: number) => {
			const cleaned = s.replace(/\t/g, "        ");  // Tab width 8
			if (visibleWidth(cleaned) <= max) return cleaned;
			return truncateToWidth(cleaned, Math.max(0, max - 3)) + "...";
		};

		const statusColor = state.status === "idle" ? "dim"
			: state.status === "researching" ? "accent"
			: state.status === "done" ? "success"
			: state.status === "cancelled" ? "warning"
			: state.status === "timeout" ? "warning" : "error";
		const statusIcon = state.status === "idle" ? "○"
			: state.status === "researching" ? "◉"
			: state.status === "done" ? "✓"
			: state.status === "cancelled" ? "⊘"
			: state.status === "timeout" ? "⏱" : "✗";

		const nameText = displayName(state.def.name);
		const modelName = state.status === "researching"
			? stripProvider(state.runningModel || state.runtimeModel || state.def.model || "default")
			: stripProvider(state.runtimeModel || state.def.model || "default");
		const sep = " — ";
		const combined = nameText + sep + modelName;

		let nameStr: string;
		let nameVisible: number;

		if (visibleWidth(combined) <= w) {
			nameStr = theme.fg("accent", theme.bold(nameText)) + theme.fg("dim", sep + modelName);
			nameVisible = visibleWidth(combined);
		} else {
			const truncated = truncate(nameText, w);
			nameStr = theme.fg("accent", theme.bold(truncated));
			nameVisible = visibleWidth(truncated);
		}

		const statusStr = `${statusIcon} ${state.status}`;
		const timeStr = state.status !== "idle" ? ` ${Math.round(state.elapsed / 1000)}s` : "";
		const queriesStr = state.queryCount > 0 ? ` (${state.queryCount})` : "";
		const statusLine = theme.fg(statusColor, statusStr + timeStr + queriesStr);
		const statusVisible = statusStr.length + timeStr.length + queriesStr.length;

		const workRaw = state.question || state.def.description;
		const workText = truncate(workRaw, Math.min(50, w - 1));
		const workLine = theme.fg("muted", workText);
		const workVisible = visibleWidth(workText);

		const lastRaw = state.lastLine || "";
		const lastText = truncate(lastRaw, Math.min(50, w - 1));
		const lastLineRendered = lastText ? theme.fg("dim", lastText) : theme.fg("dim", "—");
		const lastVisible = lastText ? visibleWidth(lastText) : 1;

		const colors = EXPERT_COLORS[state.def.name];
		const bg  = colors?.bg ?? "";
		const br  = colors?.br ?? "";
		const bgr = bg ? BG_RESET : "";
		const fgr = br ? FG_RESET : "";

		// br colors the box-drawing characters; bg fills behind them so the
		// full card — top line, side bars, bottom line — is one solid block.
		const bord = (s: string) => bg + br + s + bgr + fgr;

		const top = "┌" + "─".repeat(w) + "┐";
		const bot = "└" + "─".repeat(w) + "┘";

		// bg fills the inner content area; re-applied before padding to ensure
		// the full row is colored even if theme.fg uses a full ANSI reset inside.
		const border = (content: string, visLen: number) => {
			const pad = " ".repeat(Math.max(0, w - visLen));
			return bord("│") + bg + content + bg + pad + bgr + bord("│");
		};

		return [
			bord(top),
			border(" " + nameStr, 1 + nameVisible),
			border(" " + statusLine, 1 + statusVisible),
			border(" " + workLine, 1 + workVisible),
			border(" " + lastLineRendered, 1 + lastVisible),
			bord(bot),
		];
	}

	function updateWidget() {
		if (!widgetCtx) return;

		widgetCtx.ui.setWidget("pi-pi-grid", (_tui: any, theme: any) => {

			return {
				render(width: number): string[] {
					if (experts.size === 0) {
						return ["", theme.fg("dim", "  No experts found. Add agent .md files to .pi/agents/pi-pi/")];
					}

					const cols = Math.min(gridCols, experts.size);
					const gap = 1;
					const rawColWidth = Math.floor((width - gap * (cols - 1)) / cols) - 1;
					const colWidth = Math.max(8, rawColWidth);  // Minimum 8 for border + content
					const allExperts = Array.from(experts.values());

					const lines: string[] = [""]; // top margin

					for (let i = 0; i < allExperts.length; i += cols) {
						const rowExperts = allExperts.slice(i, i + cols);
						const cards = rowExperts.map(e => renderCard(e, colWidth, theme));

						while (cards.length < cols) {
							cards.push(Array(6).fill(" ".repeat(colWidth)));
						}

						const cardHeight = cards[0].length;
						for (let line = 0; line < cardHeight; line++) {
							lines.push(cards.map(card => card[line] || "").join(" ".repeat(gap)));
						}
					}

					return lines;
				},
				invalidate() {},
			};
		});
	}

	// ── Shared expert prompt fragment ───────────

	function loadCommonPrompt(cwd: string): string {
		const paths = [
			join(cwd, ".pi", "agents", "pi-pi", "common.md"),
			join(cwd, ".pi", "agents", "pi-pi", "_common.md"),
		];
		for (const p of paths) {
			if (existsSync(p)) {
				try { return readFileSync(p, "utf-8").trim(); } catch {}
			}
		}
		return "";
	}

	// ── Query Expert ─────────────────────────────

	function queryExpert(
		expertName: string,
		question: string,
		ctx: any,
		modelOverride?: string,
		signal?: AbortSignal,
		timeoutOverride?: number,
	): Promise<{ output: string; exitCode: number; elapsed: number; model: string; timedOut?: boolean }> {
		const key = expertName.toLowerCase();
		const state = experts.get(key);
		if (!state) {
			return Promise.resolve({
				output: `Expert "${expertName}" not found. Available: ${Array.from(experts.values()).map(s => s.def.name).join(", ")}`,
				exitCode: 1,
				elapsed: 0,
				model: modelOverride || "n/a",
			});
		}

		// Bail out immediately if already cancelled
		if (signal?.aborted) {
			return Promise.resolve({
				output: "Cancelled by user",
				exitCode: -1, // sentinel: -1 means cancelled, not error
				elapsed: 0,
				model: modelOverride || state.runtimeModel || state.def.model || "n/a",
			});
		}

		if (state.status === "researching") {
			return Promise.resolve({
				output: `Expert "${displayName(state.def.name)}" is already researching. Wait for it to finish.`,
				exitCode: 1,
				elapsed: 0,
				model: modelOverride || state.runtimeModel || state.def.model || "n/a",
			});
		}

		state.status = "researching";
		state.question = question;
		state.elapsed = 0;
		state.lastLine = "";
		state.queryCount++;
		updateWidget();

		const startTime = Date.now();
		state.timer = setInterval(() => {
			state.elapsed = Date.now() - startTime;
			updateWidget();
		}, 1000);

		const DEFAULT_EXPERT_TIMEOUT_S = 300;
		const agentTimeoutMs = (timeoutOverride || state.def.timeout || DEFAULT_EXPERT_TIMEOUT_S) * 1000;

		const fallbackModel = "openrouter/google/gemini-3-flash-preview";
		const sessionModelFlag = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : fallbackModel;

		// Priority: tool param override > runtime override > expert definition model > session model > fallback
		const model = modelOverride || state.runtimeModel || state.def.model || sessionModelFlag;
		state.runningModel = model;

		const commonPrompt = loadCommonPrompt(ctx.cwd);
		const fullSystemPrompt = commonPrompt
			? `${commonPrompt}\n\n---\n\n${state.def.systemPrompt}`
			: state.def.systemPrompt;

		const args = [
			"--mode", "json",
			"-p",
			"--no-session",
			"--no-extensions",
			...state.def.extensions.flatMap((ext) => ["-e", resolveExtPath(ext, ctx.cwd)]),
			"--model", model,
			"--tools", state.def.tools,
			"--thinking", "off",
			"--append-system-prompt", fullSystemPrompt,
			question,
		];

		const textChunks: string[] = [];
		const stderrChunks: string[] = [];

		return new Promise((resolve) => {
			const proc = spawn("pi", args, {
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env },
			});

			// Kill the child process when the user presses Escape (abort signal fires)
			let wasTimedOut = false;
			const timeoutTimer = setTimeout(() => {
				wasTimedOut = true;
				clearInterval(state.timer);
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
				state.status = "timeout";
				state.lastLine = `Timed out after ${Math.round(agentTimeoutMs / 1000)}s`;
				state.runningModel = undefined;
				updateWidget();
			}, agentTimeoutMs);

			const onAbort = () => {
				clearTimeout(timeoutTimer);
				clearInterval(state.timer);
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
				state.status = "cancelled";
				state.lastLine = "Cancelled by user";
				state.runningModel = undefined;
				updateWidget();
			};
			signal?.addEventListener("abort", onAbort, { once: true });

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
								state.lastLine = last;
								updateWidget();
							}
						} else if (event.type === "message_end") {
							const msg = event.message;
							// Fallback: if text_deltas missed content, grab full text from final message
							if (msg?.content && textChunks.join("").length === 0) {
								const fullText = msg.content
									.filter((c: any) => c.type === "text")
									.map((c: any) => c.text || "")
									.join("");
								if (fullText) textChunks.push(fullText);
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
				signal?.removeEventListener("abort", onAbort);
				clearTimeout(timeoutTimer);

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
				state.runningModel = undefined;
				const full = textChunks.join("");

				if (wasTimedOut) {
					state.status = "timeout";
					state.lastLine = `Timed out after ${Math.round(agentTimeoutMs / 1000)}s`;
					updateWidget();
					resolve({
						output: full,
						exitCode: 1,
						elapsed: state.elapsed,
						model,
						timedOut: true,
					});
					return;
				}

				// If we were aborted, the onAbort handler already set state to cancelled.
				// Don't overwrite it with a successful close. Use exitCode: -1 as
				// a sentinel so the execute handler can mark status="cancelled".
				if (signal?.aborted) {
					state.status = "cancelled";
					state.lastLine = "Cancelled by user";
					updateWidget();
					resolve({
						output: "Cancelled by user",
						exitCode: -1,
						elapsed: state.elapsed,
						model,
					});
					return;
				}

				state.status = code === 0 ? "done" : "error";
				state.lastLine = full.split("\n").filter((l: string) => l.trim()).pop() || "";
				updateWidget();

				// Persist full output to disk so the orchestrator can re-read it later
				try {
					const outputDir = join(ctx.cwd, ".pi", "outputs");
					if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
					const expertKey = state.def.name.toLowerCase().replace(/\s+/g, "-");
					const uniquePath = join(outputDir, `${expertKey}_${Date.now()}.md`);
					let outputBody = full;
					if (stderrChunks.length > 0) {
						outputBody += "\n\n--- stderr ---\n" + stderrChunks.join("");
					}
					// Clean up previous output file for this expert to prevent accumulation
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
					model,
				});
			});

			proc.on("error", (err) => {
				signal?.removeEventListener("abort", onAbort);
				clearTimeout(timeoutTimer);
				clearInterval(state.timer);
				state.status = "error";
				state.runningModel = undefined;
				state.lastLine = `Error: ${err.message}`;
				updateWidget();
				resolve({
					output: `Error spawning expert: ${err.message}`,
					exitCode: 1,
					elapsed: Date.now() - startTime,
					model,
				});
			});
		});
	}

	// ── query_experts Tool (parallel) ───────────

	pi.registerTool({
		name: "query_experts",
		label: "Query Experts",
		description: `Query one or more Pi domain experts IN PARALLEL. All experts run simultaneously as concurrent subprocesses.

Pass an array of queries — each with an expert name and a specific question. All experts start at the same time and their results are returned together.

Available experts:
- ext-expert: Extensions — tools, events, commands, rendering, state management
- theme-expert: Themes — JSON format, 51 color tokens, vars, color values
- skill-expert: Skills — SKILL.md multi-file packages, scripts, references, frontmatter
- config-expert: Settings — settings.json, providers, models, packages, keybindings
- tui-expert: TUI — components, keyboard input, overlays, widgets, footers, editors
- prompt-expert: Prompt templates — single-file .md commands, arguments ($1, $@)
- agent-expert: Agent definitions — .md personas, tools, teams.yaml, orchestration
- keybinding-expert: Keyboard shortcuts — registerShortcut(), Key IDs, reserved keys, macOS terminal compatibility
- cli-expert: CLI — command line arguments, flags, environment variables, subcommands

Ask specific questions about what you need to BUILD. Each expert will return documentation excerpts, code patterns, and implementation guidance.

You may optionally pass a \`model\` field per query to override the expert's default for that specific call.`,

		parameters: Type.Object({
			queries: Type.Array(
				Type.Object({
					expert: Type.String({
						description: "Expert name: ext-expert, theme-expert, skill-expert, config-expert, tui-expert, prompt-expert, agent-expert, keybinding-expert, or cli-expert",
					}),
					question: Type.String({
						description: "Specific question about what you need to build. Include context about the target component.",
					}),
					model: Type.Optional(Type.String({
						description: "Override the model for this query. Format: provider/id (e.g. ollama-cloud/qwen3-coder-next). Uses expert default, session override, or session model if omitted.",
					})),
					timeout: Type.Optional(Type.Number({
						minimum: 1,
						description: "Override the timeout for this query in seconds. Uses expert default (from .md frontmatter) or 300s if omitted.",
					})),
				}),
				{ description: "Array of expert queries to run in parallel" },
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { queries } = params as { queries: { expert: string; question: string; model?: string; timeout?: number }[] };

			if (!queries || queries.length === 0) {
				return {
					content: [{ type: "text", text: "No queries provided." }],
					details: { results: [], status: "error" },
				};
			}

			const names = queries.map(q => displayName(q.expert)).join(", ");
			if (onUpdate) {
				onUpdate({
					content: [{ type: "text", text: `Querying ${queries.length} experts in parallel: ${names}` }],
					details: { queries, status: "researching", results: [] },
				});
			}

			// Launch ALL experts concurrently — allSettled so one failure
			// never discards results from the others
			const settled = await Promise.allSettled(
				queries.map(async ({ expert, question, model, timeout }) => {
					const result = await queryExpert(expert, question, ctx, model, signal, timeout);
					const expertKey = expert.toLowerCase().replace(/\s+/g, "-");
					const expertState = experts.get(expertKey);
					const outputPath = expertState?.outputPath || join(join(ctx.cwd, ".pi", "outputs"), `${expertKey}.md`);
					const MAX_PREVIEW = 2500;
					let preview = result.output;
					if (result.output.length > MAX_PREVIEW) {
						const idx = result.output.lastIndexOf("\n", MAX_PREVIEW);
						const cutAt = idx > 0 ? idx : MAX_PREVIEW;
						preview = result.output.slice(0, cutAt) + "\n\n... [truncated]";
					}
					const status = result.timedOut
						? "timeout"
						: result.exitCode === 0
						? "done"
						: result.exitCode === -1
						? "cancelled"
						: "error";
					// Annotate the model: tag per-query overrides with [override] and
					// session runtime overrides with [runtime] so the user can tell
					// which layer resolved the model.
					const modelTag = model
						? "override"
						: result.model && experts.get(expert.toLowerCase())?.runtimeModel
						? "runtime"
						: "default";
					return {
						expert,
						question,
						status,
						elapsed: result.elapsed,
						exitCode: result.exitCode,
						output: `${preview}\n\n[Full output: ${outputPath}]`,
						fullOutput: result.output,
						outputPath,
						model: result.model, // actual model resolved by the priority chain
						modelTag,
					};
				}),
			);

			const results = settled.map((s, i) =>
				s.status === "fulfilled"
					? s.value
					: {
						expert: queries[i].expert,
						question: queries[i].question,
						status: "error" as const,
						elapsed: 0,
						exitCode: 1,
						output: `Error: ${(s.reason as any)?.message || s.reason}`,
						fullOutput: "",
						model: queries[i].model,
						modelTag: queries[i].model ? "override" : "unknown",
					},
			);

			// Build combined response
			// Top-of-output summary: one line per expert showing the model that
			// actually got used (so the user can verify set_expert_model overrides).
			const summaryLines = results.map(r => {
				const icon = r.status === "done" ? "✓"
					: r.status === "cancelled" ? "⊘"
					: r.status === "timeout" ? "⏱" : "✗";
				const m = r.model || "?";
				return `  ${icon} ${displayName(r.expert)} → ${m} [${r.modelTag || "unknown"}]`;
			});
			const summary = `### Active models\n${summaryLines.join("\n")}\n\n---\n\n`;

			const sections = results.map(r => {
				const icon = r.status === "done" ? "✓"
					: r.status === "cancelled" ? "⊘"
					: r.status === "timeout" ? "⏱" : "✗";
				const modelInfo = r.model ? ` — model: ${r.model} [${r.modelTag}]` : "";
				return `## [${icon}] ${displayName(r.expert)} (${Math.round(r.elapsed / 1000)}s)${modelInfo}\n\n${r.output}`;
			});

			return {
				content: [{ type: "text", text: summary + sections.join("\n\n---\n\n") }],
				details: {
					results,
					status: signal?.aborted
						? "cancelled"
						: results.every(r => r.status === "done") ? "done" : "partial",
				},
			};
		},

		renderCall(args, theme) {
			const queries = (args as any).queries || [];
			const names = queries.map((q: any) => displayName(q.expert || "?")).join(", ");
			const modelOverrides = queries.filter((q: any) => q.model).map((q: any) => q.model);
			const modelHint = modelOverrides.length > 0 ? ` (model overrides: ${modelOverrides.join(", ")})` : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("query_experts ")) +
				theme.fg("accent", `${queries.length} parallel`) +
				theme.fg("dim", " — ") +
				theme.fg("muted", names + modelHint),
				0, 0,
			);
		},

		renderResult(result, options, theme) {
			const details = result.details as any;
			if (!details?.results) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (options.isPartial || details.status === "researching") {
				const count = details.queries?.length || "?";
				return new Text(
					theme.fg("accent", `◉ ${count} experts`) +
					theme.fg("dim", " researching in parallel..."),
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
				const modelTag = r.model ? ` [${r.model}]` : "";
				return theme.fg(color, `${icon} ${displayName(r.expert)}`) +
					theme.fg("dim", ` ${elapsed}s${modelTag}`);
			});

			const header = lines.join(theme.fg("dim", " · "));

			if (options.expanded && details.results) {
				const expanded = (details.results as any[]).map((r: any) => {
					const output = r.fullOutput
						? (r.fullOutput.length > 12000 ? r.fullOutput.slice(0, 12000) + "\n... [truncated]" : r.fullOutput)
						: r.output || "";
					const modelTag = r.model ? ` — model: ${r.model}` : "";
					return theme.fg("accent", `── ${displayName(r.expert)}${modelTag} ──`) + "\n" + theme.fg("muted", output);
				});
				return new Text(header + "\n\n" + expanded.join("\n\n"), 0, 0);
			}

			return new Text(header, 0, 0);
		},
	});

	// ── set_expert_model Tool ───────────────────

	pi.registerTool({
		name: "set_expert_model",
		label: "Set Expert Model",
		description: "Set or clear the session-wide default model for a specific expert. This affects all future query_experts calls unless a per-query model override is provided.",
		parameters: Type.Object({
			expert: Type.String({ description: "Expert name (case-insensitive)" }),
			model: Type.Optional(Type.String({ description: "Model in provider/id format (e.g. openrouter/google/gemini-3-flash-preview). Omit to clear the override and revert to the .md default." })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { expert, model } = params as { expert: string; model?: string };
			const key = expert.toLowerCase().replace(/\s+/g, "-");
			const state = experts.get(key);

			if (!state) {
				const available = Array.from(experts.values()).map(s => s.def.name).join(", ");
				return {
					content: [{ type: "text", text: `Expert "${expert}" not found. Available: ${available}` }],
					details: { expert, available, success: false },
				};
			}

			const previous = state.runtimeModel || state.def.model || "session default";

			if (model && model.trim()) {
				state.runtimeModel = model.trim();
			} else {
				delete state.runtimeModel;
			}

			const current = state.runtimeModel || state.def.model || "session default";

			return {
				content: [{ type: "text", text: `Model for ${displayName(state.def.name)} changed from \`${previous}\` to \`${current}\`.` }],
				details: { expert: state.def.name, previous, current, success: true },
			};
		},

		renderCall(args, theme) {
			const { expert, model } = args as any;
			const action = model ? `→ ${model}` : "reset to default";
			return new Text(
				theme.fg("toolTitle", theme.bold("set_expert_model ")) +
				theme.fg("accent", expert || "?") +
				theme.fg("dim", " — ") +
				theme.fg("muted", action),
				0, 0,
			);
		},

		renderResult(result, options, theme) {
			const details = (result.details || {}) as any;
			if (options.isPartial) {
				return new Text(theme.fg("accent", "● set_expert_model") + theme.fg("dim", " working..."), 0, 0);
			}
			if (details.success) {
				return new Text(
					theme.fg("success", `✓ ${displayName(details.expert)}`) +
					theme.fg("dim", ` → ${details.current}`),
					0, 0,
				);
			}
			return new Text(theme.fg("error", `✗ ${details.expert || "?"} — not found`), 0, 0);
		},
	});

	// ── Commands ─────────────────────────────────

	pi.registerCommand("experts", {
		description: "List available Pi Pi experts and their status",
		handler: async (_args, _ctx) => {
			widgetCtx = _ctx;
			const lines = Array.from(experts.values())
				.map(s => {
					const modelInfo = s.runtimeModel
						? ` [runtime model: ${s.runtimeModel}]`
						: s.def.model
						? ` [default model: ${s.def.model}]`
						: "";
					return `${displayName(s.def.name)} (${s.status}, queries: ${s.queryCount})${s.def.extensions.length ? ` [ext: ${s.def.extensions.join(", ")}]` : ""}${modelInfo}: ${s.def.description}`;
				})
				.join("\n");
			_ctx.ui.notify(lines || "No experts loaded", "info");
		},
	});

	pi.registerCommand("experts-grid", {
		description: "Set expert grid columns: /experts-grid <1-5>",
		handler: async (args, _ctx) => {
			widgetCtx = _ctx;
			const n = parseInt(args?.trim() || "", 10);
			if (n >= 1 && n <= 5) {
				gridCols = n;
				_ctx.ui.notify(`Grid set to ${gridCols} columns`, "info");
				updateWidget();
			} else {
				_ctx.ui.notify("Usage: /experts-grid <1-5>", "error");
			}
		},
	});

	pi.registerCommand("experts-model", {
		description: "Set or clear session-wide model for an expert: /experts-model <expert> [model]",
		handler: async (args, _ctx) => {
			widgetCtx = _ctx;
			const parts = args?.trim().split(/\s+/) || [];
			const expertName = parts[0];
			const model = parts.slice(1).join(" ") || undefined;

			if (!expertName) {
				_ctx.ui.notify("Usage: /experts-model <expert> [model] — omit model to reset to .md default", "error");
				return;
			}

			const key = expertName.toLowerCase().replace(/\s+/g, "-");
			const state = experts.get(key);
			if (!state) {
				_ctx.ui.notify(`Expert "${expertName}" not found`, "error");
				return;
			}

			const previous = state.runtimeModel || state.def.model || "session default";
			if (model) {
				state.runtimeModel = model;
			} else {
				delete state.runtimeModel;
			}
			const current = state.runtimeModel || state.def.model || "session default";
			_ctx.ui.notify(`Model for ${displayName(state.def.name)}: ${previous} → ${current}`, "info");
		},
	});

	// ── System Prompt ────────────────────────────

	pi.on("before_agent_start", async (_event, _ctx) => {
		const expertCatalog = Array.from(experts.values())
			.map(s => {
				const defaultModel = s.def.model || "session default";
				const runtimeModel = s.runtimeModel ? `\n**Session override:** \`${s.runtimeModel}\`` : "";
				const timeoutLabel = s.def.timeout ? `${s.def.timeout}s` : "default (300s)";
				return `### ${displayName(s.def.name)}\n**Query as:** \`${s.def.name}\`\n${s.def.description}${s.def.extensions.length ? `\n**Extensions:** ${s.def.extensions.join(", ")}` : ""}\n**Default model:** \`${defaultModel}\`\n**Timeout:** \`${timeoutLabel}\`${runtimeModel}`;
			})
			.join("\n\n");

		const expertNames = Array.from(experts.values()).map(s => displayName(s.def.name)).join(", ");

		const orchestratorPath = join(_ctx.cwd, ".pi", "agents", "pi-pi", "pi-orchestrator.md");
		let systemPrompt = "";
		try {
			const raw = readFileSync(orchestratorPath, "utf-8");
			const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
			const template = match ? match[2].trim() : raw;
			
			systemPrompt = template
				.replace("{{EXPERT_COUNT}}", experts.size.toString())
				.replace("{{EXPERT_NAMES}}", expertNames)
				.replace("{{EXPERT_CATALOG}}", expertCatalog);

			// Append instruction about model selection, timeout, and retrieving outputs from disk
			systemPrompt +=`
## Model Selection
Each expert has a default model defined in its \`.md\` file (shown above in **Default model**).
You can override the model for any individual query by adding a \`model\` field to the query object in \`query_experts\` (e.g., \`model: "ollama-cloud/qwen3-coder-next"\`).
You can also change the session-wide default for an expert using the \`set_expert_model\` tool.

Session overrides and per-query overrides are reset when the extension reloads.

## Timeout
Each expert has a default timeout (shown in catalog). Use the \`timeout\` parameter to override per-query. Minimum 1 second.
If an expert times out (⏱), it receives SIGTERM first, then SIGKILL after a 5-second grace period — retry with a shorter question or higher timeout.

## Cancellation
If the user interrupts a parallel query, running experts are killed with SIGTERM → SIGKILL after 5 seconds; queued experts are cancelled before they start.

## Filesystem
All experts share the same working directory and filesystem. Concurrent experts may race on shared files — direct them to use unique temporary filenames if isolation is needed.

## Retrieving Full Expert Outputs
Expert responses may be summarized in tool results. When you need the complete documentation from any expert, use your built-in \`read()\` tool on the file path shown in the result (e.g. \`.pi/outputs/ext-expert.md\`). Do NOT dispatch another agent just to read a file — your native \`read()\` tool reaches the filesystem directly.`;
		} catch (err) {
			systemPrompt = "Error: Could not load pi-orchestrator.md. Make sure it exists in .pi/agents/pi-pi/.";
		}

		return { systemPrompt };
	});

	// ── Session Start ────────────────────────────

	pi.on("session_start", async (_event, _ctx) => {
		applyExtensionDefaults(import.meta.url, _ctx);
		if (widgetCtx) {
			widgetCtx.ui.setWidget("pi-pi-grid", undefined);
		}
		widgetCtx = _ctx;

		loadExperts(_ctx.cwd);
		updateWidget();

		const expertNames = Array.from(experts.values()).map(s => displayName(s.def.name)).join(", ");
		_ctx.ui.setStatus("pi-pi", `Pi Pi (${experts.size} experts)`);
		_ctx.ui.notify(
			`Pi Pi loaded — ${experts.size} experts: ${expertNames}\n\n` +
			`/experts          List experts and status\n` +
			`/experts-grid N   Set grid columns (1-5)\n` +
			`/experts-model <expert> [model]  Set or clear session model override\n\n` +
			`Ask me to build any Pi agent component!`,
			"info",
		);

		// Custom footer
		_ctx.ui.setFooter((_tui, theme, _footerData) => ({
			dispose: () => {},
			invalidate() {},
			render(width: number): string[] {
				const model = _ctx.model?.id || "no-model";
				const usage = _ctx.getContextUsage();
				const pct = usage ? usage.percent : 0;
				const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
				const bar = "#".repeat(filled) + "-".repeat(10 - filled);

				const active = Array.from(experts.values()).filter(e => e.status === "researching").length;
				const done = Array.from(experts.values()).filter(e => e.status === "done").length;

				const left = theme.fg("dim", ` ${model}`) +
					theme.fg("muted", " · ") +
					theme.fg("accent", "Pi Pi");
				const mid = active > 0
					? theme.fg("accent", ` ◉ ${active} researching`)
					: done > 0
					? theme.fg("success", ` ✓ ${done} done`)
					: "";
				const right = theme.fg("dim", `[${bar}] ${Math.round(pct)}% `);
				const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(mid) - visibleWidth(right)));

				return [truncateToWidth(left + mid + pad + right, width)];
			},
		}));
	});
}
