import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { parseModelString } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { parseCommandArgs } from "@oh-my-pi/pi-coding-agent/utils/command-args";
import {
	type Component,
	Container,
	Input,
	SelectList,
	Spacer,
	Text,
	fuzzyFilter,
	matchesKey,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as yaml from "js-yaml";

// ============================================================================
// Types
// ============================================================================

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

interface ModelProfile {
	model: string; // "provider/modelId" e.g. "anthropic/claude-opus-4-5"
	thinking: ThinkingLevel;
	label?: string; // optional display name
}

// ============================================================================
// Constants
// ============================================================================

const THINKING_LEVELS: ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
];

const SETTINGS_KEY = "modelSwitcherProfiles";
const MODEL_SWITCH_SUBCOMMANDS = [
	{ name: "add", description: "Add a model profile" },
	{ name: "remove", description: "Remove a profile by index" },
	{ name: "list", description: "List configured profiles" },
] as const;

const BOX_SYMBOLS = {
	topLeft: "╭",
	topRight: "╮",
	bottomLeft: "╰",
	bottomRight: "╯",
	horizontal: "─",
	vertical: "│",
	teeDown: "┬",
	teeUp: "┴",
	teeLeft: "┤",
	teeRight: "├",
	cross: "┼",
} as const;

const SELECT_LIST_THEME = {
	selectedPrefix: (text: string) => text,
	selectedText: (text: string) => text,
	description: (text: string) => `\x1b[2m${text}\x1b[0m`,
	scrollInfo: (text: string) => `\x1b[2m${text}\x1b[0m`,
	noMatch: (text: string) => `\x1b[2m${text}\x1b[0m`,
	symbols: {
		cursor: "▶",
		inputCursor: "▏",
		boxRound: {
			topLeft: BOX_SYMBOLS.topLeft,
			topRight: BOX_SYMBOLS.topRight,
			bottomLeft: BOX_SYMBOLS.bottomLeft,
			bottomRight: BOX_SYMBOLS.bottomRight,
			horizontal: BOX_SYMBOLS.horizontal,
			vertical: BOX_SYMBOLS.vertical,
		},
		boxSharp: BOX_SYMBOLS,
		table: BOX_SYMBOLS,
		quoteBorder: "│",
		hrChar: "─",
		spinnerFrames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
	},
};

class HorizontalBorder implements Component {
	invalidate(): void {}

	render(width: number): string[] {
		return [BOX_SYMBOLS.horizontal.repeat(Math.max(1, width))];
	}
}

// ============================================================================
// Config Management (uses ~/.omp/agent/config.yml)
// ============================================================================

function getConfigPath(): string {
	return path.join(os.homedir(), ".omp", "agent", "config.yml");
}

interface ConfigData {
	[SETTINGS_KEY]?: ModelProfile[];
	[key: string]: unknown;
}

function readConfig(): ConfigData {
	const configPath = getConfigPath();
	try {
		const content = fs.readFileSync(configPath, "utf-8");
		return (yaml.load(content) as ConfigData) || {};
	} catch {
		return {};
	}
}

function writeConfig(config: ConfigData): void {
	const configPath = getConfigPath();
	const yamlContent = yaml.dump(config, { indent: 2, lineWidth: -1 });
	fs.writeFileSync(configPath, yamlContent, "utf-8");
}

// ============================================================================
// State
// ============================================================================

let activeProfileIndex: number | null = null;
let switchInProgress = false;
let profilesCache: ModelProfile[] = [];

// ============================================================================
// Profile Storage
// ============================================================================

async function loadProfiles(): Promise<ModelProfile[]> {
	try {
		const config = readConfig();
		const profiles = config[SETTINGS_KEY];
		if (!Array.isArray(profiles)) {
			return [];
		}
		// Validate each profile
		return profiles.filter(
			(p): p is ModelProfile =>
				p !== null &&
				typeof p === "object" &&
				"model" in p &&
				typeof p.model === "string" &&
				"thinking" in p &&
				typeof p.thinking === "string" &&
				THINKING_LEVELS.includes(p.thinking as ThinkingLevel),
		);
	} catch {
		return [];
	}
}

async function saveProfiles(
	ctx: ExtensionContext,
	profiles: ModelProfile[],
): Promise<boolean> {
	try {
		const config = readConfig();
		config[SETTINGS_KEY] = profiles;
		writeConfig(config);
		profilesCache = profiles;
		return true;
	} catch (err) {
		ctx.logger.debug("Failed to save model profiles:", err);
		ctx.ui.notify("Failed to save profiles", "error");
		return false;
	}
}

// ============================================================================
// Profile Utilities
// ============================================================================

function findActiveProfileIndex(
	profiles: ModelProfile[],
	currentModel: string,
	currentThinking: ThinkingLevel,
): number | null {
	const index = profiles.findIndex(
		(p) => p.model === currentModel && p.thinking === currentThinking,
	);
	return index >= 0 ? index : null;
}

function formatProfileDisplay(profile: ModelProfile, index: number): string {
	const label = profile.label || `#${index + 1}`;
	return `${label}`;
}

function formatProfileDescription(profile: ModelProfile): string {
	return `${profile.model}  [${profile.thinking}]`;
}

function getModelKey(model: ExtensionContext["model"]): string | null {
	if (!model) {
		return null;
	}

	return `${model.provider}/${model.id}`;
}

function getCurrentThinkingLevel(pi: ExtensionAPI): ThinkingLevel {
	const level = pi.getThinkingLevel();
	return THINKING_LEVELS.includes(level as ThinkingLevel) ? (level as ThinkingLevel) : "off";
}

function findRegistryModel(ctx: ExtensionContext, modelRef: string) {
	const parsed = parseModelString(modelRef);
	if (!parsed) {
		return undefined;
	}

	return ctx.modelRegistry.find(parsed.provider, parsed.id);
}

async function resolveCurrentThemeName(ctx: ExtensionContext): Promise<string | null> {
	const activeAccent = ctx.ui.theme.getFgAnsi("accent");

	// Read configured theme names from config.yml (same file the extension uses).
	// This avoids loading every installed theme from disk.
	const config = readConfig();
	const themeConfig = (config as Record<string, unknown>).theme as
		| { dark?: string; light?: string }
		| undefined;
	const candidates = new Set<string>();
	if (themeConfig?.dark) candidates.add(themeConfig.dark);
	if (themeConfig?.light) candidates.add(themeConfig.light);
	if (candidates.size === 0) {
		candidates.add("dark");
		candidates.add("light");
	}

	// Match by accent color only — it is unaffected by symbolPresetOverride
	// and colorBlindMode, which getThemeByName omits when loading.
	for (const name of candidates) {
		const t = await ctx.ui.getTheme(name);
		if (t && t.getFgAnsi("accent") === activeAccent) {
			return name;
		}
	}

	// Config miss: scan all available themes (rare — custom theme not in config).
	for (const { name } of await ctx.ui.getAllThemes()) {
		if (candidates.has(name)) continue;
		const t = await ctx.ui.getTheme(name);
		if (t && t.getFgAnsi("accent") === activeAccent) {
			return name;
		}
	}

	return null;
}

async function requestUiRefresh(ctx: ExtensionContext): Promise<void> {
	const themeName = await resolveCurrentThemeName(ctx);
	if (!themeName) {
		return;
	}

	// Re-applying the active theme triggers the normal top-border refresh path.
	await ctx.ui.setTheme(themeName);
}


// ============================================================================
// UI Components
// ============================================================================
type CustomUiComponent = Component & { dispose?(): void };

function buildCustomUiFactory<T>(
	create: (done: (result: T) => void) => CustomUiComponent,
) {
	return (...args: any[]) => create(args[3] as (result: T) => void);
}

class BorderedSelectListPicker extends Container {
	#selectList: SelectList;

	constructor(
		options: {
			title: string;
			footer: string;
			items: Array<{ label: string; value: string; description?: string }>;
			maxVisible: number;
			initialIndex?: number;
			onSelect: (value: string) => void;
			onCancel: () => void;
		},
	) {
		super();

		this.addChild(new HorizontalBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(options.title, 1, 0));
		this.addChild(new Spacer(1));

		this.#selectList = new SelectList(
			options.items,
			Math.max(1, options.maxVisible),
			SELECT_LIST_THEME,
		);
		if (options.initialIndex !== undefined) {
			this.#selectList.setSelectedIndex(options.initialIndex);
		}
		this.#selectList.onSelect = (item) => options.onSelect(item.value);
		this.#selectList.onCancel = options.onCancel;
		this.addChild(this.#selectList);

		this.addChild(new Spacer(1));
		this.addChild(new Text(`\x1b[2m${options.footer}\x1b[0m`, 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new HorizontalBorder());
	}

	handleInput(keyData: string): void {
		this.#selectList.handleInput(keyData);
	}
}

class SearchableModelPicker extends Container {
	#searchInput: Input;
	#listContainer: Container;
	#selectList: SelectList;
	#filteredModels: string[];

	constructor(
		private readonly allModels: string[],
		private readonly onSelectModel: (model: string) => void,
		private readonly onCancelPicker: () => void,
	) {
		super();

		this.#filteredModels = allModels;
		this.#searchInput = new Input();
		this.#searchInput.focused = true;
		this.#listContainer = new Container();
		this.#selectList = new SelectList([], 1, SELECT_LIST_THEME);

		this.addChild(new HorizontalBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text("Select model", 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.#searchInput);
		this.addChild(new Spacer(1));
		this.addChild(this.#listContainer);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text("\x1b[2mType to filter • ↑↓ navigate • enter select • esc cancel\x1b[0m", 1, 0),
		);
		this.addChild(new Spacer(1));
		this.addChild(new HorizontalBorder());

		this.#updateList();
	}

	#updateList(selectedValue?: string): void {
		const items = this.#filteredModels.map((model) => ({
			label: model,
			value: model,
		}));

		this.#selectList = new SelectList(
			items,
			Math.min(Math.max(items.length, 1), 10),
			SELECT_LIST_THEME,
		);
		if (selectedValue) {
			const selectedIndex = items.findIndex((item) => item.value === selectedValue);
			if (selectedIndex >= 0) {
				this.#selectList.setSelectedIndex(selectedIndex);
			}
		}
		this.#selectList.onSelect = (item) => this.onSelectModel(item.value);
		this.#selectList.onCancel = this.onCancelPicker;

		this.#listContainer.clear();
		this.#listContainer.addChild(this.#selectList);
	}

	#applyFilter(): void {
		const selectedValue = this.#selectList.getSelectedItem()?.value;
		this.#filteredModels = fuzzyFilter(this.allModels, this.#searchInput.getValue());
		this.#updateList(selectedValue);
	}

	handleInput(keyData: string): void {
		if (
			matchesKey(keyData, "up") ||
			matchesKey(keyData, "down") ||
			matchesKey(keyData, "pageUp") ||
			matchesKey(keyData, "pageDown") ||
			matchesKey(keyData, "enter") ||
			matchesKey(keyData, "return") ||
			keyData === "\n"
		) {
			this.#selectList.handleInput(keyData);
			return;
		}

		if (
			matchesKey(keyData, "escape") ||
			matchesKey(keyData, "esc") ||
			matchesKey(keyData, "ctrl+c")
		) {
			this.onCancelPicker();
			return;
		}

		this.#searchInput.handleInput(keyData);
		this.#applyFilter();
	}
}

async function pickProfileIndex(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	options: { title: string; footer: string; emptyMessage: string },
): Promise<{ profiles: ModelProfile[]; selectedIndex: number } | null> {
	const profiles = await loadProfiles();
	profilesCache = profiles;

	if (profiles.length === 0) {
		ctx.ui.notify(options.emptyMessage, "info");
		return null;
	}

	const currentModel = getModelKey(ctx.model);
	const currentThinking = getCurrentThinkingLevel(pi);
	activeProfileIndex = currentModel
		? findActiveProfileIndex(profiles, currentModel, currentThinking)
		: null;

	const items = profiles.map((profile, index) => {
		const isActive = index === activeProfileIndex;
		const display = formatProfileDisplay(profile, index);
		const description = formatProfileDescription(profile);
		return {
			label: isActive ? `${display} ✓` : display,
			value: String(index),
			description,
		};
	});

	const result = await ctx.ui.custom<string | null>(
		buildCustomUiFactory((done) =>
			new BorderedSelectListPicker({
				title: options.title,
				footer: options.footer,
				items,
				maxVisible: Math.min(profiles.length + 4, 12),
				initialIndex: activeProfileIndex ?? undefined,
				onSelect: done,
				onCancel: () => done(null),
			}),
		),
	);

	if (result === null || result === undefined) {
		return null;
	}

	const selectedIndex = Number(result);
	if (Number.isNaN(selectedIndex) || selectedIndex < 0) {
		return null;
	}

	return { profiles, selectedIndex };
}

async function showProfilePicker(ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
	const selection = await pickProfileIndex(ctx, pi, {
		title: "Model profiles",
		footer: "↑↓ navigate • enter switch • esc",
		emptyMessage: "No profiles. Use /model-switch add",
	});
	if (!selection) {
		return;
	}

	await switchToProfile(ctx, pi, selection.profiles, selection.selectedIndex);
}

async function showModelPicker(ctx: ExtensionContext): Promise<string | null> {
	const availableModels = ctx.modelRegistry
		.getAvailable()
		.map((model) => `${model.provider}/${model.id}`);
	if (availableModels.length === 0) {
		ctx.ui.notify("No models available in registry", "error");
		return null;
	}

	const result = await ctx.ui.custom<string | null>(
		buildCustomUiFactory((done) =>
			new SearchableModelPicker(
				availableModels,
				(model) => done(model),
				() => done(null),
			),
		),
	);

	if (result === null || result === undefined) {
		return null;
	}

	return String(result);
}

async function showThinkingLevelPicker(
	ctx: ExtensionContext,
): Promise<ThinkingLevel | null> {
	const items = THINKING_LEVELS.map((level) => ({
		label: level,
		value: level,
		description:
			level === "off"
				? "No thinking tokens"
				: level === "minimal"
					? "Minimal thinking"
					: level === "low"
						? "Low thinking level"
						: level === "medium"
							? "Medium thinking level"
							: level === "high"
								? "High thinking level"
								: "Maximum thinking",
	}));

	const result = await ctx.ui.custom<string | null>(
		buildCustomUiFactory((done) =>
			new BorderedSelectListPicker({
				title: "Select thinking level",
				footer: "↑↓ navigate • enter select • esc cancel",
				items,
				maxVisible: items.length,
				onSelect: done,
				onCancel: () => done(null),
			}),
		),
	);

	if (result === null || result === undefined) {
		return null;
	}

	return result as ThinkingLevel;
}

// ============================================================================
// Switch Logic
// ============================================================================

async function switchToProfile(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	profiles: ModelProfile[],
	index: number,
): Promise<void> {
	if (switchInProgress) {
		return;
	}

	if (index < 0 || index >= profiles.length) {
		ctx.ui.notify("Invalid profile index", "error");
		return;
	}

	const profile = profiles[index];
	if (!profile) {
		ctx.ui.notify("Profile not found", "error");
		return;
	}

	switchInProgress = true;
	try {
		const modelInfo = findRegistryModel(ctx, profile.model);
		if (!modelInfo) {
			ctx.ui.notify(`Model not found: ${profile.model}`, "warning");
			return;
		}

		const modelSet = await pi.setModel(modelInfo);
		if (!modelSet) {
			ctx.ui.notify(`No API key for: ${profile.model}`, "warning");
			return;
		}

		pi.setThinkingLevel(profile.thinking);
		activeProfileIndex = index;

		const displayLabel = profile.label || `#${index + 1}`;
		ctx.ui.notify(`Switched to ${displayLabel}`, "info");
		await requestUiRefresh(ctx);
	} finally {
		switchInProgress = false;
	}
}

// ============================================================================
// Command Handlers
// ============================================================================

function getModelSwitchArgumentCompletions(argumentPrefix: string) {
	const trimmed = argumentPrefix.trimStart().toLowerCase();
	if (trimmed.length === 0 || trimmed.includes(" ")) {
		return null;
	}

	if (MODEL_SWITCH_SUBCOMMANDS.some((subcommand) => subcommand.name === trimmed)) {
		return null;
	}

	const matches = MODEL_SWITCH_SUBCOMMANDS.filter((subcommand) =>
		subcommand.name.startsWith(trimmed),
	).map((subcommand) => ({
		value: `${subcommand.name} `,
		label: subcommand.name,
		description: subcommand.description,
	}));

	return matches.length > 0 ? matches : null;
}


async function handleAdd(
	ctx: ExtensionContext,
	args: string[],
): Promise<void> {
	let model: string | undefined;
	let thinking: ThinkingLevel | undefined;
	let label: string | undefined;

	// Check for text form: /model-switch add <model> <thinking> [label]
	if (args.length >= 2) {
		model = args[0];
		const thinkingArg = args[1]?.toLowerCase();

		if (!THINKING_LEVELS.includes(thinkingArg as ThinkingLevel)) {
			ctx.ui.notify(
				`Invalid thinking level. Use: ${THINKING_LEVELS.join("|")}`,
				"error",
			);
			return;
		}

		thinking = thinkingArg as ThinkingLevel;
		label = args.slice(2).join(" ") || undefined;

		// Validate model format
		if (!model.includes("/")) {
			ctx.ui.notify("Invalid format. Use: provider/modelId", "error");
			return;
		}

		// Validate model exists in registry
		const modelInfo = findRegistryModel(ctx, model);
		if (!modelInfo) {
			ctx.ui.notify(`Model not found in registry: ${model}`, "warning");
			return;
		}
	} else {
		// Interactive 3-step TUI
		// Step 1: Model picker
		const selectedModel = await showModelPicker(ctx);
		if (selectedModel === null) {
			return; // User cancelled
		}
		model = selectedModel;

		// Step 2: Thinking level picker
		const selectedThinking = await showThinkingLevelPicker(ctx);
		if (selectedThinking === null) {
			return; // User cancelled
		}
		thinking = selectedThinking;

		// Step 3: Optional label input
		const labelInput = await ctx.ui.input(
			"Profile label (optional)",
			"e.g. Opus Deep",
		);
		if (labelInput !== null && labelInput.trim() !== "") {
			label = labelInput.trim();
		}
	}

	if (!model || !thinking) {
		ctx.ui.notify("Missing required fields", "error");
		return;
	}

	// Load current profiles and add new one
	const profiles = await loadProfiles();
	const newProfile: ModelProfile = { model, thinking, label };
	profiles.push(newProfile);

	const saved = await saveProfiles(ctx, profiles);
	if (saved) {
		const displayLabel = label || `#${profiles.length}`;
		ctx.ui.notify(`Added profile: ${displayLabel}`, "info");
	}
}

async function handleRemove(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	args: string[],
): Promise<void> {
	let profiles: ModelProfile[];
	let removeIndex: number;

	if (args.length === 0) {
		const selection = await pickProfileIndex(ctx, pi, {
			title: "Remove profile",
			footer: "↑↓ navigate • enter remove • esc cancel",
			emptyMessage: "No profiles configured. Use /model-switch add",
		});
		if (!selection) {
			return;
		}

		profiles = selection.profiles;
		removeIndex = selection.selectedIndex;
	} else {
		const index = Number.parseInt(args[0], 10);
		if (Number.isNaN(index) || index < 1) {
			ctx.ui.notify("Invalid index. Use 1-based index.", "error");
			return;
		}

		profiles = await loadProfiles();
		if (index > profiles.length) {
			ctx.ui.notify(`No profile at index ${index}`, "error");
			return;
		}

		removeIndex = index - 1;
	}

	const removed = profiles.splice(removeIndex, 1)[0];
	const saved = await saveProfiles(ctx, profiles);

	if (saved) {
		if (activeProfileIndex !== null) {
			if (activeProfileIndex === removeIndex) {
				activeProfileIndex = null;
			} else if (activeProfileIndex > removeIndex) {
				activeProfileIndex--;
			}
		}

		const displayLabel = removed?.label || `#${removeIndex + 1}`;
		ctx.ui.notify(`Removed profile: ${displayLabel}`, "info");
	}
}

async function executeModelSwitchCommand(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	argsText: string,
): Promise<void> {
	const args = parseCommandArgs(argsText);
	const subcommand = args[0]?.toLowerCase();

	switch (subcommand) {
		case "add":
			await handleAdd(ctx, args.slice(1));
			break;
		case "remove":
			await handleRemove(ctx, pi, args.slice(1));
			break;
		case "list":
			await handleList(ctx);
			break;
		case undefined:
			await showProfilePicker(ctx, pi);
			break;
		default:
			ctx.ui.notify(
				`Unknown subcommand: ${subcommand}. Use: add, remove, list`,
				"error",
			);
	}
}

function isModelSwitchCommand(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) {
		return false;
	}

	const spaceIndex = trimmed.indexOf(" ");
	const commandName = spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex);
	return commandName === "model-switch";
}


async function handleList(ctx: ExtensionContext): Promise<void> {
	const profiles = await loadProfiles();

	if (profiles.length === 0) {
		ctx.ui.notify("No profiles configured. Use /model-switch add", "info");
		return;
	}

	const lines = profiles.map((profile, index) => {
		const label = profile.label || `#${index + 1}`;
		return `${index + 1}. ${label}: ${profile.model} [${profile.thinking}]`;
	});

	ctx.ui.notify(`Profiles:\n${lines.join("\n")}`, "info");
}

// ============================================================================
// Lifecycle
// ============================================================================

async function syncActiveProfile(ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
	const profiles = await loadProfiles();
	profilesCache = profiles;

	const currentModel = getModelKey(ctx.model);
	const currentThinking = getCurrentThinkingLevel(pi);
	activeProfileIndex = currentModel
		? findActiveProfileIndex(profiles, currentModel, currentThinking)
		: null;
}

// ============================================================================
// Extension Export
// ============================================================================

export default function modelSwitcherExtension(pi: ExtensionAPI) {
	// Register the main command with subcommands
	pi.registerCommand("model-switch", {
		description: "Switch between model profiles",
		getArgumentCompletions: getModelSwitchArgumentCompletions,
		handler: async (argsText, ctx) => {
			await executeModelSwitchCommand(ctx, pi, argsText);
		},
	});

	pi.on("input", async (event, ctx) => {
		if (event.source !== "interactive" || !isModelSwitchCommand(event.text)) {
			return {};
		}

		const spaceIndex = event.text.indexOf(" ");
		const argsText = spaceIndex === -1 ? "" : event.text.slice(spaceIndex + 1);
		await executeModelSwitchCommand(ctx, pi, argsText);
		return { handled: true };
	});

	pi.on("session_start", async (_event, ctx) => {
		await syncActiveProfile(ctx, pi);
	});

	pi.on("session_switch", async (_event, ctx) => {
		await syncActiveProfile(ctx, pi);
	});

	pi.on("extension_load", async (_event, ctx) => {
		profilesCache = await loadProfiles();
	});
}
