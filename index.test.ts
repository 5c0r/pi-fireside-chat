import { describe, expect, mock, test } from "bun:test";
import type { PaneComponent, SidechatContext, SidechatUI } from "./api";

// Bun exposes setImmediate at runtime; dependency-free host types omit Node globals.
declare function setImmediate(callback: () => void): void;

type StreamEvent = { type: "text_delta" | "done" | "error"; delta?: string };
type StreamFactory = (options: { signal?: AbortSignal }) => Promise<AsyncIterable<StreamEvent>>;


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

let streamFactory: StreamFactory = async () => ({
	async *[Symbol.asyncIterator]() { },
});
let buildSessionContextFactory = (): { messages: unknown[] } => ({ messages: [] });

mock.module("@earendil-works/pi-ai", () => ({
	streamSimple: (_model: unknown, _context: unknown, options: { signal?: AbortSignal } = {}) =>
		streamFactory(options),
}));
mock.module("@earendil-works/pi-coding-agent", () => ({
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
}));

// ponytail: host modules are absent in this dependency-free repo; import only after Bun test mocks exist.
const { default: firesideExtension } = await import("./index");

type CommandHandler = (args: string, context: SidechatContext) => Promise<void>;
type EventHandler = (event: unknown, context: SidechatContext) => void | Promise<void>;

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
		async emit(event: string) {
			for (const handler of events.get(event) ?? []) await handler({}, context);
		},
	};
}

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

	test("uses host-specific full-terminal overlays with visible scroll controls", async () => {
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
			expect(lines[0]).toContain("PgUp/PgDn");

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
