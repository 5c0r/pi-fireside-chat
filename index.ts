/**
 * pi-fireside-chat — persistent side conversation that follows the main
 * session. Works on both pi hosts:
 *   - oh-my-pi (omp): remaps @earendil-works/* imports to its bundled packages
 *     (PI_SCOPE_ALIASES in omp's legacy-pi-compat) — verified live.
 *   - earendil-works/pi: resolves @earendil-works/* natively.
 * Host differences are shimmed at runtime: getSystemPrompt() returns string[]
 * on omp and string on pi; model access is ctx.model ?? ctx.models.current();
 * API-key resolution is modelRegistry.resolver (omp) or getProviderAuth (pi).
 *
 * Surface: `/fireside [msg]` (alias `/sidechat`) opens a focused overlay pane:
 * full history, live streaming reply, in-pane input (Enter submits, Esc
 * closes). History persists as `fireside.turn` custom session entries (legacy
 * `com.sidechat.turn` entries are still read) and survives close/reopen.
 *
 * Per turn:
 *  1. context = main system prompt + main transcript rebuilt fresh:
 *     buildSessionContext(getEntries(), getLeafId()) → convertToLlm — full
 *     fidelity, branches/compactions handled by core — plus the in-flight
 *     assistant message (message_start/update events, /btw parity)
 *  2. fireside history appended as one valid user message (no fabricated
 *     assistant wire shapes)
 *  3. answered by an own model call with `tools: []` (read-only)
 */

import {
	buildSessionContext,
	convertToLlm,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { streamSimple } from "@earendil-works/pi-ai";
import { Box, Markdown, matchesKey } from "@earendil-works/pi-tui";
import type {
	OpaqueModel,
	PaneComponent,
	SidechatCommandContext,
	SidechatExtensionAPI,
	TuiLike,
	ThemeLike,
} from "./api";
import {
	FIRESIDE_ENTRY_TYPE,
	SYSTEM_PROMPT,
	applyPaneInput,
	buildSidechatMessages,
	extractHistory,
	mergeStreamingMessage,
	type SidechatTurn,
} from "./context";

/** Type guard: message event carrying an assistant-role AgentMessage. */
function isAssistantMessage(event: unknown): event is { message: { role: "assistant" } } {
	if (!event || typeof event !== "object") return false;
	const message = (event as Record<string, unknown>).message;
	return (
		!!message &&
		typeof message === "object" &&
		(message as Record<string, unknown>).role === "assistant"
	);
}

/** omp returns string[], pi returns string — normalize to string[]. */
function mainSystemPrompt(ctx: SidechatCommandContext): string[] {
	const prompt: string[] | string = ctx.getSystemPrompt();
	return Array.isArray(prompt) ? prompt : [prompt];
}

/** omp's modelRegistry exposes resolver(); pi's exposes getProviderAuth(). */
function isOmpHost(ctx: SidechatCommandContext): boolean {
	return typeof ctx.modelRegistry.resolver === "function";
}
/** omp exposes ctx.model and ctx.models.current(); pi exposes ctx.model. */
function activeModel(ctx: SidechatCommandContext): OpaqueModel | undefined {
	return ctx.model ?? ctx.models?.current();
}

/** omp: modelRegistry.resolver(model, sessionId). pi: getProviderAuth(provider). */
async function resolveApiKey(ctx: SidechatCommandContext, model: OpaqueModel): Promise<unknown> {
	const registry = ctx.modelRegistry as Record<string, unknown>;
	if (typeof registry.resolver === "function") {
		return registry.resolver(model, ctx.sessionManager.getSessionId?.());
	}
	if (typeof registry.getProviderAuth === "function" && typeof model.provider === "string") {
		const auth = (await registry.getProviderAuth(model.provider)) as
			| { auth?: { apiKey?: string } }
			| undefined; // host structural subset: AuthResult { auth: { apiKey } }
		return auth?.auth?.apiKey;
	}
	return undefined;
}

export default function firesideExtension(pi: SidechatExtensionAPI): void {
	let history: SidechatTurn[] = [];
	/** In-flight main-session assistant message (message_start/update events). */
	let inFlight: unknown;
	/** Shared pane state: mutated by ask() streaming and pane input alike. */
	const pane = {
		input: "",
		busy: false,
		streaming: undefined as string | undefined,
		/** Question of the in-flight turn — rendered as a bubble while streaming. */
		pending: undefined as string | undefined,
		scrollOffset: 0,
		followTail: true,
		requestRender: undefined as (() => void) | undefined,
		close: undefined as (() => void) | undefined,
	};

	const rebuild = (ctx: { sessionManager: { getBranch(): unknown[] } }): void => {
		history = extractHistory(ctx.sessionManager.getBranch());
	};

	// omp: session_start/session_switch/session_branch/session_tree.
	// pi: session_start/session_tree (others never fire; unknown names are inert).
	for (const event of ["session_start", "session_switch", "session_branch", "session_tree"]) {
		try {
			pi.on(event, (_event, ctx) => rebuild(ctx));
		} catch {
			// Host rejects unknown event names — ask() rebuilds per turn anyway.
		}
	}
	pi.on("message_start", event => {
		if (isAssistantMessage(event)) inFlight = event.message;
	});
	pi.on("message_update", event => {
		if (isAssistantMessage(event)) inFlight = event.message;
	});
	pi.on("message_end", _event => {
		inFlight = undefined;
	});

	/** One fireside turn: fresh main context + history → streamed reply. */
	async function ask(ctx: SidechatCommandContext, question: string): Promise<void> {
		const model = activeModel(ctx);
		if (!model) {
			ctx.ui.notify("fireside: no active model", "error");
			return;
		}
		pane.busy = true;
		pane.pending = question;
		pane.followTail = true;
		pane.requestRender?.();
		try {
			const sessionManager = ctx.sessionManager;
			const sessionMessages = mergeStreamingMessage(
				buildSessionContext(sessionManager.getEntries(), sessionManager.getLeafId()).messages,
				inFlight,
			);
			const llmMessages = convertToLlm(sessionMessages);
			rebuild(ctx);

			const messages = buildSidechatMessages(llmMessages, history, question);
			const systemPromptLines = [...mainSystemPrompt(ctx), SYSTEM_PROMPT];
			// pi-ai Context.systemPrompt is a single string; omp pi-ai takes string[].
			const systemPrompt = isOmpHost(ctx) ? systemPromptLines : systemPromptLines.join("\n\n");

			pane.streaming = "";
			let reply = "";
			try {
				const events = await streamSimple(model, { systemPrompt, messages, tools: [] }, {
					apiKey: await resolveApiKey(ctx, model),
					signal: AbortSignal.timeout(120_000),
				});
				for await (const event of events) {
					if (event.type === "text_delta" && typeof event.delta === "string") {
						reply += event.delta;
						pane.streaming = reply;
						pane.followTail = true;
						pane.requestRender?.();
					} else if (event.type === "error") {
						throw new Error(event.error?.errorMessage || "fireside stream failed");
					}
				}
			} catch (error) {
				pane.streaming = undefined;
				ctx.ui.notify(`fireside: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}

			const finalReply = reply.trim();
			pane.streaming = undefined;
			if (!finalReply) {
				ctx.ui.notify("fireside: empty reply", "error");
				return;
			}
			history.push({ question, reply: finalReply });
			pi.appendEntry(FIRESIDE_ENTRY_TYPE, { question, reply: finalReply });
		} finally {
			pane.busy = false;
			pane.pending = undefined;
			pane.requestRender?.();
		}
	}
	/** The focused pane component (overlay page): chat-style history + input. */
	function paneComponent(
		tui: TuiLike,
		theme: ThemeLike,
		done: (result: undefined) => void,
	): PaneComponent {
		pane.requestRender = () => tui.requestRender();
		pane.close = () => done(undefined);
		const mdTheme = getMarkdownTheme();
		/** Renderers per committed turn — user bubble mirrors core UserMessageComponent
		 * (Box + theme.bg wrapper, Markdown with theme.fg; works on both hosts). */
		interface TurnRender {
			turn: SidechatTurn;
			user: Box;
			reply: Markdown;
		}
		const turnRenders: TurnRender[] = [];
		/** Streaming reply renderer — setText is append-optimized for deltas. */
		let streamMd: Markdown | undefined;
		/** Pending-question bubble renderer, rebuilt if the question changes. */
		let pendingMd: { question: string; md: Box } | undefined;

		function userBubble(question: string): Box {
			const box = new Box(1, 1, (content: string) => theme.bg("userMessageBg", content));
			box.addChild(
				new Markdown(question, 0, 0, mdTheme, {
					color: (content: string) => theme.fg("userMessageText", content),
				}),
			);
			return box;
		}

		/** Rebuild cached renderers from the first history divergence (turn ref). */
		function syncTurnRenders(): TurnRender[] {
			let i = 0;
			while (i < turnRenders.length && i < history.length && turnRenders[i].turn === history[i]) i++;
			if (i < turnRenders.length) turnRenders.length = i;
			while (i < history.length) {
				const turn = history[i];
				turnRenders.push({
					turn,
					user: userBubble(turn.question),
					reply: new Markdown(turn.reply, 0, 0, mdTheme),
				});
				i++;
			}
			return turnRenders;
		}

		function chatBody(width: number): string[] {
			const lines: string[] = [];
			for (const { user, reply } of syncTurnRenders()) {
				lines.push(...user.render(width), "", ...reply.render(width), "");
			}
			if (pane.pending !== undefined) {
				if (pendingMd?.question !== pane.pending) {
					pendingMd = { question: pane.pending, md: userBubble(pane.pending) };
				}
				lines.push(...pendingMd.md.render(width), "");
			}
			if (pane.streaming !== undefined) {
				streamMd ??= new Markdown("", 0, 0, mdTheme);
				streamMd.setText(pane.streaming);
				lines.push(...streamMd.render(width));
			} else {
				streamMd = undefined;
			}
			return lines;
		}

		/** Plain-string scrollbar (omp ScrollView is not exported by pi-tui —
		 * both hosts get the same 2-col track/thumb drawn by hand). */
		function scrollbarColumn(totalRows: number, height: number): string[] {
			if (totalRows <= height) return Array.from({ length: height }, () => " ");
			const thumbSize = Math.max(1, Math.round((height * height) / totalRows));
			const maxOffset = totalRows - height;
			const thumbPos = Math.round((pane.scrollOffset / maxOffset) * (height - thumbSize));
			return Array.from({ length: height }, (_, i) =>
	i >= thumbPos && i < thumbPos + thumbSize ? "▐" : "│",
			);
		}

		return {
			render(width: number): readonly string[] {
				const terminalRows = process.stdout.rows ?? 40;
			const header =
				theme.fg("accent", "󰈸 fireside") +
				theme.fg("dim", " ⋮ the conversation beside your session ⋮ Esc closes ⋮");
				const body = chatBody(width - 2);
				const inputLine =
					theme.fg("accent", "❯ ") +
					pane.input +
					(pane.busy ? theme.fg("dim", "▏ waiting for reply…") : "▏");
				const viewportRows = Math.max(4, terminalRows - 4);
				const maxScroll = Math.max(0, body.length - viewportRows);
				if (pane.scrollOffset > maxScroll) pane.scrollOffset = maxScroll;
				if (pane.followTail) pane.scrollOffset = maxScroll;
				const visible = body.slice(pane.scrollOffset, pane.scrollOffset + viewportRows);
				const bar = scrollbarColumn(body.length, viewportRows);
				while (visible.length < viewportRows) visible.push("");
				const viewLines = visible.map(
					(line, i) => line + theme.fg("dim", " ") + theme.fg(bar[i] === "▐" ? "accent" : "dim", bar[i] ?? "│"),
				);
				return [header, ...viewLines, "", inputLine];
			},
			handleInput(data: string): void {
				const effect = applyPaneInput(pane, data, matchesKey);
				if (effect.kind === "close") {
					done(undefined);
					return;
				}
				if (effect.kind === "submit") {
					void currentAsk?.(effect.question).finally(() => tui.requestRender());
					return;
				}
				if (effect.kind === "render") {
					tui.requestRender();
					return;
				}
				// kind "none": control sequences only — scroll keys.
				const viewportRows = Math.max(4, (process.stdout.rows ?? 40) - 4);
				const bodyRows = chatBody(process.stdout.columns ?? 120).length;
				const maxScroll = Math.max(0, bodyRows - viewportRows);
				if (matchesKey(data, "up")) {
					pane.scrollOffset = Math.max(0, pane.scrollOffset - 1);
					pane.followTail = false;
				} else if (matchesKey(data, "down")) {
					pane.scrollOffset = Math.min(maxScroll, pane.scrollOffset + 1);
					pane.followTail = pane.scrollOffset >= maxScroll;
				} else if (matchesKey(data, "pageUp")) {
					pane.scrollOffset = Math.max(0, pane.scrollOffset - viewportRows);
					pane.followTail = false;
				} else if (matchesKey(data, "pageDown")) {
					pane.scrollOffset = Math.min(maxScroll, pane.scrollOffset + viewportRows);
					pane.followTail = pane.scrollOffset >= maxScroll;
				}
				tui.requestRender();
			},
			invalidate(): void {},
			dispose(): void {
				pane.requestRender = undefined;
				pane.close = undefined;
				pane.input = "";
				pane.streaming = undefined;
				pane.scrollOffset = 0;
				pane.followTail = true;
				// pane.busy intentionally NOT cleared here: Esc may close the overlay
				// while ask() still streams — only ask()'s finally may release it,
				// otherwise a quick reopen/seed could race a concurrent turn.
				// Same reasoning keeps pane.pending owned by ask()'s finally.
			},
		};
	}

	/** The command handler's ctx for in-pane submits (latest invocation). */
	let currentAsk: ((question: string) => Promise<void>) | undefined;

	const commandHandler = async (args: string, ctx: SidechatCommandContext): Promise<void> => {
		const seed = args.trim();

		if (!ctx.hasUI || typeof ctx.ui.custom !== "function") {
			// Headless: no focused surface — answer directly, notify result.
			if (seed.length > 0) {
				currentAsk = (question: string) => ask(ctx, question);
				await ask(ctx, seed);
				const last = history[history.length - 1];
				if (last && last.question === seed) ctx.ui.notify(`fireside: ${last.reply}`, "info");
			} else {
				ctx.ui.notify("Usage (headless): /fireside <msg>", "info");
			}
			return;
		}
		currentAsk = (question: string) => ask(ctx, question);
		rebuild(ctx);
		if (seed === "close") {
			pane.close?.();
			return;
		}
		if (seed.length > 0) {
			if (pane.busy) {
				ctx.ui.notify("fireside: previous turn still streaming — reopen the pane instead", "info");
			} else {
				void ask(ctx, seed);
			}
		} else if (history.length === 0) {
			ctx.ui.notify("Usage: /fireside [msg] — opens the side conversation pane", "info");
		}
		// Hold the focused pane until the user closes it (Esc / /fireside close).
		await ctx.ui.custom<undefined>(
			(tui, theme, _keybindings, done) => paneComponent(tui, theme, done),
			{ overlay: true },
		);
	};

	pi.registerCommand("fireside", {
		description: "Side conversation pane following the main session (/fireside [seed msg])",
		handler: commandHandler,
	});
	// Back-compat alias for the sidechat-era command name.
	pi.registerCommand("sidechat", {
		description: "Alias for /fireside",
		handler: commandHandler,
	});
}
