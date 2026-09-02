# pi-fireside-chat

A persistent side-conversation pane for pi coding agents. Opens a focused chat overlay (`/fireside`, alias `/sidechat`) beside your main session: ask throwaway questions, brainstorm, or sanity-check ideas without polluting the main transcript.

Works on **both pi hosts** from one codebase:

- [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`)
- [earendil-works/pi](https://github.com/earendil-works/pi) (`pi`)

## What it does

- `/fireside <msg>` — opens the pane and immediately asks `<msg>` (pane opens empty with no argument; reopens your full history)
- In-pane input line: type follow-ups, **Enter** sends, **Esc** closes; ↑/↓/PgUp/PgDn scroll
- Chat-style rendering identical to the main panel: user bubbles with your theme's `userMessageBg`, assistant replies rendered as full markdown (bold, code spans, lists)
- The question bubble renders the instant you submit — visible during model latency and streaming, with the reply streaming in below it
- History persists per session as `fireside.turn` custom entries and survives pane close/reopen (legacy `com.sidechat.turn` entries from the sidechat era are still read)

## How it stays context-aware

Each fireside turn rebuilds context **fresh** from the main session:

1. Main system prompt (`ctx.getSystemPrompt()`)
2. Main transcript via `buildSessionContext(getEntries(), getLeafId())` → `convertToLlm` — branches, compactions, and summaries handled by host core, full fidelity
3. The in-flight assistant message, if the main agent is mid-stream (parity with `/btw`)
4. Prior fireside turns, encoded as one valid user message

The reply is an independent model call with `tools: []` — strictly read-only, no side effects on your session.

## Installation

### oh-my-pi (`omp`)

```bash
mkdir -p ~/.omp/agent/extensions
git clone https://github.com/5c0r/pi-fireside-chat ~/.omp/agent/extensions/pi-fireside-chat
```

Restart `omp` (or `/reload`), then run `/fireside hello` in any project.

Quick test without installing:

```bash
omp -e /path/to/pi-fireside-chat/index.ts
```

### earendil-works/pi (`pi`)

```bash
mkdir -p ~/.pi/agent/extensions
git clone https://github.com/5c0r/pi-fireside-chat ~/.pi/agent/extensions/pi-fireside-chat
```

Restart `pi` (or `/reload`), then `/fireside hello`.

Quick test:

```bash
pi -e /path/to/pi-fireside-chat/index.ts
```

### Uninstall

Remove the cloned directory (`rm -rf ~/.omp/agent/extensions/pi-fireside-chat` or `~/.pi/agent/extensions/pi-fireside-chat`).

## How dual-host compatibility works

Verified live against omp v18.1.3, pi 0.83.0, and pi 0.84.4 (including scroll, Esc, and reopen under the 0.84 layout TUI).

The extension imports only the `@earendil-works/*` scope:

- **earendil-works/pi** resolves `@earendil-works/pi-tui`, `pi-ai`, and `pi-coding-agent` natively.
- **oh-my-pi** remaps `@earendil-works/*` specifiers to its own bundled copies (its `PI_SCOPE_ALIASES` compatibility layer), so the same import runs against omp's runtime.

Host API differences are shimmed at runtime:

| Difference | oh-my-pi | earendil-works/pi | Shim |
|---|---|---|---|
| `ctx.getSystemPrompt()` | `string[]` | `string` | `Array.isArray` normalize |
| Active model | `ctx.model` / `ctx.models.current()` | `ctx.model` | `ctx.model ?? ctx.models?.current()` |
| API-key resolution | `modelRegistry.resolver(model, sessionId)` | `modelRegistry.getProviderAuth(provider)` | feature-detect both |
| User-message bubble | `Markdown(1,1)` + `bgColor`/`fgOnBg` | `Box` + `theme.bg` + `theme.fg` | `Box` pattern (works on both) |
| Scrollback component | `ScrollView(rows, {height, …})` | not exported in 0.83; redesigned single-child ctor in 0.84 | hand-drawn scrollbar column — no version dependency |
| `streamSimple` context | `systemPrompt: string[]` | `systemPrompt: string` | join on pi (detected via `modelRegistry.resolver`) |
| Session events | `session_switch` / `session_branch` | (don't exist) | register defensively; history also rebuilds per turn |

## Development

```bash
cd pi-fireside-chat
bun install   # none needed — no runtime deps; hosts provide all imports
bun test      # 12 tests
bunx tsc --noEmit
```

No build step: both hosts load TypeScript extensions directly (Bun/jiti).

## Files

- `index.ts` — entry: command registration, host shims, model-call pipeline, chat pane component
- `context.ts` — pure logic: history extraction, message assembly, input reducer (unit-tested)
- `context.test.ts` — `bun test` suite
- `api.ts` / `host.d.ts` — compile-time shadows of the host API surface (dir carries no node_modules)
