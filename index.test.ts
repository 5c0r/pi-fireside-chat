import { describe, expect, mock, test } from "bun:test";
import type { PaneComponent, SidechatCommandContext, SidechatContext, SidechatUI } from "./api";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PET_SETTINGS, savePetSettings } from "./pet-data";

// Bun exposes setImmediate at runtime; dependency-free host types omit Node globals.
declare function setImmediate(callback: () => void): void;

type StreamEvent = { type: "text_delta" | "done" | "error"; delta?: string };
type StreamFactory = (options: { signal?: AbortSignal; sessionId?: string }) => Promise<AsyncIterable<StreamEvent>>;

function wrap(text: string, width: number): string[] {
	const size = Math.max(1, width);
	return text.split("\n").flatMap(line => {
		if (line.length === 0) return [""];
		const rows: string[] = [];
		for (let offset = 0; offset < line.length; offset += size) rows.push(line.slice(offset, offset + size));
		return rows;
	});
}

class FakeMarkdown {
	constructor(private text: string) { }
	setText(text: string): boolean {
		this.text = text;
		return true;
	}
	invalidate(): void { }
	render(width: number): string[] {
		// Host Markdown can render nonblank reference-only source as an empty row.
		if (/^\s*\[[^\]]+\]:\s+\S+\s*$/.test(this.text)) return [""];
		return wrap(this.text, width);
	}
}

class FakeBox {
	private child: { render(width: number): readonly string[] } | undefined;
	constructor(
		private readonly paddingX = 0,
		private readonly paddingY = 0,
	) { }
	addChild(child: { render(width: number): readonly string[] }): void {
		this.child = child;
	}
	render(width: number): string[] {
		const padding = Array.from({ length: this.paddingY }, () => "");
		return [...padding, ...(this.child?.render(Math.max(1, width - this.paddingX * 2)) ?? []), ...padding];
	}
}

const keyData: Record<string, string> = {
	escape: "\x1b",
	enter: "\r",
	up: "\x1b[A",
	down: "\x1b[B",
	pageUp: "\x1b[5~",
	pageDown: "\x1b[6~",
	home: "\x1b[H",
	end: "\x1b[F",
};

const streamedModels: unknown[] = [];
let streamFactory: StreamFactory = async () => ({
	async *[Symbol.asyncIterator]() { },
});
let buildSessionContextFactory = (): { messages: unknown[] } => ({ messages: [] });

mock.module("@earendil-works/pi-ai", () => ({
	streamSimple: (model: unknown, _context: unknown, options: Parameters<StreamFactory>[0] = {}) => {
		streamedModels.push(model);
		return streamFactory(options);
	},
}));
let petAgentDir = "";
mock.module("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => petAgentDir,
	buildSessionContext: () => buildSessionContextFactory(),
	convertToLlm: (messages: unknown[]) => messages,
	getMarkdownTheme: () => ({
		heading: (text: string) => text,
		link: (text: string) => text,
		linkUrl: (text: string) => text,
		codeSpan: (text: string) => text,
	}),
}));
mock.module("@earendil-works/pi-tui", () => ({
	Box: FakeBox,
	Markdown: FakeMarkdown,
	matchesKey: (data: string, key: string) => keyData[key] === data,
	wrapTextWithAnsi: wrap,
	truncateToWidth: (text: string, width: number) => text.slice(0, Math.max(0, width)),
}));

// ponytail: host modules are absent in this dependency-free repo; import only after Bun test mocks exist.
const { default: firesideExtension } = await import("./index");

type CommandHandler = (args: string, context: SidechatContext) => Promise<void>;
type EventHandler = (event: unknown, context: SidechatContext) => unknown | Promise<unknown>;

function createHarness(branchEntries: unknown[] = [], hasUI = false) {
	const commands = new Map<string, CommandHandler>();
	const events = new Map<string, EventHandler[]>();
	const appended: Array<{ type: string; data: unknown }> = [];
	const appendedOnce = Promise.withResolvers<void>();
	const notifications: Array<{ message: string; type: string | undefined }> = [];
	let component: PaneComponent | undefined;
	let customOptions: unknown;

	const custom: SidechatUI["custom"] = async <T>(factory: Parameters<SidechatUI["custom"]>[0], options: unknown) => {
		customOptions = options;
		component = await factory(
			{ requestRender() { } },
			{ fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text },
			undefined,
			() => undefined,
		);
		// Test host invokes custom<undefined>; generic interface cannot encode that single call site.
		return undefined as unknown as T;
	};
	const context: SidechatContext = {
		hasUI,
		model: { provider: "test", id: "test" },
		models: { current: () => undefined },
		modelRegistry: { resolver: () => "test-key" },
		sessionManager: {
			getEntries: () => [],
			getBranch: () => branchEntries,
			getLeafId: () => null,
			getSessionId: () => "session-test",
		},
		getSystemPrompt: () => [],
		ui: {
			notify: (message: string, type?: string) => notifications.push({ message, type }),
			select: async () => undefined,
			custom,
		},
	};

	firesideExtension({
		on(event, handler) {
			const handlers = events.get(event) ?? [];
			handlers.push(handler as EventHandler);
			events.set(event, handlers);
		},
		registerCommand(name, options) {
			commands.set(name, options.handler as CommandHandler);
		},
		appendEntry(type, data) {
			appended.push({ type, data });
			appendedOnce.resolve();
		},
	});

	return {
		appended,
		appendedOnce: appendedOnce.promise,
		commands,
		context,
		events,
		notifications,
		get component() {
			return component;
		},
		get customOptions() {
			return customOptions;
		},
		async emit(event: string, payload: unknown = {}) {
			for (const handler of events.get(event) ?? []) await handler(payload, context);
		},
	};
}

function tuiPetHarness(branchEntries: unknown[] = [], random?: () => number) {
	const harness = createHarness(branchEntries, true);
	harness.context.mode = "tui";
	let input: ((data: string) => unknown) | undefined;
	harness.context.ui.onTerminalInput = fn => { input = fn; return () => { input = undefined; }; };
	let widget: { render(width: number, rows: number): readonly string[] } | undefined;
	harness.context.ui.setWidget = (_key, factory) => {
		widget = factory?.(
			{ requestRender() { }, terminal: { rows: 24, columns: 80 } },
			{ fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t },
		);
	};
	if (random) {
		const originalRandom = Math.random;
		Math.random = random;
		return {
			harness,
			input: () => input,
			petRows: (columns = 80) => widget?.render(columns, 24),
			restore: () => { Math.random = originalRandom; },
		};
	}
	return {
		harness,
		input: () => input,
		petRows: (columns = 80) => widget?.render(columns, 24),
		restore: () => { },
	};
}

describe("streaming crumbs producers", () => {
	test("main assistant text_delta events drop food; thinking and tool events do not", async () => {
		const rig = tuiPetHarness([], () => 0.5);
		try {
			await rig.harness.commands.get("fireside")!("", rig.harness.context);
			const baseline = rig.petRows(60)?.join("\n") ?? "";
			const assistant = { message: { role: "assistant" } };
			await rig.harness.emit("message_start");
			const update = (assistantMessageEvent: unknown) =>
				Promise.all((rig.harness.events.get("message_update") ?? [])
					.map(handler => handler({ ...assistant, assistantMessageEvent }, rig.harness.context)));
			await update({ type: "thinking_delta", delta: "internal reasoning" });
			await update({ type: "tool_call", name: "bash" });
			expect(rig.petRows(60)?.join("\n")).toBe(baseline);
			await update({ type: "text_delta", delta: "q7" });
			const rows = rig.petRows(60)?.join("\n") ?? "";
			expect(rows).not.toBe(baseline);
			expect(rows).toContain("q7");
			await update({ type: "thinking_delta", delta: "more reasoning" });
			expect(rig.petRows(60)?.join("\n")).toBe(rows);
		} finally {
			rig.restore();
			rig.harness.component?.dispose?.();
			await rig.harness.emit("session_shutdown");
		}
	});

	test("fireside stream text_delta feeds the shared feeder while snapshots do not", async () => {
		const rig = tuiPetHarness([], () => 0.5);
		try {
			await rig.harness.commands.get("fireside")!("", rig.harness.context);
			const baseline = rig.petRows(60)?.join("\n") ?? "";
			const deltas: Array<{ type: string; delta?: string; message?: unknown }> = [
				{ type: "message", message: { role: "assistant", content: "whole snapshot z9" } },
				{ type: "text_delta", delta: "z9" },
			];
			streamFactory = async () => ({
				async *[Symbol.asyncIterator]() {
					for (const event of deltas) yield event as never;
				},
			});
			await rig.harness.commands.get("fireside")!("side question", rig.harness.context);
			await rig.harness.appendedOnce;
			const rows = rig.petRows(60)?.join("\n") ?? "";
			expect(rows).not.toBe(baseline);
			expect(rows).toContain("z9");
		} finally {
			rig.restore();
			rig.harness.component?.dispose?.();
			await rig.harness.emit("session_shutdown");
		}
	});

	test("actual main and Fireside producers discard text during terminal typing and resume without backlog", async () => {
		let now = 10000;
		const realNow = Date.now;
		Date.now = () => now;
		const rig = tuiPetHarness([], () => 0.5);
		try {
			await rig.harness.commands.get("fireside")!("", rig.harness.context);
			rig.petRows(60);
			rig.input()?.("draft");
			await rig.harness.emit("message_update", {
				message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "q7" },
			});
			streamFactory = async () => ({
				async *[Symbol.asyncIterator]() { yield { type: "text_delta", delta: "z9" } as const; },
			});
			await rig.harness.commands.get("fireside")!("question", rig.harness.context);
			await rig.harness.appendedOnce;
			expect(rig.petRows(60)?.join("\n")).not.toContain("q7");
			expect(rig.petRows(60)?.join("\n")).not.toContain("z9");
			now += 1500;
			await rig.harness.emit("message_update", {
				message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "q8" },
			});
			const rows = rig.petRows(60)?.join("\n") ?? "";
			expect(rows).toContain("q8");
			expect(rows).not.toContain("q7");
			expect(rows).not.toContain("z9");
		} finally {
			Date.now = realNow;
			rig.restore();
			rig.harness.component?.dispose?.();
			await rig.harness.emit("session_shutdown");
		}
	});

	test("actual producer boundaries reset only their parser and never cross-contaminate sources", async () => {
		let now = 10000;
		const realNow = Date.now;
		Date.now = () => now;
		let randomValue = 0.2;
		const rig = tuiPetHarness([], () => randomValue);
		const main = (delta: string) => rig.harness.emit("message_update", {
			message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta },
		});
		try {
			await rig.harness.commands.get("fireside")!("", rig.harness.context);
			rig.petRows(80);
			await main("\x1b]52;c;");
			streamFactory = async () => ({
				async *[Symbol.asyncIterator]() { yield { type: "text_delta", delta: "ok" } as const; },
			});
			await rig.harness.commands.get("fireside")!("question", rig.harness.context);
			await rig.harness.appendedOnce;
			expect(rig.petRows(80)?.join("\n")).toContain("ok");
			now += 500;
			await main("SECRET");
			expect(rig.petRows(80)?.join("\n")).not.toContain("SEC");
			await rig.harness.emit("message_end", { message: { role: "assistant" } });
			randomValue = 0.4;
			await main("yes");
			expect(rig.petRows(80)?.join("\n")).toContain("yes");
			now += 500;
			await main("\x1b[");
			await rig.harness.emit("message_start", { message: { role: "assistant" } });
			randomValue = 0.6;
			await main("new");
			expect(rig.petRows(80)?.join("\n")).toContain("new");
			now += 500;
			streamFactory = async () => ({
				async *[Symbol.asyncIterator]() { yield { type: "text_delta", delta: "\x1b]52;c;" } as const; },
			});
			await rig.harness.commands.get("fireside")!("partial", rig.harness.context);
			const partialSettled = Promise.withResolvers<void>();
			setImmediate(partialSettled.resolve);
			await partialSettled.promise;
			now += 500;
			randomValue = 0.8;
			streamFactory = async () => ({
				async *[Symbol.asyncIterator]() { yield { type: "text_delta", delta: "end" } as const; },
			});
			await rig.harness.commands.get("fireside")!("fresh", rig.harness.context);
			const freshSettled = Promise.withResolvers<void>();
			setImmediate(freshSettled.resolve);
			await freshSettled.promise;
			expect(rig.petRows(80)?.join("\n")).toContain("end");
		} finally {
			Date.now = realNow;
			rig.restore();
			rig.harness.component?.dispose?.();
			await rig.harness.emit("session_shutdown");
		}
	});
});

function delayedReply(reply: string) {
	const started = Promise.withResolvers<AbortSignal>();
	const release = Promise.withResolvers<void>();
	streamFactory = async options => {
		if (!options.signal) throw new Error("missing abort signal");
		started.resolve(options.signal);
		return {
			async *[Symbol.asyncIterator]() {
				await release.promise;
				yield { type: "text_delta", delta: reply } as const;
			},
		};
	};
	return { started: started.promise, release: () => release.resolve() };
}

function heldPaneContext(base: SidechatContext) {
	const opened = Promise.withResolvers<PaneComponent>();
	const closed = Promise.withResolvers<unknown>();
	let didClose = false;
	const custom: SidechatUI["custom"] = async <T>(factory: Parameters<SidechatUI["custom"]>[0]) => {
		const component = await factory(
			{ requestRender() { } },
			{ fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text },
			undefined,
			result => {
				didClose = true;
				closed.resolve(result);
			},
		);
		opened.resolve(component);
		return (await closed.promise) as T;
	};
	return {
		context: { ...base, hasUI: true, ui: { ...base.ui, custom } },
		opened: opened.promise,
		get didClose() {
			return didClose;
		},
	};
}


test("reads and namespaces host sessionId once for Fireside streams", async () => {
	let receivedOptions: Parameters<StreamFactory>[0] = {};
	streamFactory = async options => {
		receivedOptions = options;
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: "text_delta", delta: "reply" } as const;
			},
		};
	};
	const harness = createHarness();
	let getSessionIdCalls = 0;
	harness.context.sessionManager.getSessionId = () => {
		getSessionIdCalls++;
		return "session-test";
	};

	await harness.commands.get("fireside")!("question", harness.context);

	expect(receivedOptions.sessionId).toBe("fireside:session-test");
	expect(getSessionIdCalls).toBe(1);
});
test("omits stream sessionId when the host has none", async () => {
	let receivedOptions: Parameters<StreamFactory>[0] = {};
	streamFactory = async options => {
		receivedOptions = options;
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: "text_delta", delta: "reply" } as const;
			},
		};
	};
	const harness = createHarness();
	harness.context.sessionManager.getSessionId = undefined;

	await harness.commands.get("fireside")!("question", harness.context);

	expect(Object.hasOwn(receivedOptions, "sessionId")).toBe(false);
});


for (const event of ["session_start", "session_switch", "session_branch", "session_tree", "session_shutdown"]) {
	test(`${event} aborts stale fireside work without appending or notifying`, async () => {
		const stream = delayedReply("stale reply");
		const harness = createHarness();
		const run = harness.commands.get("fireside")!("old question", harness.context);
		const signal = await stream.started;

		await harness.emit(event);
		const abortedOnTransition = signal.aborted;
		stream.release();
		await run;

		expect(abortedOnTransition).toBe(true);
		expect(harness.appended).toEqual([]);
		expect(harness.notifications).toEqual([]);
	});
}
test("reports pre-stream setup failures without rejecting the command", async () => {
	buildSessionContextFactory = () => {
		throw new Error("context assembly failed");
	};
	try {
		const harness = createHarness();
		await expect(harness.commands.get("fireside")!("question", harness.context)).resolves.toBeUndefined();
		expect(harness.notifications).toEqual([
			{ message: "fireside: context assembly failed", type: "error" },
		]);
	} finally {
		buildSessionContextFactory = () => ({ messages: [] });
	}
});


test("Esc closes and bare reopen keeps the same reply streaming", async () => {
	const stream = delayedReply("continuing reply");
	const harness = createHarness([], true);
	const command = harness.commands.get("fireside")!;

	await command("question in flight", harness.context);
	const signal = await stream.started;
	const firstPane = harness.component!;
	firstPane.handleInput(keyData.escape);
	firstPane.dispose?.();
	expect(signal.aborted).toBe(false);

	await command("", harness.context);
	const reopenedPane = harness.component!;
	expect(reopenedPane).not.toBe(firstPane);
	expect(reopenedPane.render(40).join("\n")).toContain("question in flight");

	stream.release();
	await harness.appendedOnce;
	expect(signal.aborted).toBe(false);
	expect(harness.appended).toEqual([
		{
			type: "fireside.turn",
			data: { question: "question in flight", reply: "continuing reply" },
		},
	]);
	expect(reopenedPane.render(40).join("\n")).toContain("continuing reply");
});

test("session transition keeps Enter busy-guarded until aborted ask settles", async () => {
	const stream = delayedReply("stale reply");
	const harness = createHarness();
	const command = harness.commands.get("fireside")!;
	const held = heldPaneContext(harness.context);
	const commandRun = command("old question", held.context);
	const [pane] = await Promise.all([held.opened, stream.started]);

	await harness.emit("session_switch");
	for (const char of "next question") pane.handleInput(char);
	pane.handleInput(keyData.enter);

	expect(pane.render(40).join("\n")).toContain("next question");
	expect(harness.notifications).toEqual([]);
	stream.release();
	await new Promise(resolve => setTimeout(resolve, 0));
	pane.handleInput(keyData.escape);
	await commandRun;
});

test("headless execution cannot replace an open pane submit context", async () => {
	streamFactory = async () => ({
		async *[Symbol.asyncIterator]() {
			yield { type: "text_delta", delta: "reply" };
		},
	});
	const harness = createHarness();
	const command = harness.commands.get("fireside")!;
	const resolverCalls: string[] = [];
	const held = heldPaneContext({
		...harness.context,
		modelRegistry: {
			resolver: () => {
				resolverCalls.push("pane");
				return "pane-key";
			},
		},
	});
	const paneRun = command("", held.context);
	const pane = await held.opened;
	const headlessContext: SidechatContext = {
		...harness.context,
		modelRegistry: {
			resolver: () => {
				resolverCalls.push("headless");
				return "headless-key";
			},
		},
	};

	await command("headless question", headlessContext);
	for (const char of "pane question") pane.handleInput(char);
	pane.handleInput(keyData.enter);
	while (harness.appended.length < 2) await new Promise(resolve => setTimeout(resolve, 0));

	expect(resolverCalls).toEqual(["headless", "pane"]);
	pane.handleInput(keyData.escape);
	await paneRun;
});

test("stale pane disposal preserves new pane ownership and close retains no context", async () => {
	const harness = createHarness();
	const command = harness.commands.get("fireside")!;
	const first = heldPaneContext(harness.context);
	const firstRun = command("", first.context);
	const firstPane = await first.opened;
	firstPane.handleInput(keyData.escape);
	await firstRun;

	let secondResolverCalls = 0;
	const second = heldPaneContext({
		...harness.context,
		modelRegistry: {
			resolver: () => {
				secondResolverCalls++;
				return "second-key";
			},
		},
	});
	const secondRun = command("", second.context);
	const secondPane = await second.opened;
	firstPane.dispose?.();

	let closeResolverCalls = 0;
	const closeContext: SidechatContext = {
		...harness.context,
		hasUI: true,
		modelRegistry: {
			resolver: () => {
				closeResolverCalls++;
				return "close-key";
			},
		},
	};
	await command("close", closeContext);
	const closedByCommand = second.didClose;
	if (!closedByCommand) secondPane.handleInput(keyData.escape);
	await secondRun;
	secondPane.dispose?.();

	for (const char of "stale submit") secondPane.handleInput(char);
	secondPane.handleInput(keyData.enter);
	await Promise.resolve();

	expect(closedByCommand).toBe(true);
	expect(closeResolverCalls).toBe(0);
	expect(secondResolverCalls).toBe(0);
});

test("session shutdown releases history and transient pane state", async () => {
	const entries = [{
		type: "custom",
		customType: "fireside.turn",
		data: { question: "old question", reply: "old reply" },
	}];
	const harness = createHarness(entries, true);
	await harness.commands.get("fireside")!("", harness.context);
	const pane = harness.component!;
	pane.render(24);
	pane.handleInput(keyData.home);
	for (const char of "stale draft") pane.handleInput(char);
	expect(pane.render(24).join("\n")).toContain("old question");
	expect(pane.render(24).join("\n")).toContain("stale draft");

	await harness.emit("session_shutdown");
	const afterShutdown = pane.render(24).join("\n");

	expect(afterShutdown).not.toContain("old question");
	expect(afterShutdown).not.toContain("old reply");
	expect(afterShutdown).not.toContain("stale draft");
});

test("lifecycle abort after API-key resolution does not start the provider stream", async () => {
	const keyStarted = Promise.withResolvers<void>();
	const apiKey = Promise.withResolvers<string>();
	let streamCalls = 0;
	streamFactory = async () => {
		streamCalls++;
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: "text_delta", delta: "stale reply" };
			},
		};
	};
	const harness = createHarness();
	harness.context.modelRegistry.resolver = () => {
		keyStarted.resolve();
		return apiKey.promise;
	};
	const run = harness.commands.get("fireside")!("old question", harness.context);
	await keyStarted.promise;

	await harness.emit("session_switch");
	apiKey.resolve("test-key");
	await run;

	expect(streamCalls).toBe(0);
	expect(harness.appended).toEqual([]);
	expect(harness.notifications).toEqual([]);
});

test("session transition settles a silent stream and releases the next turn", async () => {
	const nextStarted = Promise.withResolvers<AbortSignal>();
	const never = new Promise<IteratorResult<StreamEvent>>(() => undefined);
	let streamCalls = 0;
	streamFactory = async options => {
		if (!options.signal) throw new Error("missing abort signal");
		streamCalls++;
		if (streamCalls === 1) {
			const signal = options.signal;
			return {
				[Symbol.asyncIterator]() {
					return {
						next() {
							nextStarted.resolve(signal);
							return never;
						},
					};
				},
			};
		}
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: "text_delta", delta: "fresh reply" } as const;
			},
		};
	};
	const harness = createHarness();
	const command = harness.commands.get("fireside")!;
	const run = command("old question", harness.context);
	const signal = await nextStarted.promise;

	await harness.emit("session_switch");
	const outcome = await Promise.race([
		run.then(() => "settled" as const),
		new Promise<"pending">(resolve => setImmediate(() => resolve("pending"))),
	]);

	expect(signal.aborted).toBe(true);
	expect(outcome).toBe("settled");
	expect(harness.appended).toEqual([]);
	expect(harness.notifications).toEqual([]);

	await command("new question", harness.context);
	expect(harness.appended).toEqual([
		{
			type: "fireside.turn",
			data: { question: "new question", reply: "fresh reply" },
		},
	]);
	expect(harness.notifications).toEqual([{ message: "fireside: fresh reply", type: "info" }]);
});

describe("fireside pane viewport", () => {
	const entries = Array.from({ length: 16 }, (_, index) => ({
		type: "custom",
		customType: "fireside.turn",
		data: {
			question: `Q${String(index).padStart(2, "0")} ${"q".repeat(72)}`,
			reply: `R${String(index).padStart(2, "0")} ${"r".repeat(72)}`,
		},
	}));

	function setTerminalSize(): () => void {
		const rows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		const columns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 12 });
		Object.defineProperty(process.stdout, "columns", { configurable: true, value: 120 });
		return () => {
			if (rows) Object.defineProperty(process.stdout, "rows", rows);
			else delete (process.stdout as { rows?: number }).rows;
			if (columns) Object.defineProperty(process.stdout, "columns", columns);
			else delete (process.stdout as { columns?: number }).columns;
		};
	}

	test("uses host-specific full-terminal overlays and keeps rows within pane width", async () => {
		const restore = setTerminalSize();
		try {
			const ompHarness = createHarness(entries, true);
			await ompHarness.commands.get("fireside")!("", ompHarness.context);
			const lines = ompHarness.component!.render(24);

			expect(ompHarness.customOptions).toEqual({
				overlay: true,
				overlayOptions: {
					width: "100%",
					maxHeight: "100%",
					margin: 0,
					fullscreen: true,
					mouseTracking: false,
				},
			});
			expect(lines.every(line => line.length <= 24)).toBe(true);

			const piHarness = createHarness(entries, true);
			piHarness.context.modelRegistry = {};
			await piHarness.commands.get("fireside")!("", piHarness.context);
			expect(piHarness.customOptions).toEqual({
				overlay: true,
				overlayOptions: { width: "100%", maxHeight: "100%" },
			});
		} finally {
			restore();
		}
	});

	test("wraps a long draft within pane width without growing the overlay", async () => {
		const restore = setTerminalSize();
		try {
			const harness = createHarness([], true);
			await harness.commands.get("fireside")!("", harness.context);
			const pane = harness.component!;
			const width = 12;
			const initialHeight = pane.render(width).length;
			const draft = "abcdefghijklmnopqrstuvwxyz0123456789";

			for (const char of draft) pane.handleInput(char);
			const lines = pane.render(width);
			const promptIndex = lines.findIndex(line => line.startsWith("❯ "));
			const inputRows = lines.slice(promptIndex);

			expect(inputRows.length).toBeGreaterThan(1);
			expect(inputRows.every(line => line.length <= width)).toBe(true);
			expect(inputRows.join("").replace(/^❯ /, "").replace(/▏$/, "")).toBe(draft);
			expect(inputRows.filter(line => line.includes("❯ "))).toHaveLength(1);
			expect(inputRows.at(-1)).toEndWith("▏");
			expect(lines).toHaveLength(initialHeight);
		} finally {
			restore();
		}
	});

	test("manual scroll stays anchored during streaming until navigation reaches tail", async () => {
		const restore = setTerminalSize();
		const chunks = [
			Array.from({ length: 24 }, (_, index) => `LINE-${String(index).padStart(2, "0")}`).join("\n"),
			"\nGROW-1-A\nGROW-1-B\nTAIL-1",
			"\nTAIL-2",
			"\nGROW-3-A\nGROW-3-B\nTAIL-3",
			"\nTAIL-4",
			"\nTAIL-5",
		];
		const releases = chunks.map(() => Promise.withResolvers<void>());
		const consumed = chunks.map(() => Promise.withResolvers<void>());
		streamFactory = async () => ({
			async *[Symbol.asyncIterator]() {
				for (const [index, chunk] of chunks.entries()) {
					await releases[index].promise;
					yield { type: "text_delta", delta: chunk } as const;
					consumed[index].resolve();
				}
			},
		});
		const harness = createHarness([], true);
		await harness.commands.get("fireside")!("streaming question", harness.context);
		const pane = harness.component!;
		const viewport = () => pane.render(24).slice(1, -2).map(line => line.slice(0, -2));
		const emit = async (index: number) => {
			releases[index].resolve();
			await consumed[index].promise;
		};

		try {
			await emit(0);
			viewport();
			pane.handleInput(keyData.up);
			const upAnchor = viewport();
			await emit(1);
			expect(viewport()).toEqual(upAnchor);

			pane.handleInput(keyData.end);
			await emit(2);
			expect(viewport().join("\n")).toContain("TAIL-2");

			pane.handleInput(keyData.pageUp);
			const pageAnchor = viewport();
			await emit(3);
			expect(viewport()).toEqual(pageAnchor);

			for (let step = 0; step < 10; step++) pane.handleInput(keyData.pageDown);
			await emit(4);
			expect(viewport().join("\n")).toContain("TAIL-4");

			pane.handleInput(keyData.up);
			pane.handleInput(keyData.down);
			await emit(5);
			expect(viewport().join("\n")).toContain("TAIL-5");
		} finally {
			for (const release of releases) release.resolve();
			await harness.appendedOnce;
			restore();
		}
	});

	test("pet rows stay above input and outside anchored scroll within the terminal budget", async () => {
		const restore = setTerminalSize();
		const directory = mkdtempSync(join(tmpdir(), "fireside-viewport-"));
		petAgentDir = directory;
		savePetSettings(directory, { ...DEFAULT_PET_SETTINGS, placement: "both", motion: "static" });
		const harness = createHarness(entries, true);
		harness.context.mode = "tui";
		harness.context.ui.setWidget = () => { };
		try {
			await harness.commands.get("fireside")!("", harness.context);
			const pane = harness.component!;
			const tail = pane.render(24);
			expect(tail.length).toBeLessThanOrEqual(12);
			expect(tail.every(line => line.length <= 24)).toBe(true);
			expect(tail.at(-2)).toContain("Miso");
			expect(tail.at(-1)).toStartWith("❯ ");
			const petRows = tail.slice(-4, -1);
			pane.handleInput(keyData.home);
			const oldest = pane.render(24);
			expect(oldest.slice(-4, -1)).toEqual(petRows);
			expect(oldest.slice(1, -5).join("\n")).toContain("Q00");
			pane.handleInput(keyData.end);
			expect(pane.render(24)).toEqual(tail);
		} finally {
			harness.component?.dispose?.();
			await harness.emit("session_shutdown");
			petAgentDir = "";
			rmSync(directory, { recursive: true, force: true });
			restore();
		}
	});

	test("uses latest rendered width for page bounds without skipping the middle", async () => {
		const restore = setTerminalSize();
		try {
			const harness = createHarness(entries, true);
			await harness.commands.get("fireside")!("", harness.context);
			const pane = harness.component!;
			pane.render(24);

			for (let step = 0; step < 100; step++) {
				pane.handleInput(keyData.pageUp);
				pane.render(24);
			}
			expect(pane.render(24).join("\n")).toContain("Q00");

			for (let step = 0; step < 11; step++) {
				pane.handleInput(keyData.pageDown);
				pane.render(24);
			}
			expect(pane.render(24).join("\n")).not.toContain("R15");

			for (let step = 0; step < 100; step++) {
				pane.handleInput(keyData.pageDown);
				pane.render(24);
			}
			expect(pane.render(24).join("\n")).toContain("R15");
		} finally {
			restore();
		}
	});

	test("Home and End reach the first and last rendered rows", async () => {
		const restore = setTerminalSize();
		try {
			const harness = createHarness(entries, true);
			await harness.commands.get("fireside")!("", harness.context);
			const pane = harness.component!;
			pane.render(24);

			pane.handleInput(keyData.home);
			expect(pane.render(24).join("\n")).toContain("Q00");
			pane.handleInput(keyData.end);
			expect(pane.render(24).join("\n")).toContain("R15");
		} finally {
			restore();
		}
	});
});

const main = { provider: "openai-codex", id: "gpt-6-sol" };
const small = { provider: "openai-codex", id: "gpt-6-luna" };

type Command = (args: string, ctx: SidechatCommandContext) => Promise<void>;

function setup(host: "omp" | "pi", initialBranch: unknown[] = []) {
	streamedModels.length = 0;
	streamFactory = async () => (async function*() { yield { type: "text_delta", delta: "local reply" }; })();
	const commands = new Map<string, Command>();
	const notifications: string[] = [];
	let branch: unknown[] = initialBranch;
	let available = [small];
	let choice: string | undefined;
	let options: string[] = [];
	let title = "";
	let onEntry: ((customType: string) => void) | undefined;
	firesideExtension({
		on() { },
		registerCommand(name, { handler }) { commands.set(name, handler); },
		appendEntry(customType, data) {
			branch.push({ type: "custom", customType, data });
			onEntry?.(customType);
		},
	});
	const ctx: SidechatCommandContext = {
		hasUI: true,
		model: main,
		models: host === "omp"
			? { current: () => main, resolve: (role: string) => role === "@smol" ? small : main, list: () => [main, small] }
			: { current: () => main },
		modelRegistry: host === "omp"
			? { resolver: () => undefined }
			: { getAvailable: () => available },
		sessionManager: { getEntries: () => [], getLeafId: () => null, getBranch: () => branch },
		getSystemPrompt: () => "system",
		ui: {
			notify(message) { notifications.push(message); },
			select: async (heading: string, choices: string[]) => {
				title = heading;
				options = choices;
				return choice;
			},
			custom: async () => undefined as never,
		},
	};
	return {
		ctx,
		notifications,
		command: (name: string) => {
			const handler = commands.get(name);
			expect(handler).toBeDefined();
			return handler!;
		},
		choose: (value: string | undefined) => { choice = value; },
		options: () => options,
		title: () => title,
		entries: () => branch,
		onEntry: (callback: (customType: string) => void) => { onEntry = callback; },
		switchBranch: (entries: unknown[]) => { branch = entries; },
		setAvailable: (models: typeof available) => { available = models; },
	};
}

test("Pi selector offers only available concrete models and persists choice", async () => {
	const rig = setup("pi");
	rig.choose("openai-codex/gpt-6-luna");
	await rig.command("fireside-config")("", rig.ctx);
	expect(rig.options()).toEqual(["Follow session", "openai-codex/gpt-6-luna"]);
	expect(rig.entries()).toEqual([{ type: "custom", customType: "fireside.model", data: { model: "openai-codex/gpt-6-luna" } }]);
	expect(rig.ctx.model).toBe(main);
});

test("OMP role choice resolves for subsequent Fireside turn without changing main model", async () => {
	const rig = setup("omp");
	await rig.command("fireside-config")("", rig.ctx);
	const roles = rig.options();
	expect(roles).toContain("Default · openai-codex/gpt-6-sol");
	expect(roles).toContain("Slow · openai-codex/gpt-6-sol");
	rig.choose("Smol · openai-codex/gpt-6-luna");
	await rig.command("fireside-config")("", rig.ctx);
	expect(rig.entries()).toEqual([{ type: "custom", customType: "fireside.model", data: { model: "@smol" } }]);
	rig.ctx.hasUI = false;
	await rig.command("fireside")("what next?", rig.ctx);
	expect(streamedModels).toEqual([small]);
	expect(rig.ctx.model).toBe(main);
});

test("Pi concrete choice routes requests to selected provider/id; cancel keeps choice, Follow session restores main", async () => {
	const rig = setup("pi");
	rig.choose("openai-codex/gpt-6-luna");
	await rig.command("fireside-config")("", rig.ctx);
	rig.choose(undefined);
	await rig.command("fireside-config")("", rig.ctx);
	expect(rig.entries()).toHaveLength(1);
	rig.ctx.hasUI = false;
	await rig.command("fireside")("first", rig.ctx);
	expect(streamedModels).toEqual([small]);
	rig.ctx.hasUI = true;
	rig.choose("Follow session");
	await rig.command("fireside-config")("", rig.ctx);
	rig.ctx.hasUI = false;
	await rig.command("fireside")("second", rig.ctx);
	expect(streamedModels).toEqual([small, main]);
	expect(rig.entries()).toContainEqual({ type: "custom", customType: "fireside.model", data: { model: "session" } });
});

test("reopening selector shows persisted choice; cancel leaves current choice intact", async () => {
	const rig = setup("omp");
	rig.choose("Smol · openai-codex/gpt-6-luna");
	await rig.command("fireside-config")("", rig.ctx);
	rig.choose(undefined);
	await rig.command("fireside-config")("", rig.ctx);
	expect(rig.title()).toContain("Smol");
	expect(rig.entries()).toHaveLength(1);
	await rig.command("fireside-config")("", rig.ctx);
	expect(rig.title()).toContain("Smol");
});

test("branch switch isolates model choices", async () => {
	const rig = setup("omp");
	rig.choose("Smol · openai-codex/gpt-6-luna");
	await rig.command("fireside-config")("", rig.ctx);
	const selectedBranch = rig.entries();
	rig.switchBranch([]);
	rig.ctx.hasUI = false;
	await rig.command("fireside")("other branch", rig.ctx);
	rig.switchBranch(selectedBranch);
	await rig.command("fireside")("reopened branch", rig.ctx);
	rig.switchBranch([]);
	await rig.command("fireside")("rewound branch", rig.ctx);
	expect(streamedModels).toEqual([main, small, main]);
});

test("rewind restores latest reachable choice before Follow session reset", async () => {
	const rig = setup("omp");
	rig.choose("Smol · openai-codex/gpt-6-luna");
	await rig.command("fireside-config")("", rig.ctx);
	const beforeReset = [...rig.entries()];
	rig.choose("Follow session");
	await rig.command("fireside-config")("", rig.ctx);
	rig.ctx.hasUI = false;
	await rig.command("fireside")("latest", rig.ctx);
	rig.switchBranch(beforeReset);
	await rig.command("fireside")("rewound", rig.ctx);
	expect(streamedModels).toEqual([main, small]);
});

test("extension reload reads saved model from active session branch", async () => {
	const first = setup("pi");
	first.choose("openai-codex/gpt-6-luna");
	await first.command("fireside-config")("", first.ctx);
	const reloaded = setup("pi", first.entries());
	reloaded.ctx.hasUI = false;
	await reloaded.command("fireside")("after reload", reloaded.ctx);
	expect(streamedModels).toEqual([small]);
});

test("unavailable selected model errors before stream instead of falling back", async () => {
	const rig = setup("pi");
	rig.choose("openai-codex/gpt-6-luna");
	await rig.command("fireside-config")("", rig.ctx);
	rig.setAvailable([]);
	rig.ctx.hasUI = false;
	await rig.command("fireside")("missing model", rig.ctx);
	expect(streamedModels).toEqual([]);
	expect(rig.notifications.some(message => message.includes("unavailable") && message.includes("/fireside-config"))).toBe(true);
});

test("OMP role re-resolves at request time and rejects missing role", async () => {
	const rig = setup("omp");
	rig.choose("Smol · openai-codex/gpt-6-luna");
	await rig.command("fireside-config")("", rig.ctx);
	rig.ctx.models.resolve = () => main;
	rig.ctx.hasUI = false;
	await rig.command("fireside")("remapped", rig.ctx);
	rig.ctx.models.resolve = () => undefined;
	await rig.command("fireside")("missing role", rig.ctx);
	expect(streamedModels).toEqual([main]);
	expect(rig.notifications.some(message => message.includes("@smol") && message.includes("/fireside-config"))).toBe(true);
});

test("immediate duplicate selected-role pane submit starts only one stream", async () => {
	const rig = setup("omp");
	rig.choose("Smol · openai-codex/gpt-6-luna");
	await rig.command("fireside-config")("", rig.ctx);
	const firstReply = new Promise<void>(resolve => {
		rig.onEntry(type => { if (type === "fireside.turn") resolve(); });
	});
	let ready!: (input: (data: string) => void) => void;
	const inputReady = new Promise<(data: string) => void>(resolve => { ready = resolve; });
	rig.ctx.ui.custom = async factory => {
		const pane = await factory(
			{ requestRender() { } },
			{ fg: (_color, text) => text, bg: (_color, text) => text },
			undefined,
			() => { },
		);
		ready(data => pane.handleInput(data));
		return new Promise<never>(() => { });
	};
	void rig.command("fireside")("", rig.ctx);
	const input = await inputReady;
	input("repeat");
	input("\r");
	input("repeat");
	input("\r");
	await firstReply;
	expect(streamedModels).toEqual([small]);
});
