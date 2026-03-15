import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const BRAINSTORM_MODE_ENTRY = "brainstorm-mode";
const BRAINSTORM_MODE_TOOL_CANDIDATES = [
	"read",
	"grep",
	"find",
	"lsp",
	"fetch",
	"web_search",
	"ask",
	"exitbrainstorm",
] as const;

const brainstormPrompt = `
# Brainstorming Ideas Into Designs

## Overview

Transform rough ideas into fully-formed designs through structured questioning and alternative exploration.

**Core principle:** Ask questions to understand, explore alternatives, present the design incrementally for validation.

**Announce at start:** "I'm refining your idea into a design."
**Always use the same language as the user's latest message unless the user explicitly asks otherwise.**

## CRITICAL CONSTRAINTS
- **DO NOT WRITE PRODUCTION CODE** (except very small illustrative snippets when they genuinely clarify a design point).
- **DO NOT EDIT FILES OR ATTEMPT IMPLEMENTATION WORK**.
- This is a **DESIGN** phase, not an implementation phase.
- Even if the input looks like a coding task, you must treat it as a topic for design discussion first.
- The environment is intentionally restricted to read-only analysis tools while brainstorm mode is active.


## The Process

### Phase 1: Understanding
- Inspect the current project state when needed.
- Ask **one clarification question at a time** to refine the idea.
- **Use the Ask tool when asking clarification questions.**
- Prefer multiple choice options when possible.
- Gather: purpose, constraints, risks, success criteria.


### Phase 2: Exploration
- Propose 2-3 viable approaches before converging.
- For each approach cover: architecture, trade-offs, complexity, and failure modes.
- Ask the human partner which approach resonates and why.


### Phase 3: Design Presentation
- Present the chosen design in short, digestible sections.
- Cover: architecture, components, data flow, error handling, and testing strategy.
- After each section, ask whether it still looks right.
- **During intermediate validation turns, do NOT call exitbrainstorm.**
- A message is NOT final if it asks a question, requests confirmation, asks what to refine next, or leaves any design section incomplete.
- **Only call exitbrainstorm after the current message already contains the full final design in one turn.**
- The full final design must cover architecture, components, data flow, error handling, and testing strategy.


## Completion
- When the design is complete and ready for next-step handling, you MUST call the exitbrainstorm tool.
- Do not call exitbrainstorm during intermediate validation turns—only when truly finished.
- You MUST NOT call exitbrainstorm if the current message contains any open question, asks for confirmation, or needs more user input.
- If more user input is needed, remain in brainstorm mode and use the Ask tool instead.
- The tool is only for signaling that the full final design has already been presented and is ready for next-step handling.


## When to Revisit Earlier Phases

You can and should go backward when:
- A new constraint appears during exploration or presentation.
- Validation exposes a requirement gap.
- The proposed approach is being questioned and alternatives need to be revisited.
- Something does not make sense yet and needs clarification.


## Remember
- One question per message during Phase 1.
- Apply YAGNI ruthlessly.
- Explore alternatives before settling.
- Present incrementally and validate as you go.
- Flexibility beats forcing a linear process.
- Do not edit files or write production code during brainstorming.
- Call exitbrainstorm only when the final design is complete.
`;

function createSaveDesignPrompt(): string {
	return `
# Save Brainstorming Session as Design Document

You are continuing in the current session after a brainstorm save request.
Your task is to derive the design document from the current session's brainstorm conversation history.

Locate the current brainstorm run in session history:
- Prefer the most recent /brainstorm invocation as the start boundary.
- If there is no literal /brainstorm command in history (e.g., brainstorm mode was entered via shortcut/flag), use the recent brainstorm discussion immediately preceding this save request and ignore earlier unrelated conversation.

Collect the relevant user and assistant messages from that brainstorm run, then:

1. Infer the main feature/topic being designed.
2. Transform that discussion into a cohesive design document with clear sections.
3. Generate a short, descriptive slug (3-5 words, lowercase, hyphen-separated) from the main topic.
4. Get the current date in YYYY-MM-DD format.
5. Construct the filename as docs/designs/YYYY-MM-DD-<slug>.md.
6. If a file with that name already exists, adjust by either appending a suffix like -1, -2 or a short timestamp.
7. If the docs/designs directory does not exist, create it.
8. Use the write tool to create the file with the generated filename and design content.
9. At the end, print the final file path you wrote to.

The design document MUST follow this structure:

# [Feature Name]

**Date:** YYYY-MM-DD

## Context
Summarize the initial idea and motivation based on the brainstorming discussion.

## Discussion
Summarize key questions, answers, trade-offs, and explored alternatives from the conversation.

## Approach
Summarize the final agreed direction and how it solves the problem.

## Architecture
Describe technical details, components, flows, and important implementation notes if discussed.

Remember:
- Stay in the current session.
- Derive the design from the brainstorm conversation history; do not rely on an external snapshot.
- Do not include raw chat logs; only the distilled design.
- Always use the same language as the user's latest message unless the user explicitly asks otherwise.
`;
}

interface PendingBrainstormExitAction {
	type: "exit";
	createdAt: string;
}

interface BrainstormModeState {
	enabled: boolean;
	previousActiveTools: string[] | null;
	pendingExit: PendingBrainstormExitAction | null;
}

function getSavedState(ctx: ExtensionContext): BrainstormModeState | undefined {
	let state: BrainstormModeState | undefined;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom") {
			continue;
		}

		const customEntry = entry as {
			customType?: string;
			data?: BrainstormModeState;
		};
		if (customEntry.customType === BRAINSTORM_MODE_ENTRY && customEntry.data) {
			state = customEntry.data;
		}
	}

	return state;
}

export default function brainstormModeExtension(pi: ExtensionAPI) {
	const { Type } = pi.typebox;

	let brainstormModeEnabled = false;
	let previousActiveTools: string[] | null = null;
	let pendingExit: PendingBrainstormExitAction | null = null;

	function getBrainstormTools(): string[] {
		const allTools = new Set(pi.getAllTools());
		return [...BRAINSTORM_MODE_TOOL_CANDIDATES].filter((tool) =>
			allTools.has(tool),
		);
	}

	function filterAvailableTools(tools: string[] | null | undefined): string[] {
		if (!tools || tools.length === 0) {
			return [];
		}

		const allTools = new Set(pi.getAllTools());
		return tools.filter((tool) => allTools.has(tool));
	}

	function isBrainstormCommand(text: string): boolean {
		const trimmed = text.trim();
		if (!trimmed.startsWith("/")) {
			return false;
		}

		const spaceIndex = trimmed.indexOf(" ");
		const commandName =
			spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex);

		return commandName === "brainstorm";
	}


	function persistState() {
		pi.appendEntry<BrainstormModeState>(BRAINSTORM_MODE_ENTRY, {
			enabled: brainstormModeEnabled,
			previousActiveTools: previousActiveTools
				? [...previousActiveTools]
				: null,
			pendingExit,
		});
	}

	function setPendingExit(exit: PendingBrainstormExitAction | null) {
		pendingExit = exit;
		persistState();
	}

	async function applyBrainstormTools(): Promise<string[]> {
		const brainstormTools = getBrainstormTools();
		await pi.setActiveTools(brainstormTools);
		return brainstormTools;
	}

	async function enableBrainstormMode(ctx: ExtensionContext) {
		if (brainstormModeEnabled) {
			return;
		}

		previousActiveTools = [...pi.getActiveTools()];
		brainstormModeEnabled = true;

		const brainstormTools = await applyBrainstormTools();
		persistState();

		ctx.ui.notify(
			`Brainstorm mode enabled. Tools: ${brainstormTools.join(", ") || "none"}. File-writing tools are disabled.`,
			"info",
		);
	}

	async function disableBrainstormMode(ctx: ExtensionContext) {
		if (!brainstormModeEnabled) {
			return;
		}

		const restoredTools = filterAvailableTools(previousActiveTools);
		const nextTools =
			restoredTools.length > 0 ? restoredTools : pi.getAllTools();
		await pi.setActiveTools(nextTools);

		brainstormModeEnabled = false;
		previousActiveTools = [...nextTools];
		pendingExit = null;
		persistState();

		ctx.ui.notify(
			"Brainstorm mode disabled. Previous tool access restored.",
			"info",
		);
	}

	async function toggleBrainstormMode(ctx: ExtensionContext) {
		if (brainstormModeEnabled) {
			await disableBrainstormMode(ctx);
			return;
		}

		await enableBrainstormMode(ctx);
	}

	async function restoreState(ctx: ExtensionContext) {
		const savedState = getSavedState(ctx);

		brainstormModeEnabled = savedState?.enabled ?? false;
		previousActiveTools = savedState?.previousActiveTools ?? null;
		pendingExit = savedState?.pendingExit ?? null;
		if (pi.getFlag("brainstorm") === true && !brainstormModeEnabled) {
			brainstormModeEnabled = true;
			previousActiveTools = [...pi.getActiveTools()];
		}

		if (brainstormModeEnabled) {
			if (!previousActiveTools || previousActiveTools.length === 0) {
				previousActiveTools = [...pi.getActiveTools()];
			}

			await applyBrainstormTools();
		} else {
			const restoredTools = filterAvailableTools(previousActiveTools);
			if (restoredTools.length > 0) {
				await pi.setActiveTools(restoredTools);
			}
		}

	}

	async function handleSaveDesignSelection(ctx: ExtensionContext) {
		await disableBrainstormMode(ctx);
		pi.sendUserMessage(createSaveDesignPrompt());
		ctx.ui.notify("Started save flow in the current session.", "info");
	}

	async function handleBrainstormAgentEnd(
		_event: { messages?: Array<{ role?: string; content?: unknown }> },
		ctx: ExtensionContext,
	) {
		if (!brainstormModeEnabled || !ctx.hasUI) {
			return;
		}

		// Only react to explicit exitbrainstorm tool requests
		if (!pendingExit) {
			return;
		}

		const choice = await ctx.ui.select("Brainstorm - what next?", [
			"Save design",
			"Stay in brainstorm",
			"Refine design",
		]);

		if (choice === "Save design") {
			setPendingExit(null);
			await handleSaveDesignSelection(ctx);
			return;
		}

		if (choice === "Stay in brainstorm") {
			setPendingExit(null);
			return;
		}

		if (choice === "Refine design") {
			setPendingExit(null);
			const refinement = await ctx.ui.input("What should be refined?");
			if (refinement) {
				ctx.ui.setEditorText(refinement);
			}
		}
	}

	pi.registerFlag("brainstorm", {
		description: "Start in brainstorm mode (design-first, read-only analysis)",
		type: "boolean",
		default: false,
	});

	pi.registerTool({
		name: "exitbrainstorm",
		label: "Exit Brainstorm",
description:
			"Call only after the current assistant message already contains the full final brainstorm design. Do not call during clarification, exploration, intermediate validation, or while asking follow-up questions.",
		parameters: Type.Object({}),
		async execute(_toolCallId) {
			if (!brainstormModeEnabled) {
				return {
					content: [{ type: "text", text: "Brainstorm mode is not enabled." }],
					details: { recorded: false },
				};
			}
			setPendingExit({
				type: "exit",
				createdAt: new Date().toISOString(),
			});
			return {
				content: [
					{
						type: "text",
text: "Final brainstorm completion request recorded."
					},
				],
				details: { recorded: true },
			};
		},
	});

	pi.registerCommand("brainstorm", {
		description: "Toggle brainstorm mode (design-first, read-only analysis)",
		handler: async (_args, ctx) => {
			await toggleBrainstormMode(ctx);
		},
	});

	pi.registerShortcut("shift+b", {
		description: "Toggle brainstorm mode",
		handler: async (ctx) => {
			await toggleBrainstormMode(ctx);
		},
	});

	pi.on("input", async (event, ctx) => {
		if (event.source !== "interactive") {
			return;
		}

		if (!isBrainstormCommand(event.text)) {
			return;
		}

		await toggleBrainstormMode(ctx);
		return { handled: true };
	});

	pi.on("before_agent_start", async (event) => {
		if (!brainstormModeEnabled) {
			return;
		}

		const allowedTools = getBrainstormTools();
		return {
			systemPrompt: `${event.systemPrompt}\n\n${brainstormPrompt}\n\n## Active Brainstorm Mode Tool Policy\n- Allowed tools in this mode: ${allowedTools.join(", ") || "none"}.\n- Do not attempt implementation, file edits, or tool reconfiguration from inside the agent turn.\n- Stay in design, trade-off analysis, and clarification mode until brainstorm mode is turned off.`,
		};
	});

	pi.on("agent_end", async (event, ctx) => {
		await handleBrainstormAgentEnd(event, ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		await restoreState(ctx);
	});

	pi.on("session_branch", async (_event, ctx) => {
		await restoreState(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await restoreState(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		await restoreState(ctx);
	});

	pi.on("turn_start", async (_event, _ctx) => {
		persistState();
	});
}
