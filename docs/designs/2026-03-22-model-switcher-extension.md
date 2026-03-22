# Model Switcher Extension

**Date:** 2026-03-22

## Context

Pi coding agent already supports model switching via the `pi-powerline-footer` extension, which bundles model profile management inside a large powerline status bar package. The user wants a dedicated, standalone extension focused exclusively on quickly switching between a curated set of pre-configured model profiles, without requiring powerline-footer or any other extension.

The reference for UI style and trigger pattern is the model picker overlay found in `pi-powerline-footer`: a bordered `╭─╮` select list overlay with keyboard navigation, triggered on demand.

## Discussion

**Standalone vs. alongside powerline-footer**
Three options were considered: fully standalone (chosen), complementary (reuses powerline-footer profiles), and fallback alternative. The user chose fully standalone — no dependency on powerline-footer, install and use independently.

**Profile shape**
Options ranged from model-only to model + thinking level to model + custom label. The user chose model + thinking level (same as powerline-footer's `ProfileConfig`), with an optional display label.

**Trigger mechanism**
Options were keyboard shortcut, slash command, or both. The user chose slash command only: `/model-switch`.

**Management approach (3 approaches explored)**
- Approach A — Minimal: text-only commands (`/model-switch add <model> <thinking> [label]`). Simple but requires memorizing exact model IDs.
- Approach B — Full interactive TUI: multi-step picker (model registry → thinking level → label) plus text form for scripting. Matches the referenced UX exactly.
- Approach C — Separate config file: same as B but stores profiles in a dedicated JSON file instead of `settings.json`.

**Chosen: Approach B.** Full interactive TUI using the same bordered overlay and SelectList pattern as powerline-footer. Interactive add/remove flows are supported, and text-form add/remove remain available for scripting. Config stored in `~/.omp/agent/config.yml` under a dedicated key to avoid conflicts with other extensions.

**Open technical question identified**: Whether `SelectList`, `Input`, `fuzzyFilter`, `truncateToWidth`, `visibleWidth` are re-exported from `@oh-my-pi/pi-coding-agent` or require a separate `@oh-my-pi/pi-tui` dependency. Resolved during implementation by inspecting installed package exports — `@oh-my-pi/pi-tui` is available as a transitive dependency and exports all needed components.

## Approach

A single-file extension (`index.ts`) in a new directory `model-switcher/`. It registers one slash command (`/model-switch`) with subcommands for add, remove, and list. The main command opens an interactive bordered SelectList overlay for quick profile switching. `/model-switch add` opens an interactive add wizard, and `/model-switch remove` opens an interactive profile picker for deletion when no index is provided. Profiles are stored in `~/.omp/agent/config.yml` under the key `modelSwitcherProfiles` (namespaced separately from powerline-footer's `modelProfiles`). No keyboard shortcut is registered.

## Architecture

### File Structure
```
~/.omp/agent/extensions/
  model-switcher/
    index.ts        ← all logic, single file
    package.json    ← pi extension declaration
```

### Data Model
```ts
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

interface ModelProfile {
  model: string;      // "provider/modelId" e.g. "anthropic/claude-opus-4-5"
  thinking: ThinkingLevel;
  label?: string;     // optional display name
}
```

Stored in `~/.omp/agent/config.yml` under `modelSwitcherProfiles: ModelProfile[]`. Writes are merge-writes (read → patch key → write back) to avoid clobbering other settings.

### Command Surface

| Command | Behavior |
|---|---|
| `/model-switch` | Opens profile picker overlay. Notifies if no profiles configured. |
| `/model-switch add` | Interactive 3-step TUI: model registry → thinking level → optional label |
| `/model-switch add <model> <thinking> [label]` | Text form for scripting |
| `/model-switch remove` | Interactive profile picker for deletion |
| `/model-switch remove <n>` | Remove profile at 1-indexed slot n |
| `/model-switch list` | Notify with numbered profile list |

### Overlay UI

Bordered `╭─╮` box using `ctx.ui.custom()` with `SelectList` from `@oh-my-pi/pi-tui`:

```
╭──────────────────────────────────╮
│ Model profiles                   │
├──────────────────────────────────┤
│ ▶ #1  Claude Opus Deep ✓         │ ← active profile marked
│   #2  Claude Sonnet Fast         │
│   #3  GPT-4o                     │
├──────────────────────────────────┤
│ ↑↓ navigate • enter switch • esc │
╰──────────────────────────────────╯
```

Description line per item: `anthropic/claude-opus-4-5  [high]`

### Add Flow (3 steps)

1. Model registry picker — bordered overlay with `Input` search + `SelectList`. Pulls from `ctx.modelRegistry.getAvailable()`, fuzzy-filtered as user types.
2. Thinking level picker — 6-item `SelectList`: `off | minimal | low | medium | high | xhigh`.
3. `ctx.ui.input("Profile label (optional)", "e.g. Opus Deep")` — empty input skips label.

### Switch Logic

```
/model-switch
  → reloadProfiles()              ← read settings.json
  → getLiveActiveIndex()          ← match ctx.model + pi.getThinkingLevel() to a profile
  → showProfilePicker()           ← ctx.ui.custom() + SelectList
  → user selects profile N
  → ctx.modelRegistry.find()      ← verify model exists in registry
  → pi.setModel(model)            ← returns false if no API key
  → pi.setThinkingLevel(thinking)
  → ctx.ui.notify(...)
  → setActiveIndex(N)             ← in-memory only
```

### State & Lifecycle

```ts
let activeProfileIndex: number | null = null;  // in-memory, reset on session switch
let switchInProgress = false;                   // mutex prevents re-entrant switches
```

`pi.on("session_start")` and `pi.on("session_switch")`: re-read profiles from disk, scan for a profile matching the current `ctx.model` + `pi.getThinkingLevel()`. Read-only — no side effects.

### Error Handling

| Condition | Response |
|---|---|
| No profiles | `notify("No profiles. Use /model-switch add", "info")` |
| Model not in registry | `notify("Model not found: ...", "warning")`, abort |
| No API key | `notify("No API key for: ...", "warning")`, abort |
| Invalid `provider/model` format | `notify("Invalid format. Use: provider/modelId", "error")` |
| Invalid thinking level | `notify("Invalid thinking level. Use: off|minimal|…", "error")` |
| `settings.json` non-object | Debug log, treat as empty, do not overwrite |
| Concurrent switch in progress | Silent guard via `switchInProgress`, no-op |

### Dependencies

```json
{
  "devDependencies": {
    "@oh-my-pi/pi-coding-agent": "^13.10.1"
  },
  "dependencies": {
    "@oh-my-pi/pi-tui": "^13.10.1"
  }
}
```

`@oh-my-pi/pi-tui` provides: `SelectList`, `Input`, `fuzzyFilter`, `truncateToWidth`, `visibleWidth`. It is already installed as a transitive dependency of `pi-coding-agent` at the same version.

### Verification Steps

1. **Empty state**: `/model-switch` → "No profiles" notification shown.
2. **Interactive add**: `/model-switch add` → 3-step TUI completes → `settings.json` contains new `modelSwitcherProfiles` entry.
3. **Text add**: `/model-switch add anthropic/claude-opus-4-5 high "Opus"` → same result.
4. **Switch**: `/model-switch` → pick profile → model + thinking level change visible in Pi UI, notification shown.
5. **Active marker**: After switch, re-open picker → `✓` on correct row.
6. **Interactive remove**: `/model-switch remove` → picker opens → selected profile is deleted.
7. **Text remove**: `/model-switch remove 1` → profile gone.
8. **Corrupt settings**: `modelSwitcherProfiles: null` in config → no crash, empty list.
9. **Session restore**: New session → active index re-syncs if current model matches a profile.
