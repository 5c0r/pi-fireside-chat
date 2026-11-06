# pi-fireside-chat

A persistent, contextual, tool-free side chat plus ten terminal companions for pi coding agents. Ask a question without adding it to the main conversation, then return to your work. Your pet walks above the editor, catches crumbs of streaming assistant text, and naps after a meal.

Works with [earendil-works/pi](https://github.com/earendil-works/pi) (`pi`) and [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`). Pets make no model or network calls. The side chat uses your configured model provider.

## Install and start

### pi

Install from the public repository:

```bash
pi install https://github.com/5c0r/pi-fireside-chat
```

Or install a checkout:

```bash
git clone https://github.com/5c0r/pi-fireside-chat.git
pi install ./pi-fireside-chat
```

### oh-my-pi

Clone and link the extension:

```bash
git clone https://github.com/5c0r/pi-fireside-chat.git
mkdir -p ~/.omp/agent/extensions
ln -s "$(pwd -P)/pi-fireside-chat" ~/.omp/agent/extensions/pi-fireside-chat
```

If that registration already exists, inspect it first. Do not overwrite a real directory or unrelated extension. For an active profile or custom agent directory, use its `extensions` directory instead.

Restart `pi` or `omp`, then run `/fireside`, `/fireside-config`, or `/fireside-pet`. Opening these views does not send a model request. `/fireside <message>` or Enter inside the pane does.

To try a checkout without registering it, run either command from its parent directory:

```bash
pi --no-extensions -e ./pi-fireside-chat/index.ts
omp --no-extensions -e ./pi-fireside-chat/index.ts
```

Both hosts load `index.ts` directly. No build step or separate runtime dependency install is needed.

To uninstall from Pi, inspect `pi list` and run `pi remove <source>` with the registered Git URL or checkout path. For OMP, remove only the Fireside registration symlink. Keep unrelated registrations and the checkout.

## Side chat

| Command | Purpose |
|---|---|
| `/fireside [message]` | Open the pane and restore its history; optionally send a question immediately. |
| `/sidechat [message]` | Alias for `/fireside`. |
| `/fireside-config` | Choose a model for Fireside without changing the main model. |
| `/fireside-pet` | Customize your companion in a live preview. |

The full-terminal overlay has themed question bubbles, Markdown answers, and streaming replies. Your question appears immediately, including while the model is still responding.

- **Enter** sends a wrapped follow-up draft. Enter during an active reply preserves the draft instead of sending another request.
- **Escape** closes the pane; reopening restores its conversation.
- **↑/↓**, **PgUp/PgDn**, and **Home** scroll through history. Scrolling back stays anchored during streaming; **End** restores follow-tail.
- History and model selection belong to the active session branch. Switching sessions, branching, or rewinding restores the reachable state and cancels obsolete requests.

### Context and model choice

Each turn rebuilds context from the main system prompt, the host's branch-aware transcript (including compactions), any in-flight assistant message, and earlier Fireside turns. The model receives `tools: []`: it can discuss your work but cannot invoke tools or edit files.

`/fireside-config` offers **Follow session** on both hosts. OMP also offers configured, available **Default**, **Smol**, and **Slow** roles; Pi lists available `provider/model` choices. Escape leaves the selection unchanged. Unavailable selections report an error without sending a request.

Model choices persist with the session branch. OMP roles resolve at request time; their `:thinking` metadata is not inherited. Fireside history uses `fireside.turn` custom session entries, separate from ordinary main-chat messages, and still reads legacy `com.sidechat.turn` entries.

## Ten terminal companions

Pets occupy a small strip above the main editor, the Fireside editor, or both. They do not replace the editor or take keyboard focus.

| Name | Species |
|---|---|
| Miso | Cat |
| Toast | Corgi |
| Mochi | Slime |
| Ember | Dragon |
| Pip | Bunny |
| Soba | Fox |
| Pebble | Capybara |
| Waddles | Penguin |
| Sprout | Turtle |
| Nori | Axolotl |

Each has walking, idle/blinking, and sleeping poses. These are actual compact walking frames from [`pet-data.ts`](./pet-data.ts):

```text
Miso      =^.^=/>
Toast     U(o w)/u~
Mochi     (o_o)~
Ember     ~(o)>/\
Pip       (\(^.^)/>
Soba      ^<o.o>/~~
Pebble    n( ._.)_/>
Waddles   \(o>)_/
Sprout    ~/(==)\o
Nori      }(o.o){/~
```

Full-size sprites use three rows. Miso's first full walking frame:

```text
 /\_/\
( o.o )~
 /| |\
```

### Customize and save

Open `/fireside-pet`. Use **↑/↓** to choose a control, **←/→** to change a choice, and **Enter** to activate an action or edit a name/path.

| Setting | Choices |
|---|---|
| Pet | Any built-in companion or a local custom sprite |
| Name | Safe text, up to 24 characters |
| Color | Theme, amber, mint, rose, sky, lavender |
| Size | Compact (one row), full (three rows) |
| Speed | Slow, normal, fast |
| Personality | Calm, playful, sleepy |
| Placement | Main editor, Fireside editor, both |
| Motion | Animated, static, hidden |
| Food rain | On, off |
| Custom sprite file | Local JSON path; an absolute path is recommended |

**Random pet** selects a different built-in, never a custom file. **Random color** selects a different curated color; theme color remains a manual choice. **Surprise me** changes both while preserving other settings. Enter rerolls without closing the menu. The **`r`** shortcut triggers Surprise me outside name/path edits; inside an edit, it is ordinary text. These actions select local catalog entries and colors, not AI-generated sprites.

Default names follow the selected species. Accepting a Name edit makes it custom, even if the text is unchanged. A custom name survives pet changes, random rolls, Save, and restart.

All changes are previews until **Save preferences** succeeds. Save persists the exact selection; startup never rerolls it. **Escape** outside an edit discards the preview and restores the original settings, loaded sprite, position, animation frame, and food state. While editing a name/path, Enter accepts that field and Escape cancels that edit; neither saves preferences.

The default is Miso with calm personality, theme color, full size, slow speed, main placement, animated motion, and food rain on. Pets turn at edges, pause on observed input activity, sleep after inactivity, and wake on replies. Static mode has no animation timer; hidden mode removes the sprite. Both placements share one animation.

Small terminals use compact art and safe clipping. Unicode names remain in preferences, but only printable ASCII names appear beside the sprite. Input observation does not inspect editor text, consume keys, or save typed input; modal input can also trigger it, while some host-captured gestures bypass observation.

### Streaming crumbs

Only **visible assistant text deltas** from the main conversation and Fireside replies become food. Thinking, tool output, whole-message snapshots, terminal controls, and unsafe glyphs do not. There is no food generation while idle.

- Crumbs are **1–3 ASCII columns** wide. Both streams share a limit of **10 pieces**, including the piece being munched, and **two spawns per second**. Skipped deltas are discarded, not queued.
- Food falls and lands within the pet strip. The pet chooses the nearest reachable grounded piece, runs toward it, then munches with a crumb effect and a brief `nom`. Chasing does not change your saved speed.
- After **five pieces**, the pet pauses satisfied, then takes a protected **six-second digestion nap**. Replies cannot interrupt that nap, and new food does not spawn while satisfied or digesting.
- Grounded food stays until eaten rather than expiring during rest. Falling pieces finish landing, and the pet resumes chasing leftovers after waking without needing another text delta.
- Observed input pauses movement and rejects new food for **1.5 seconds**. Existing food keeps falling. Static/hidden motion, food rain off, and noninteractive modes stop sampling.
- Compact and full views share one food world without changing each other's fall timing. Losing all drawable pet space clears transient food and stops sampling until space returns; resizing can remove pieces beyond the remaining width. A zero-space view does not erase food in another drawable view.

Toggle **Food rain** in `/fireside-pet`. Preview cancellation restores cosmetic food state without rewinding the independent main/Fireside control-sequence parsers. Food sampling never changes the actual chat text.

### Custom sprites

Create a local JSON file, select **Pet: custom**, set **Custom sprite file**, and Save. Custom sprites are inert data with no scripts, imports, or network requests.

```json
{
  "version": 1,
  "label": "Robot",
  "compact": {
    "walking": [["[o_o]>"], ["[o-o]>"]],
    "idle": [["[o_o]"], ["[-_-]"]],
    "sleep": [["[-_-] z"]]
  },
  "full": {
    "walking": [
      [" /\\ ", "[o_o]", " / \\"],
      [" /\\ ", "[o-o]", " \\ /"]
    ],
    "idle": [
      [" /\\ ", "[o_o]", " / \\"],
      [" /\\ ", "[-_-]", " / \\"]
    ],
    "sleep": [["    ", "[-_-]", " z z"]]
  }
}
```

The schema requires `version: 1`, a safe nonempty label of at most 32 characters, and both `compact` and `full` sets. Each set needs `walking`, `idle`, and `sleep`, with 1–8 frames per pose. Compact frames have exactly one row; full frames have exactly three. Rows must be printable ASCII, at most 32 columns, with visible content in every frame. The loader rejects terminal controls, wide glyphs, malformed UTF-8, and files over 64 KiB. It pads rows per pose and mirrors walking frames for leftward movement.

## Privacy and performance

Pets are local animation: no model calls, network traffic, telemetry, sound, or microphone. They use public interactive TUI APIs and do not mount in RPC/print modes. One shared animation timer serves drawable placements, and bounded food sampling retains only short crumb glyphs and parser modes, not whole replies or control payloads.

The side chat **does send context and questions to your selected model provider**. Its empty tool list prevents tool execution; completed turns and model choices are saved as custom session entries. Pet preferences are stored separately in `fireside-pet.json` under the active host's agent directory, normally `~/.pi/agent` or `~/.omp/agent`. Active profiles and `PI_CODING_AGENT_DIR` are honored.

Only Save writes pet preferences. Invalid settings produce a warning and safe defaults. Invalid custom sprites produce a warning and a built-in fallback; the menu refuses to save an invalid custom selection. Pet errors escape terminal controls and display-spoofing characters before display.

## Development and runtime compatibility

```bash
cd pi-fireside-chat
bun run test
bun run typecheck
git diff --check
```

There is no build script. The package manifest registers `./index.ts` as a Pi extension; both hosts load TypeScript directly. Imports use host-provided `@earendil-works/pi-coding-agent`, `pi-ai`, and `pi-tui` packages. OMP resolves those imports through its scope aliases.

Runtime adapters handle prompt shape, active models, credential resolution, and lifecycle events. Scrolling uses the pane's own renderer rather than relying on a host-specific `ScrollView` API. Behavioral tests cover context, models, lifecycle, scrolling, pets, food, persistence, preview rollback, and teardown; runtime changes also need interactive smoke checks on both hosts.
