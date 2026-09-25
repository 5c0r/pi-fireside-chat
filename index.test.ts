import { expect, mock, test } from "bun:test";
import type { SidechatCommandContext } from "./api";

const streamedModels: unknown[] = [];
mock.module("@earendil-works/pi-coding-agent", () => ({
	buildSessionContext: () => ({ messages: [] }),
	convertToLlm: (messages: unknown[]) => messages,
	getMarkdownTheme: () => ({}),
}));
mock.module("@earendil-works/pi-tui", () => ({ Box: class { }, Markdown: class { }, matchesKey: () => false }));
mock.module("@earendil-works/pi-ai", () => ({
	streamSimple: async (model: unknown) => {
		streamedModels.push(model);
		return (async function*() { yield { type: "text_delta", delta: "local reply" }; })();
	},
}));
// Host imports are mocked before loading extension so tests cannot make a real model request.
const { default: firesideExtension } = await import("./index");

const main = { provider: "openai-codex", id: "gpt-6-sol" };
const small = { provider: "openai-codex", id: "gpt-6-luna" };

type Command = (args: string, ctx: SidechatCommandContext) => Promise<void>;

function setup(host: "omp" | "pi", initialBranch: unknown[] = []) {
	streamedModels.length = 0;
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
