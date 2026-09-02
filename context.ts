/**
 * sidechat — pure context assembly. No imports: testable standalone under `bun test`.
 *
 * Two-context model (per goal): every sidechat turn rebuilds the main session
 * transcript fresh (full fidelity — messages pass through untouched) and
 * appends the sidechat's own history + new question as proper LLM messages.
 */

export const FIRESIDE_ENTRY_TYPE = "fireside.turn";
/** Historical type written by the sidechat-era builds; still read for history continuity. */
const LEGACY_ENTRY_TYPES = ["com.sidechat.turn"];
export interface SidechatTurn {
	question: string;
	reply: string;
}

export const SYSTEM_PROMPT = [
	"You are fireside, a read-only side conversation running alongside the user's main coding session.",
	"You receive the main session transcript, your own prior fireside exchanges, and a new question.",
	"You have no tools and cannot modify anything. Answer concisely using both contexts;",
	"when they disagree, the freshest main-session state wins.",
].join(" ");

/** Read-only by construction: sidechat registers no tools. Asserted in tests. */
export const DECLARED_TOOLS: string[] = [];

/**
 * Rebuild sidechat history from the active session branch.
 * Docs pattern (extensions.md § Session and state patterns): entries with
 * `type === "custom"` and our namespaced `customType`, order preserved.
 */
export function extractHistory(branchEntries: unknown[]): SidechatTurn[] {
	const out: SidechatTurn[] = [];
	for (const entry of branchEntries) {
		const e = entry as Record<string, unknown>;
		if (e.type !== "custom") continue;
		if (e.customType !== FIRESIDE_ENTRY_TYPE && !LEGACY_ENTRY_TYPES.includes(e.customType as string)) continue;
		const data = e.data as Record<string, unknown> | undefined;
		if (
			data &&
			typeof data.question === "string" &&
			typeof data.reply === "string" &&
			data.question.length > 0
		) {
			out.push({ question: data.question, reply: data.reply });
		}
	}
	return out;
}

/**
 * Render prior sidechat turns + the new question as the text of ONE user
 * message. Fabricated assistant messages would need the full pi-ai
 * AssistantMessage wire shape (content blocks, api/provider/model/usage/
 * stopReason/timestamp) — providers may reject partial objects, so the
 * history rides inside a valid user message instead.
 */
export function renderSidechatPrompt(history: SidechatTurn[], question: string): string {
	const historyText = history
		.map(turn => `[user] ${turn.question}\n[fireside assistant] ${turn.reply}`)
		.join("\n");
	return (
		`<fireside-history>\n${historyText.length > 0 ? historyText : "(none yet)"}\n</fireside-history>\n` +
		`<question>\n${question}\n</question>`
	);
}
/**
 * /btw parity: a sidechat turn fired mid-stream must see the main session
 * "as it stands at that moment", including the in-flight assistant message
 * (BtwController → #buildEphemeralSnapshot does the same via agent stream
 * state). The extension tracks it from message_start/update events and merges
 * it here, appended after the persisted path (it is chronologically newest).
 */
export function mergeStreamingMessage(sessionMessages: readonly unknown[], streaming: unknown): unknown[] {
	if (!streaming || typeof streaming !== "object") return [...sessionMessages];
	const role = (streaming as Record<string, unknown>).role;
	if (role !== "assistant") return [...sessionMessages];
	return [...sessionMessages, streaming];
}
/**
 * Assemble the LLM message list for one sidechat turn.
 * Main-session messages (already `buildSessionContext` + `convertToLlm` output
 * — branches/compactions resolved, full fidelity, images/tool pairs intact)
 * pass through by reference: no flattening, no truncation. Exactly ONE valid
 * user message is appended, carrying sidechat history + the new question.
 */
export function buildSidechatMessages(
	mainLlmMessages: readonly unknown[],
	history: SidechatTurn[],
	question: string,
): unknown[] {
	return [...mainLlmMessages, { role: "user", content: renderSidechatPrompt(history, question) }];
}


/** Result of one pane input event (pure reducer; side effects stay in the component). */
export type PaneInputEffect =
	| { kind: "none" }
	| { kind: "render" }
	| { kind: "close" }
	| { kind: "submit"; question: string };

export interface PaneInputState {
	input: string;
	/** A turn is streaming: Enter is ignored so concurrent asks cannot race. */
	busy: boolean;
}


/**
 * Pane input reducer: close keys, submission (busy-guarded), and line edits.
 * Rapid Enter during an in-flight turn is a no-op render — the typed input is
 * preserved so it can be re-submitted once the turn completes.
 */
export function applyPaneInput(
	state: PaneInputState,
	data: string,
	isKey: (data: string, key: string) => boolean,
): PaneInputEffect {
	if (isKey(data, "escape")) return { kind: "close" };
	if (isKey(data, "enter") || data === "\r" || data === "\n") {
		if (state.busy) return { kind: "render" };
		const question = state.input.trim();
		if (question.length === 0) return { kind: "render" };
		state.input = "";
		return { kind: "submit", question };
	}
	if (data === "\x7f" || data === "\b") {
		state.input = state.input.slice(0, -1);
		return { kind: "render" };
	}
	if (data === "\x15") {
		state.input = "";
		return { kind: "render" };
	}
	if (!/[\x00-\x1f\x7f]/.test(data)) {
		state.input += data;
		return { kind: "render" };
	}
	return { kind: "none" };
}
