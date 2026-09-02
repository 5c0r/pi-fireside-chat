import { describe, expect, test } from "bun:test";
import {
	DECLARED_TOOLS,
	FIRESIDE_ENTRY_TYPE,
	applyPaneInput,
	buildSidechatMessages,
	extractHistory,
	mergeStreamingMessage,
	type SidechatTurn,
} from "./context";

function customEntry(data: unknown, customType: string = FIRESIDE_ENTRY_TYPE): unknown {
	return { type: "custom", customType, data };
}

function turn(question: string, reply: string): SidechatTurn {
	return { question, reply };
}

describe("extractHistory", () => {
	test("rebuilds sidechat turns from com.sidechat.custom entries, ignoring others", () => {
		const branch = [
			{ type: "message", message: { role: "user", content: "hi" } },
			customEntry({ question: "PLANT-α what codewords?", reply: "XRAY-77" }),
			customEntry({ irrelevant: true }, "com.other.ext"),
			customEntry({ question: "again", reply: "ZULU-99" }),
		];
		expect(extractHistory(branch)).toEqual([
			turn("PLANT-α what codewords?", "XRAY-77"),
			turn("again", "ZULU-99"),
		]);
	});

	test("skips malformed sidechat entries", () => {
		const branch = [customEntry({ question: 42, reply: "x" }), customEntry(undefined)];
		expect(extractHistory(branch)).toEqual([]);
	});

	test("reads legacy com.sidechat.turn entries for history continuity", () => {
		const branch = [
			customEntry({ question: "old question", reply: "OLD-1" }, "com.sidechat.turn"),
			customEntry({ question: "new question", reply: "NEW-2" }),
		];
		expect(extractHistory(branch)).toEqual([
			turn("old question", "OLD-1"),
			turn("new question", "NEW-2"),
		]);
	});
});

describe("buildSidechatMessages", () => {
	const mainTurn1 = [{ role: "user", content: "the codeword is XRAY-77" }];

	test("turn 1: main transcript present, question last", () => {
		const messages = buildSidechatMessages(mainTurn1, [], "Reply ONLY with the codewords");
		const json = JSON.stringify(messages);
		expect(json).toContain("XRAY-77");
		const last = messages[messages.length - 1] as { role: string; content: string };
		expect(last.role).toBe("user");
		expect(last.content).toContain("Reply ONLY with the codewords");
	});

	test("turn 2: fresh main fact AND prior sidechat fact both present", () => {
		const mainTurn2 = [
			...mainTurn1,
			{ role: "assistant", content: "noted" },
			{ role: "user", content: "new codeword ZULU-99" },
		];
		const history = [turn("PLANT-α ask", "XRAY-77")];
		const messages = buildSidechatMessages(mainTurn2, history, "Reply ONLY with the codewords");
		const json = JSON.stringify(messages);
		expect(json).toContain("ZULU-99");
		expect(json).toContain("PLANT-α");
		expect(json).toContain("XRAY-77");
	});

	test("history encoded inside single valid user message, not fabricated assistant messages", () => {
		const messages = buildSidechatMessages(
			mainTurn1,
			[turn("q1", "r1")],
			"q2",
		) as Array<{ role: string; content: string }>;
		expect(messages.length).toBe(mainTurn1.length + 1);
		const last = messages[messages.length - 1];
		expect(last.role).toBe("user");
		expect(last.content).toContain("[user] q1");
		expect(last.content).toContain("[fireside assistant] r1");
		expect(last.content).toContain("q2");
	});

	test("main messages pass through by reference — no copy, mutation, or truncation", () => {
		const imageMsg = {
			role: "user",
			content: [
				{ type: "text", text: "look" },
				{ type: "image", data: "x".repeat(10_000) },
			],
		};
		const main = [...mainTurn1, imageMsg];
		const messages = buildSidechatMessages(main, [], "q");
		expect(messages[0]).toBe(main[0]);
		expect(messages[1]).toBe(imageMsg);
		expect(messages.length).toBe(main.length + 1);
	});
});

describe("mergeStreamingMessage (mid-stream /btw parity)", () => {
	test("in-flight assistant message merges into snapshot", () => {
		const persisted = [{ role: "user", content: "Codeword: XRAY-77" }];
		const streaming = { role: "assistant", content: [{ type: "text", text: "OK (partial" }] };
		const merged = mergeStreamingMessage(persisted, streaming);
		expect(merged.length).toBe(2);
		expect(merged[1]).toBe(streaming);
		// non-assistant / absent in-flight messages are not merged
		expect(mergeStreamingMessage(persisted, undefined).length).toBe(1);
		expect(mergeStreamingMessage(persisted, { role: "user", content: "x" }).length).toBe(1);
	});
});


describe("read-only contract", () => {
	test("sidechat declares zero tools", () => {
		expect(DECLARED_TOOLS).toEqual([]);
	});
});

describe("applyPaneInput (busy guard)", () => {
	const isEnter = (data: string, key: string) => (key === "enter" ? data === "\r" : false);
	const isEscape = (data: string, key: string) => (key === "escape" ? data === "\x1b" : false);
	const isKey = (data: string, key: string) => isEnter(data, key) || isEscape(data, key);

	test("rapid double-Enter during streaming submits once and preserves typed input", () => {
		const state = { input: "first question", busy: false };
		const first = applyPaneInput(state, "\r", isKey);
		expect(first).toEqual({ kind: "submit", question: "first question" });
		expect(state.input).toBe("");

		// turn now streaming (busy), user types follow-up and hits Enter twice
		state.busy = true;
		expect(applyPaneInput(state, "second", isKey)).toEqual({ kind: "render" });
		expect(state.input).toBe("second");
		const blocked = applyPaneInput(state, "\r", isKey);
		expect(blocked).toEqual({ kind: "render" });
		const blockedAgain = applyPaneInput(state, "\r", isKey);
		expect(blockedAgain).toEqual({ kind: "render" });
		expect(state.input).toBe("second"); // preserved for resubmit after busy clears

		state.busy = false;
		const release = applyPaneInput(state, "\r", isKey);
		expect(release).toEqual({ kind: "submit", question: "second" });
	});

	test("typing q appends to input — close is Esc-only (dashboard q-close not viable with a text input)", () => {
		const state = { input: "", busy: false };
		expect(applyPaneInput(state, "q", isKey)).toEqual({ kind: "render" });
		expect(state.input).toBe("q");
		expect(applyPaneInput(state, "uestion?", isKey)).toEqual({ kind: "render" });
		expect(state.input).toBe("question?");
		expect(applyPaneInput(state, "\x1b", isKey)).toEqual({ kind: "close" });
	});
	test("close keys, empty enter, backspace, ctrl+u, paste", () => {
		const state = { input: "", busy: false };
		expect(applyPaneInput(state, "\x1b", isKey)).toEqual({ kind: "close" });
		expect(applyPaneInput({ ...state, input: "" }, "\r", isKey)).toEqual({ kind: "render" });
		const editing = { input: "abc", busy: false };
		expect(applyPaneInput(editing, "\x7f", isKey)).toEqual({ kind: "render" });
		expect(editing.input).toBe("ab");
		expect(applyPaneInput(editing, "\x15", isKey)).toEqual({ kind: "render" });
		expect(editing.input).toBe("");
		const paste = { input: "", busy: false };
		expect(applyPaneInput(paste, "hello world", isKey)).toEqual({ kind: "render" });
		expect(paste.input).toBe("hello world");
	});
});
