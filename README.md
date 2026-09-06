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

### earendil-works/pi (`pi`)

After the first npm release:

```bash
pi install npm:pi-fireside-chat
```

Before publication, install a local checkout instead:

```bash
pi install /absolute/path/to/pi-fireside-chat
```

Restart `pi` (or `/reload`), then run `/fireside hello`.

Quick test without installing:

```bash
pi --no-extensions -e /absolute/path/to/pi-fireside-chat
```

### oh-my-pi (`omp`)

```bash
mkdir -p ~/.omp/agent/extensions
git clone https://github.com/5c0r/pi-fireside-chat ~/.omp/agent/extensions/pi-fireside-chat
```

Restart `omp` (or `/reload`), then run `/fireside hello` in any project.

Quick test without installing:

```bash
omp --no-extensions -e /absolute/path/to/pi-fireside-chat
```

### Uninstall

Run `pi remove npm:pi-fireside-chat` for the npm package, or `pi remove /absolute/path/to/pi-fireside-chat` for a local checkout. For OMP, remove `~/.omp/agent/extensions/pi-fireside-chat`.

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
bun install --frozen-lockfile --omit peer
bun run check
```

`--omit peer` keeps host-provided Pi APIs out of the standalone development install; `host.d.ts` supplies their compile-time surface.

No build step: both hosts load TypeScript extensions directly (Bun/jiti).

## Publishing

Do not publish until the repository owner chooses a license, adds its license file, and records it in `package.json`.

The first public package must be created with an authenticated manual `npm publish --access public`; do not commit or add an npm token to GitHub. After that first publish:

1. Open the package settings on npmjs.com and add a **GitHub Actions** trusted publisher.
2. Set owner to `5c0r`, repository to `pi-fireside-chat`, and workflow filename to `publish.yml`; allow direct `npm publish`.
3. For later versions, update `package.json`, then publish a GitHub Release whose tag is that version with an optional `v` prefix.

`.github/workflows/publish.yml` validates the tag, package, tests, and types before publishing through OIDC. Trusted publishing needs no repository secret and automatically generates provenance.

## Files

- `index.ts` — entry: command registration, host shims, model-call pipeline, chat pane component
- `context.ts` — pure logic: history extraction, message assembly, input reducer (unit-tested)
- `context.test.ts` — pure context/input tests
- `index.test.ts` — host/lifecycle/viewport regression suite
- `api.ts` / `host.d.ts` — compile-time shadows of the host API surface (dir carries no node_modules)
