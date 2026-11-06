import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BUILTIN_PETS,
	BUILTIN_PET_IDS,
	DEFAULT_PET_SETTINGS,
	PET_COLORS,
	PET_IDS,
	PET_PALETTES,
	loadPetSettings,
	parseCustomSprite,
	parsePetSettings,
	randomizePetSettings,
	resolvePetSprite,
	savePetSettings,
	selectPet,
	type PetSettings,
} from "./pet-data";
import { PetEngine } from "./pet-engine";

const DEFAULTS = {
	pet: "miso",
	name: "Miso",
	nameFollowsPet: true,
	palette: "theme",
	size: "full",
	speed: "slow",
	personality: "calm",
	placement: "main",
	motion: "animated",
	foodRain: true,
	customFile: "",
} as const;

function settings(overrides: Partial<PetSettings> = {}): PetSettings {
	return { ...DEFAULTS, ...overrides };
}

function robotSprite(): unknown {
	return {
		version: 1,
		label: "Robot",
		compact: {
			walking: [["[o_o]"], ["[o-o]"]],
			idle: [["[o_o]"]],
			sleep: [["[-_-] z"]],
		},
		full: {
			walking: [
				[" /\\ ", "[o_o]", " / \\"],
				[" /\\ ", "[o-o]", " \\ /"],
			],
			idle: [[" /\\ ", "[o_o]", " / \\"]],
			sleep: [["    ", "[-_-]", " z z"]],
		},
	};
}

function withWalkingFrames(sprite: unknown, frames: string[][]): unknown {
	const clone = JSON.parse(JSON.stringify(sprite)) as Record<string, unknown>;
	const compact = clone.compact as Record<string, unknown>;
	compact.walking = frames;
	return clone;
}

function withAgentDir(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "fireside-pet-data-"));
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}


describe("parsePetSettings", () => {
	test("returns fresh defaults for undefined and null input", () => {
		expect(parsePetSettings(undefined)).toEqual(DEFAULTS);
		expect(parsePetSettings(null)).toEqual(DEFAULTS);
	});

	test("returns a fresh object each call; mutations never leak into defaults or later parses", () => {
		const a = parsePetSettings(undefined);
		const b = parsePetSettings(undefined);
		expect(a).not.toBe(b);
		a.name = "Toast";
		a.pet = "toast";
		expect(parsePetSettings(undefined).name).toBe("Miso");
		expect(parsePetSettings(undefined).pet).toBe("miso");
		expect(DEFAULT_PET_SETTINGS.name).toBe("Miso");
		expect(DEFAULT_PET_SETTINGS.pet).toBe("miso");
	});

	test("keeps valid provided values and defaults missing fields, including explicit undefined", () => {
		expect(parsePetSettings({ pet: "toast", speed: "fast" })).toEqual({ ...DEFAULTS, pet: "toast", speed: "fast", nameFollowsPet: false });
		expect(parsePetSettings({ pet: undefined, name: undefined })).toEqual(DEFAULTS);

		const full = {
			pet: "custom",
			name: "Robo",
			nameFollowsPet: false,
			palette: "amber",
			size: "compact",
			speed: "fast",
			personality: "playful",
			placement: "both",
			motion: "static",
			foodRain: false,
			customFile: "/tmp/robo.json",
		};
		expect(parsePetSettings(full)).toEqual(full);
	});

	test("defaults food rain on for legacy settings and preserves explicit boolean preferences", () => {
		expect(parsePetSettings({ pet: "miso", name: "Miso" }).foodRain).toBe(true);
		expect(parsePetSettings({ foodRain: undefined }).foodRain).toBe(true);
		expect(parsePetSettings({ foodRain: false }).foodRain).toBe(false);
		expect(parsePetSettings({ foodRain: true }).foodRain).toBe(true);
	});

	test("rejects nonboolean food rain values instead of coercing them", () => {
		for (const foodRain of ["true", "false", 0, 1, null, {}, []]) {
			expect(() => parsePetSettings({ foodRain })).toThrow("foodRain must be a boolean");
		}
	});

	test("trims surrounding whitespace from name", () => {
		expect(parsePetSettings({ name: "  Toast  " }).name).toBe("Toast");
	});

	test("rejects unknown enum values for every enum field", () => {
		const cases: Array<[keyof PetSettings, unknown]> = [
			["pet", "dog"],
			["pet", ""],
			["pet", "Miso"],
			["palette", "chartreuse"],
			["size", "medium"],
			["speed", "ludicrous"],
			["personality", "angry"],
			["placement", "side"],
			["motion", "spinning"],
		];
		for (const [key, value] of cases) {
			expect(() => parsePetSettings({ [key]: value })).toThrow();
		}
	});

	test("rejects nonstring field values", () => {
		const cases: Array<[keyof PetSettings, unknown]> = [
			["pet", 5],
			["pet", null],
			["pet", true],
			["name", 42],
			["palette", 1],
			["size", false],
			["speed", null],
			["personality", 0],
			["placement", []],
			["motion", {}],
			["customFile", 3],
			["customFile", null],
		];
		for (const [key, value] of cases) {
			expect(() => parsePetSettings({ [key]: value })).toThrow();
		}
	});

	test("rejects custom paths that could inject terminal controls or exceed filesystem bounds", () => {
		for (const customFile of ["/tmp/\u001b[2J.json", "/tmp/x\n.json", "/tmp/\u202e.json", "x".repeat(4097)]) {
			expect(() => parsePetSettings({ customFile })).toThrow();
		}
		expect(parsePetSettings({ customFile: "/tmp/my pet.json" }).customFile).toBe("/tmp/my pet.json");
	});

	test("rejects nonobject input", () => {
		for (const bad of ["miso", 42, true, [], ["miso"], () => { }]) {
			expect(() => parsePetSettings(bad)).toThrow();
		}
	});

	test("rejects unsafe names but allows printable Unicode letters within length bound", () => {
		const badNames = [
			"",
			"   ",
			"Miso\u001b[31m",
			"Line\nBreak",
			"Tab\tName",
			"Nul\u0000",
			"Del\u007f",
			"C1\u009b",
			"ZeroWidth\u200b",
			"Bidi\u202e",
			"x".repeat(25),
		];
		for (const name of badNames) {
			expect(() => parsePetSettings({ name })).toThrow();
		}

		expect(parsePetSettings({ name: "Möchi" }).name).toBe("Möchi");
		expect(parsePetSettings({ name: "x".repeat(24) }).name).toBe("x".repeat(24));
	});

	test("ignores unknown extra keys", () => {
		expect(parsePetSettings({ pet: "toast", bogus: "x", 1: 2 })).toEqual({ ...DEFAULTS, pet: "toast", nameFollowsPet: false });
	});
});

describe("parseCustomSprite", () => {
	test("rejects malformed root and missing compact or full variants", () => {
		for (const value of [null, undefined, [], "sprite", 1, {}, { version: 1, label: "Robot" }]) {
			expect(() => parseCustomSprite(value)).toThrow();
		}
		for (const variant of ["compact", "full"] as const) {
			const missing = robotSprite() as Record<string, unknown>;
			delete missing[variant];
			expect(() => parseCustomSprite(missing)).toThrow();
		}
	});

	test("parses the contract robot example with id custom and preserved frames", () => {
		const sprite = parseCustomSprite(robotSprite());
		expect(sprite.id).toBe("custom");
		expect(sprite.label).toBe("Robot");
		expect(sprite.compact.walking).toEqual([["[o_o]"], ["[o-o]"]]);
		expect(sprite.compact.idle).toEqual([["[o_o]"]]);
		expect(sprite.compact.sleep).toEqual([["[-_-] z"]]);
		expect(sprite.full.walking).toEqual([
			[" /\\  ", "[o_o]", " / \\ "],
			[" /\\  ", "[o-o]", " \\ / "],
		]);
		expect(sprite.full.sleep).toEqual([["     ", "[-_-]", " z z "]]);
	});

	test("normalizes rows to one padded width per mode, trimming then padding", () => {
		const sprite = parseCustomSprite({
			version: 1,
			label: "Pad",
			compact: {
				walking: [["ab  "], ["a"]],
				idle: [["q"]],
				sleep: [["z"]],
			},
			full: {
				walking: [
					["a", "bb", "c"],
					["a", "b", "cc"],
				],
				idle: [["a", "b", "c"]],
				sleep: [["a", "b", "c"]],
			},
		});
		expect(sprite.compact.walking).toEqual([["ab"], ["a "]]);
		expect(sprite.compact.idle).toEqual([["q"]]);
		expect(sprite.compact.sleep).toEqual([["z"]]);
		expect(sprite.full.walking).toEqual([
			["a ", "bb", "c "],
			["a ", "b ", "cc"],
		]);
	});

	test("rejects unsupported version", () => {
		for (const version of [2, 0, -1, 1.5, "1", null, undefined]) {
			const bad = robotSprite() as Record<string, unknown>;
			if (version === undefined) delete bad.version;
			else bad.version = version;
			expect(() => parseCustomSprite(bad)).toThrow();
		}
	});

	test("rejects missing, empty, unsafe, overlong, or nonstring labels", () => {
		const badLabels: unknown[] = ["", "   ", 5, null, "Rob\u001bot", "Lab\nel", "L".repeat(33)];
		for (const label of badLabels) {
			const bad = robotSprite() as Record<string, unknown>;
			bad.label = label;
			expect(() => parseCustomSprite(bad)).toThrow();
		}
		const clone = robotSprite() as Record<string, unknown>;
		delete clone.label;
		expect(() => parseCustomSprite(clone)).toThrow();

		const ok = robotSprite() as Record<string, unknown>;
		ok.label = "L".repeat(32);
		expect(() => parseCustomSprite(ok)).not.toThrow();
	});

	test("rejects missing or non-array modes", () => {
		for (const mode of ["walking", "idle", "sleep"] as const) {
			const missing = robotSprite() as Record<string, unknown>;
			const compact = missing.compact as Record<string, unknown>;
			delete compact[mode];
			expect(() => parseCustomSprite(missing)).toThrow();

			const notArray = robotSprite() as Record<string, unknown>;
			const badCompact = notArray.compact as Record<string, unknown>;
			badCompact[mode] = "nope";
			expect(() => parseCustomSprite(notArray)).toThrow();
		}
	});

	test("rejects non-array frames and nonstring rows", () => {
		expect(() => parseCustomSprite(withWalkingFrames(robotSprite(), ["[o_o]" as unknown as string[]]))).toThrow();
		expect(() => parseCustomSprite(withWalkingFrames(robotSprite(), [[5 as unknown as string]]))).toThrow();
		expect(() => parseCustomSprite(withWalkingFrames(robotSprite(), [[["deep"] as unknown as string]]))).toThrow();
	});

	test("allows 1..8 frames per mode and rejects 0 or 9", () => {
		const one = withWalkingFrames(robotSprite(), [["[o_o]"]]);
		expect(() => parseCustomSprite(one)).not.toThrow();

		const eight = withWalkingFrames(
			robotSprite(),
			Array.from({ length: 8 }, (_, i) => [`[${i}_${i}]`]),
		);
		expect(() => parseCustomSprite(eight)).not.toThrow();

		const nine = withWalkingFrames(
			robotSprite(),
			Array.from({ length: 9 }, (_, i) => [`[${i}_${i}]`]),
		);
		expect(() => parseCustomSprite(nine)).toThrow();

		expect(() => parseCustomSprite(withWalkingFrames(robotSprite(), []))).toThrow();
	});

	test("applies frame count and height limits to all three states in both variants", () => {
		for (const [variant, height] of [["compact", 1], ["full", 3]] as const) {
			for (const mode of ["walking", "idle", "sleep"] as const) {
				for (const count of [0, 9]) {
					const bad = robotSprite() as Record<string, unknown>;
					const frames = bad[variant] as Record<string, unknown>;
					frames[mode] = Array.from({ length: count }, () => Array.from({ length: height }, () => "x"));
					expect(() => parseCustomSprite(bad)).toThrow();
				}
				for (const rows of [height - 1, height + 1]) {
					const bad = robotSprite() as Record<string, unknown>;
					const frames = bad[variant] as Record<string, unknown>;
					frames[mode] = [Array.from({ length: rows }, () => "x")];
					expect(() => parseCustomSprite(bad)).toThrow();
				}
			}
		}
	});

	test("requires compact frames of exactly one row", () => {
		expect(() => parseCustomSprite(withWalkingFrames(robotSprite(), [["a", "b"]]))).toThrow();
		expect(() => parseCustomSprite(withWalkingFrames(robotSprite(), [[]]))).toThrow();
		expect(() =>
			parseCustomSprite(withWalkingFrames(robotSprite(), [["a"], ["b", "c"]])),
		).toThrow();
	});

	test("requires full frames of exactly three rows", () => {
		const twoRows = robotSprite() as Record<string, unknown>;
		const full = twoRows.full as Record<string, unknown>;
		full.idle = [[" /\\ ", "[o_o]"]];
		expect(() => parseCustomSprite(twoRows)).toThrow();

		const fourRows = robotSprite() as Record<string, unknown>;
		const full4 = fourRows.full as Record<string, unknown>;
		full4.idle = [[" /\\ ", "[o_o]", " / \\", " x  "]];
		expect(() => parseCustomSprite(fourRows)).toThrow();

		const mixed = robotSprite() as Record<string, unknown>;
		const fullM = mixed.full as Record<string, unknown>;
		fullM.walking = [
			[" /\\ ", "[o_o]", " / \\"],
			[" /\\ ", "[o-o]"],
		];
		expect(() => parseCustomSprite(mixed)).toThrow();
	});

	test("allows rows up to 32 columns and rejects 33", () => {
		const ok = withWalkingFrames(robotSprite(), [["x".repeat(32)]]);
		expect(() => parseCustomSprite(ok)).not.toThrow();

		const tooWide = withWalkingFrames(robotSprite(), [["x".repeat(33)]]);
		expect(() => parseCustomSprite(tooWide)).toThrow();
	});

	test("rejects control, ANSI, DEL, C1, and non-ASCII characters in rows", () => {
		const badRows = [
			"\u001b[31m",
			"line\nbreak",
			"tab\there",
			"nul\u0000",
			"del\u007f",
			"c1\u009b",
			"accentué",
			"你",
			"box─draw",
			"emoji\u{1f600}",
		];
		for (const row of badRows) {
			expect(() => parseCustomSprite(withWalkingFrames(robotSprite(), [[row]]))).toThrow();
		}
	});

	test("rejects frames with no visible sprite content", () => {
		expect(() => parseCustomSprite(withWalkingFrames(robotSprite(), [["   "]]))).toThrow();
		expect(() => parseCustomSprite(withWalkingFrames(robotSprite(), [[""]]))).toThrow();
		expect(() =>
			parseCustomSprite(withWalkingFrames(robotSprite(), [["  "], ["  "]])),
		).toThrow();
	});
});

describe("savePetSettings / loadPetSettings", () => {
	test("saves into a nonexistent nested agent dir, writes only fireside-pet.json, and loads it back", () => {
		withAgentDir((root) => {
			const agentDir = join(root, "nested", "agent");
			savePetSettings(agentDir, settings({ pet: "toast", name: "Toast" }));
			expect(readdirSync(agentDir)).toEqual(["fireside-pet.json"]);

			const loaded = loadPetSettings(agentDir);
			expect(loaded.settings).toEqual({ ...DEFAULTS, pet: "toast", name: "Toast" });
			expect(loaded.error).toBeUndefined();
		});
	});

	test("missing file yields fresh defaults without error", () => {
		withAgentDir((dir) => {
			const loaded = loadPetSettings(join(dir, "does-not-exist"));
			expect(loaded.settings).toEqual(DEFAULTS);
			expect(loaded.error).toBeUndefined();
		});
	});

	test("malformed JSON file yields defaults with an explicit error", () => {
		withAgentDir((dir) => {
			writeFileSync(join(dir, "fireside-pet.json"), "{not json");
			const loaded = loadPetSettings(dir);
			expect(loaded.settings).toEqual(DEFAULTS);
			expect(typeof loaded.error).toBe("string");
			expect(loaded.error?.length).toBeGreaterThan(0);
		});
	});

	test("malformed preferences escape terminal controls in parser errors", () => {
		withAgentDir((dir) => {
			for (const control of ["\u001b[2J", "\u009b2J", "\u202e", "\u2066", "\u2028"]) {
				writeFileSync(join(dir, "fireside-pet.json"), control);
				const result = loadPetSettings(dir);
				const unsafeCodes = Array.from(result.error ?? "").filter(char => /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(char)).map(char => char.codePointAt(0));
				expect(unsafeCodes).toEqual([]);
				expect(result.error?.includes("Could not load pet settings")).toBe(true);
				expect(result.error?.includes("\\u")).toBe(true);
				expect(result.settings).toEqual(DEFAULTS);
			}
		});
	});

	test("persisted invalid values yield defaults with an explicit error", () => {
		withAgentDir((dir) => {
			writeFileSync(join(dir, "fireside-pet.json"), JSON.stringify({ pet: "dog", name: 5 }));
			const loaded = loadPetSettings(dir);
			expect(loaded.settings).toEqual(DEFAULTS);
			expect(typeof loaded.error).toBe("string");
			expect(loaded.error?.length).toBeGreaterThan(0);
		});
	});
	test("nonobject persisted JSON recovers with an error rather than treating it as valid defaults", () => {
		withAgentDir((dir) => {
			for (const value of [null, [], "miso", 3]) {
				writeFileSync(join(dir, "fireside-pet.json"), JSON.stringify(value));
				const loaded = loadPetSettings(dir);
				expect(loaded.settings).toEqual(DEFAULTS);
				expect(typeof loaded.error).toBe("string");
			}
		});
	});


	test("persists every field across fresh loads and a separate process instance", () => {
		withAgentDir((dir) => {
			const chosen = settings({
				pet: "custom",
				name: "Röbo",
				nameFollowsPet: false,
				palette: "mint",
				size: "compact",
				speed: "fast",
				personality: "sleepy",
				placement: "both",
				motion: "hidden",
				foodRain: false,
				customFile: "/tmp/robo.json",
			});
			savePetSettings(dir, chosen);

			const first = loadPetSettings(dir);
			const second = loadPetSettings(dir);
			expect(first.settings).toEqual(chosen);
			expect(second.settings).toEqual(chosen);
			expect(first.error).toBeUndefined();
			expect(second.error).toBeUndefined();

			const moduleUrl = new URL("./pet-data.ts", import.meta.url).href;
			const script = `import { loadPetSettings } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(loadPetSettings(${JSON.stringify(dir)})));`;
			const restarted = spawnSync(process.execPath, ["--eval", script], { encoding: "utf8" });
			expect(restarted.status).toBe(0);
			expect(restarted.stderr).toBe("");
			expect(JSON.parse(restarted.stdout)).toEqual({ settings: chosen });
		});
	});

	test("persists both food rain preferences across explicit saves and fresh loads", () => {
		withAgentDir(dir => {
			for (const foodRain of [false, true]) {
				const chosen = settings({ foodRain });
				savePetSettings(dir, chosen);
				expect(JSON.parse(readFileSync(join(dir, "fireside-pet.json"), "utf8")).foodRain).toBe(foodRain);
				expect(loadPetSettings(dir)).toEqual({ settings: chosen });
			}
		});
	});

	test("legacy food rain defaults never eagerly rewrite persisted bytes", () => {
		withAgentDir(dir => {
			const file = join(dir, "fireside-pet.json");
			const legacy = ' { "pet": "miso", "name": "Miso" }\n';
			writeFileSync(file, legacy);
			const loaded = loadPetSettings(dir);
			expect(loaded.settings.foodRain).toBe(true);
			expect(loaded.error).toBeUndefined();
			expect(readFileSync(file, "utf8")).toBe(legacy);
			savePetSettings(dir, loaded.settings);
			expect(JSON.parse(readFileSync(file, "utf8")).foodRain).toBe(true);
		});
	});

	test("save rejects invalid settings and writes nothing", () => {
		withAgentDir((dir) => {
			expect(() => savePetSettings(dir, { ...DEFAULTS, pet: "dog" } as unknown as PetSettings)).toThrow();
			expect(() => savePetSettings(dir, { ...DEFAULTS, name: "Bad\u001b" } as PetSettings)).toThrow();
			expect(() => savePetSettings(dir, { ...DEFAULTS, foodRain: "true" } as unknown as PetSettings)).toThrow("foodRain must be a boolean");
			expect(existsSync(join(dir, "fireside-pet.json"))).toBe(false);
		});
	});

	test("save overwrites a previous file and leaves no temp files", () => {
		withAgentDir((dir) => {
			savePetSettings(dir, settings({ name: "One", nameFollowsPet: false }));
			expect(() => savePetSettings(dir, { ...DEFAULTS, pet: "dog" } as unknown as PetSettings)).toThrow();
			expect(loadPetSettings(dir).settings.name).toBe("One");
			savePetSettings(dir, settings({ name: "Two", nameFollowsPet: false }));
			expect(loadPetSettings(dir).settings.name).toBe("Two");
			expect(readdirSync(dir)).toEqual(["fireside-pet.json"]);
		});
	});
});

describe("resolvePetSprite", () => {
	test("resolves every builtin pet without error, ignoring customFile", () => {
		for (const id of BUILTIN_PET_IDS) {
			const { sprite, error } = resolvePetSprite(settings({ pet: id, name: BUILTIN_PETS[id].label, customFile: "/nonexistent.json" }));
			expect(sprite).toBe(BUILTIN_PETS[id]);
			expect(error).toBeUndefined();
		}
	});

	test("resolves a valid custom sprite file", () => {
		withAgentDir((dir) => {
			const file = join(dir, "robot.json");
			writeFileSync(file, JSON.stringify(robotSprite()));
			const { sprite, error } = resolvePetSprite(settings({ pet: "custom", customFile: file }));
			expect(error).toBeUndefined();
			expect(sprite.id).toBe("custom");
			expect(sprite.label).toBe("Robot");
			expect(sprite.compact.walking[0]).toEqual(["[o_o]"]);
			expect(sprite.full.idle[0]).toEqual([" /\\  ", "[o_o]", " / \\ "]);
		});
	});

	test("custom pet with empty customFile falls back to Miso with an explicit error", () => {
		const { sprite, error } = resolvePetSprite(settings({ pet: "custom", customFile: "" }));
		expect(sprite).toBe(BUILTIN_PETS.miso);
		expect(typeof error).toBe("string");
		expect(error?.length).toBeGreaterThan(0);
	});

	test("custom pet with missing file falls back to Miso with an explicit error", () => {
		withAgentDir((dir) => {
			const { sprite, error } = resolvePetSprite(
				settings({ pet: "custom", customFile: join(dir, "nope.json") }),
			);
			expect(sprite).toBe(BUILTIN_PETS.miso);
			expect(typeof error).toBe("string");
			expect(error?.length).toBeGreaterThan(0);
		});
	});

	test("custom pet with malformed or schema-invalid files falls back to Miso with errors", () => {
		withAgentDir((dir) => {
			const malformed = join(dir, "malformed.json");
			writeFileSync(malformed, "{oops");
			const bad = resolvePetSprite(settings({ pet: "custom", customFile: malformed }));
			expect(bad.sprite).toBe(BUILTIN_PETS.miso);
			expect(typeof bad.error).toBe("string");

			const invalid = join(dir, "invalid.json");
			writeFileSync(invalid, JSON.stringify({ version: 2 }));
			const bad2 = resolvePetSprite(settings({ pet: "custom", customFile: invalid }));
			expect(bad2.sprite).toBe(BUILTIN_PETS.miso);
			expect(typeof bad2.error).toBe("string");

			const invalidUtf8 = join(dir, "invalid-utf8.json");
			writeFileSync(invalidUtf8, new Uint8Array([0xff, 0xfe, 0xfd]));
			const badEncoding = resolvePetSprite(settings({ pet: "custom", customFile: invalidUtf8 }));
			expect(badEncoding.sprite).toBe(BUILTIN_PETS.miso);
			expect(typeof badEncoding.error).toBe("string");
		});
	});

	test("malformed custom JSON escapes terminal controls before returning its fallback error", () => {
		withAgentDir((dir) => {
			const file = join(dir, "malformed.json");
			for (const control of ["\u001b[2J", "\u009b2J", "\u202e", "\u2066", "\u2028"]) {
				writeFileSync(file, control);
				const result = resolvePetSprite(settings({ pet: "custom", customFile: file }));
				const unsafeCodes = Array.from(result.error ?? "").filter(char => /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(char)).map(char => char.codePointAt(0));
				expect(unsafeCodes).toEqual([]);
				expect(result.error?.includes("Could not load custom sprite")).toBe(true);
				expect(result.error?.includes("\\u")).toBe(true);
				expect(result.sprite).toBe(BUILTIN_PETS.miso);
			}
		});
	});
	test("rejects a custom directory instead of reading it as sprite data", () => {
		withAgentDir((dir) => {
			const result = resolvePetSprite(settings({ pet: "custom", customFile: dir }));
			expect(result.sprite).toBe(BUILTIN_PETS.miso);
			expect(typeof result.error).toBe("string");
		});
	});


	test("custom file is bounded to 64 KiB: 65536 bytes load, 65537 reject with fallback", () => {
		withAgentDir((dir) => {
			const file = join(dir, "robot.json");
			const json = JSON.stringify(robotSprite());
			const padded = json + " ".repeat(65536 - json.length);
			expect(padded.length).toBe(65536);

			writeFileSync(file, padded);
			const ok = resolvePetSprite(settings({ pet: "custom", customFile: file }));
			expect(ok.error).toBeUndefined();
			expect(ok.sprite.label).toBe("Robot");

			writeFileSync(file, padded + " ");
			const tooBig = resolvePetSprite(settings({ pet: "custom", customFile: file }));
			expect(tooBig.sprite).toBe(BUILTIN_PETS.miso);
			expect(typeof tooBig.error).toBe("string");
		});
	});
});

describe("BUILTIN_PETS", () => {
	const sprites = Object.values(BUILTIN_PETS);

	test("keeps the original pets with matching ids and distinct labels throughout the catalog", () => {
		expect(Object.keys(BUILTIN_PETS)).toEqual(expect.arrayContaining(["miso", "toast", "mochi", "ember"]));
		for (const [id, sprite] of Object.entries(BUILTIN_PETS)) {
			expect(sprite.id).toBe(id);
			expect(sprite.label.trim().length).toBeGreaterThan(0);
		}
		const labels = sprites.map((s) => s.label);
		expect(new Set(labels).size).toBe(labels.length);
		expect(resolvePetSprite({ ...DEFAULT_PET_SETTINGS }).sprite).toBe(BUILTIN_PETS.miso);
	});

	test("every mode in compact and full has 1..8 frames; walking and idle at least two, sleep at least one", () => {
		for (const sprite of sprites) {
			for (const [variant, frames] of [
				["compact", sprite.compact],
				["full", sprite.full],
			] as const) {
				for (const mode of ["walking", "idle", "sleep"] as const) {
					expect(frames[mode].length, `${sprite.id}.${variant}.${mode} frame count`).toBeGreaterThanOrEqual(1);
					expect(frames[mode].length, `${sprite.id}.${variant}.${mode} frame count`).toBeLessThanOrEqual(8);
				}
				expect(frames.walking.length, `${sprite.id}.${variant}.walking`).toBeGreaterThanOrEqual(2);
				expect(frames.idle.length, `${sprite.id}.${variant}.idle`).toBeGreaterThanOrEqual(2);
				expect(frames.sleep.length, `${sprite.id}.${variant}.sleep`).toBeGreaterThanOrEqual(1);
			}
		}
	});

	test("compact frames are exactly one row and full frames exactly three rows of printable ASCII", () => {
		for (const sprite of sprites) {
			for (const [variant, frames, height] of [
				["compact", sprite.compact, 1],
				["full", sprite.full, 3],
			] as const) {
				for (const mode of ["walking", "idle", "sleep"] as const) {
					for (const frame of frames[mode]) {
						expect(frame.length, `${sprite.id}.${variant}.${mode} height`).toBe(height);
						for (const row of frame) {
							expect(row.length, `${sprite.id}.${variant}.${mode} row width`).toBeLessThanOrEqual(32);
							for (const ch of row) {
								const code = ch.codePointAt(0) ?? 0;
								expect(code, `${sprite.id}.${variant}.${mode} ascii`).toBeGreaterThanOrEqual(0x20);
								expect(code, `${sprite.id}.${variant}.${mode} ascii`).toBeLessThanOrEqual(0x7e);
							}
						}
						expect(
							frame.some((row) => row.trim().length > 0),
							`${sprite.id}.${variant}.${mode} visible content`,
						).toBe(true);
					}
				}
			}
		}
	});

	test("all rows within a mode share one padded width", () => {
		for (const sprite of sprites) {
			for (const [variant, frames] of [
				["compact", sprite.compact],
				["full", sprite.full],
			] as const) {
				for (const mode of ["walking", "idle", "sleep"] as const) {
					const widths = new Set(frames[mode].flat().map((row) => row.length));
					expect(widths.size, `${sprite.id}.${variant}.${mode} uniform width`).toBe(1);
				}
			}
		}
	});

	test("poses are distinct: walking alternates, idle alternates, and modes differ from each other", () => {
		const key = (frame: string[]): string => frame.join("\n");
		for (const sprite of sprites) {
			for (const frames of [sprite.compact, sprite.full]) {
				expect(frames.walking[0], `${sprite.id} walking alternates`).not.toEqual(frames.walking[1]);
				expect(frames.idle[0], `${sprite.id} idle alternates`).not.toEqual(frames.idle[1]);
				expect(key(frames.walking[0]), `${sprite.id} walking vs idle`).not.toBe(key(frames.idle[0]));
				expect(key(frames.idle[0]), `${sprite.id} idle vs sleep`).not.toBe(key(frames.sleep[0]));
				expect(key(frames.walking[0]), `${sprite.id} walking vs sleep`).not.toBe(key(frames.sleep[0]));
			}
		}
	});

	test("all builtin pets are pairwise distinct sprites", () => {
		const seen = new Set<string>();
		for (const sprite of sprites) {
			const key = `${sprite.full.walking[0].join("|")}##${sprite.compact.idle[0].join("|")}`;
			expect(seen.has(key), `${sprite.id} distinct from earlier pets`).toBe(false);
			seen.add(key);
		}
	});
});

describe("expanded roster", () => {
	const additions = [
		["pip", "Pip"],
		["soba", "Soba"],
		["pebble", "Pebble"],
		["waddles", "Waddles"],
		["sprout", "Sprout"],
		["nori", "Nori"],
	] as const;

	for (const [id, label] of additions) {
		test(`${label} resolves as a complete builtin with animated poses in both sizes`, () => {
			const result = resolvePetSprite(settings({ pet: id as PetSettings["pet"], name: label }));
			expect(result.error).toBeUndefined();
			expect(result.sprite?.id).toBe(id);
			expect(result.sprite?.label).toBe(label);
			for (const variant of ["compact", "full"] as const) {
				for (const mode of ["walking", "idle", "sleep"] as const) {
					const frames = result.sprite?.[variant][mode] ?? [];
					expect(frames.length, `${id}.${variant}.${mode} frames`).toBeGreaterThanOrEqual(2);
					expect(new Set(frames.map(frame => frame.join("\n"))).size, `${id}.${variant}.${mode} animation`).toBeGreaterThanOrEqual(2);
				}
			}
		});
	}
});

describe("catalog-derived preferences", () => {
	test("every catalog choice validates, resolves, and survives save/reload", () => {
		withAgentDir(dir => {
			for (const id of BUILTIN_PET_IDS) {
				const chosen = parsePetSettings({ pet: id, name: BUILTIN_PETS[id].label });
				expect(resolvePetSprite(chosen)).toEqual({ sprite: BUILTIN_PETS[id] });
				savePetSettings(dir, chosen);
				expect(loadPetSettings(dir)).toEqual({ settings: chosen });
			}
			for (const palette of PET_PALETTES) {
				expect(parsePetSettings({ palette }).palette).toBe(palette);
			}
		});
	});
});

describe("selectPet", () => {
	test("follows default labels across every builtin selection without mutating preferences", () => {
		for (const previous of BUILTIN_PET_IDS) {
			const original = Object.freeze(settings({ pet: previous, name: BUILTIN_PETS[previous].label }));
			for (const next of BUILTIN_PET_IDS) {
				const chosen = selectPet(original, next);
				expect(chosen).toEqual({ ...original, pet: next, name: BUILTIN_PETS[next].label });
				expect(chosen).not.toBe(original);
			}
			expect(original.name).toBe(BUILTIN_PETS[previous].label);
		}
	});

	test("preserves custom names and both directions across the custom-sprite boundary", () => {
		expect(selectPet(settings({ name: "Buddy", nameFollowsPet: false }), "pip").name).toBe("Buddy");
		expect(selectPet(settings({ pet: "custom", name: "Miso", nameFollowsPet: false }), "pip").name).toBe("Miso");
		expect(selectPet(settings(), "custom").name).toBe("Miso");
		const original = Object.freeze(settings({
			name: "Buddy", nameFollowsPet: false, palette: "rose", size: "compact", speed: "fast", personality: "sleepy",
			placement: "both", motion: "static", customFile: "/tmp/my-pet.json",
		}));
		expect(selectPet(original, "nori")).toEqual({ ...original, pet: "nori" });
	});
});

describe("randomizePetSettings", () => {
	const last = () => 0.9999999999999999;

	test("pet action picks first and last eligible builtins and updates default labels", () => {
		const original = Object.freeze(settings({ palette: "rose" }));
		expect(randomizePetSettings(original, "pet", () => 0)).toEqual({ ...original, pet: "toast", name: "Toast" });
		expect(randomizePetSettings(original, "pet", last)).toEqual({ ...original, pet: "nori", name: "Nori" });
		expect(randomizePetSettings(settings({ pet: "nori", name: "Nori" }), "pet", last).pet).toBe("sprout");
		expect(original).toEqual(settings({ palette: "rose" }));
	});

	test("color action picks actual curated colors, excludes current color, and leaves pet alone", () => {
		const original = Object.freeze(settings({ pet: "pip", name: "Pip", palette: "amber" }));
		expect(randomizePetSettings(original, "color", () => 0)).toEqual({ ...original, palette: "mint" });
		expect(randomizePetSettings(original, "color", last)).toEqual({ ...original, palette: "lavender" });
		expect(randomizePetSettings(settings(), "color", () => 0).palette).toBe("amber");
		expect(randomizePetSettings(settings({ palette: "lavender" }), "color", last).palette).toBe("sky");
	});

	test("pet rolls never repeat and never select custom, including every deterministic candidate", () => {
		for (const current of PET_IDS) {
			const original = settings({ pet: current, name: "Buddy", nameFollowsPet: false, customFile: "/tmp/robot.json" });
			const eligible = BUILTIN_PET_IDS.filter(id => id !== current);
			for (let index = 0; index < eligible.length; index++) {
				const chosen = randomizePetSettings(original, "pet", () => (index + 0.5) / eligible.length);
				expect(chosen.pet).toBe(eligible[index]);
				expect(chosen.pet).not.toBe(current);
				expect(chosen.pet).not.toBe("custom");
				expect(chosen.name).toBe("Buddy");
				expect(chosen.customFile).toBe(original.customFile);
			}
		}
	});

	test("custom current pet allows first and last builtins without adopting their default names", () => {
		const original = Object.freeze(settings({ pet: "custom", name: "Miso", nameFollowsPet: false, customFile: "/tmp/robot.json" }));
		expect(randomizePetSettings(original, "pet", () => 0)).toEqual({ ...original, pet: "miso" });
		expect(randomizePetSettings(original, "pet", last)).toEqual({ ...original, pet: "nori" });
	});

	test("color rolls never repeat and never pick theme", () => {
		for (const palette of PET_PALETTES) {
			for (const random of [() => 0, last]) {
				const chosen = randomizePetSettings(settings({ palette }), "color", random);
				expect(chosen.palette).not.toBe(palette);
				expect(chosen.palette).not.toBe("theme");
				expect(Object.hasOwn(PET_COLORS, chosen.palette)).toBe(true);
			}
		}
	});

	test("both rolls independently once per field and preserves unrelated preferences", () => {
		const original = Object.freeze(settings({
			palette: "amber", size: "compact", speed: "fast", personality: "playful",
			placement: "fireside", motion: "hidden", foodRain: false, customFile: "/tmp/robot.json",
		}));
		let calls = 0;
		const chosen = randomizePetSettings(original, "both", () => calls++ === 0 ? 0 : last());
		expect(calls).toBe(2);
		expect(chosen).toEqual({ ...original, pet: "toast", name: "Toast", palette: "lavender" });
		expect(chosen).not.toBe(original);
		const named = { ...original, name: "Buddy", nameFollowsPet: false };
		expect(randomizePetSettings(named, "both", () => 0)).toEqual({ ...named, pet: "toast", palette: "mint" });
	});

	test("every random action preserves food rain on and off without mutating its input", () => {
		for (const foodRain of [false, true]) {
			const original = Object.freeze(settings({ foodRain }));
			for (const action of ["pet", "color", "both"] as const) {
				for (const random of [() => 0, last]) {
					const chosen = randomizePetSettings(original, action, random);
					expect(chosen.foodRain).toBe(foodRain);
					expect(original.foodRain).toBe(foodRain);
				}
			}
		}
	});

	test("single-field actions draw only once without retry loops", () => {
		for (const action of ["pet", "color"] as const) {
			let calls = 0;
			randomizePetSettings(settings(), action, () => { calls++; return 0; });
			expect(calls).toBe(1);
		}
	});
});

describe("catalog engine rendering", () => {
	test("all builtin poses and walking directions stay safe in compact/full and narrow viewports", () => {
		for (const id of BUILTIN_PET_IDS) {
			for (const size of ["compact", "full"] as const) {
				const sprite = BUILTIN_PETS[id];
				const frames = sprite[size];
				const width = Math.max(...Object.values(frames).flat(2).map(row => row.length)) + 5;
				const height = size === "full" ? 3 : 1;
				let now = 0;
				let tick = () => { };
				const engine = new PetEngine(settings({ pet: id, name: "Render probe", nameFollowsPet: false, size, personality: "sleepy" }), sprite, {
					now: () => now,
					setInterval: fn => { tick = fn; return 1; },
					clearInterval: () => { },
				});
				const unsubscribe = engine.subscribe(() => { });
				const advance = (ms: number) => { now += ms; tick(); };
				const expectSafe = (rows: string[], columns: number, rowLimit: number) => {
					expect(rows.length).toBeLessThanOrEqual(rowLimit);
					for (const row of rows) {
						expect(row.length).toBeLessThanOrEqual(columns);
						expect(/^[\x20-\x7e]*$/.test(row)).toBe(true);
					}
				};
				try {
					expect(engine.render(width, height)).toEqual(frames.walking[0].map(row => row.trimEnd()));
					advance(400);
					expect(engine.render(width, height)).toEqual(frames.walking[1].map(row => ` ${row.trimEnd()}`));
					advance(1_600); // Reach the right edge while displaying walking frame 1.
					expectSafe(engine.render(width, height), width, height);
					advance(400); // Display walking frame 0 while moving left.
					expectSafe(engine.render(width, height), width, height);
					advance(1_600); // Return to the left edge before stationary poses.
					engine.activity("typing");
					expect(engine.render(width, height)).toEqual(frames.idle[0].map(row => row.trimEnd()));
					advance(900);
					expect(engine.render(width, height)).toEqual(frames.idle[1].map(row => row.trimEnd()));
					advance(8_000);
					expect(engine.render(width, height)).toEqual(frames.sleep[0].map(row => row.trimEnd()));
					advance(1_500);
					expect(engine.render(width, height)).toEqual(frames.sleep[1].map(row => row.trimEnd()));
					for (const columns of [1, 2, width - 2, width]) {
						for (const rows of [1, 2, 3]) {
							const rendered = engine.render(columns, rows);
							expect(rendered.length).toBe(size === "full" && rows >= 3 ? 3 : 1);
							expectSafe(rendered, columns, rows);
						}
					}
				} finally {
					unsubscribe();
					engine.dispose();
				}
			}
		}
	});
});

describe("persisted naming intent", () => {
	test("a custom label collision survives sequential manual and random selections", () => {
		const named = settings({ name: "Toast", nameFollowsPet: false });
		const toast = selectPet(named, "toast");
		expect(toast.name).toBe("Toast");
		expect(selectPet(toast, "nori").name).toBe("Toast");
		const randomToast = randomizePetSettings(named, "pet", () => 0);
		expect(randomToast.pet).toBe("toast");
		expect(randomizePetSettings(randomToast, "both", () => 0).name).toBe("Toast");
	});

	test("Save and reload between colliding species cannot reclassify a custom name", () => {
		withAgentDir(dir => {
			savePetSettings(dir, selectPet(settings({ name: "Toast", nameFollowsPet: false }), "toast"));
			const reloaded = loadPetSettings(dir).settings;
			expect(selectPet(reloaded, "miso").name).toBe("Toast");
			expect(reloaded.nameFollowsPet).toBe(false);
			expect(JSON.parse(readFileSync(join(dir, "fireside-pet.json"), "utf8")).nameFollowsPet).toBe(false);
		});
	});

	test("legacy intent is inferred once during parsing while explicit metadata stays authoritative", () => {
		for (const [input, follows] of [
			[{ pet: "miso", name: "Miso" }, true],
			[{ pet: "miso", name: "Toast" }, false],
			[{ pet: "custom", name: "Miso" }, false],
			[{ pet: "toast", name: "Toast", nameFollowsPet: false }, false],
		] as const) {
			expect(parsePetSettings(input).nameFollowsPet).toBe(follows);
		}
		const legacyNamed = parsePetSettings({ pet: "miso", name: "Toast" });
		expect(selectPet(selectPet(legacyNamed, "toast"), "pip").name).toBe("Toast");
		const following = parsePetSettings({ pet: "miso", name: "Miso" });
		expect(selectPet(selectPet(following, "custom"), "pip").name).toBe("Pip");
	});

	test("reading legacy preferences never eagerly rewrites the file", () => {
		withAgentDir(dir => {
			const file = join(dir, "fireside-pet.json");
			const legacy = JSON.stringify({ pet: "miso", name: "Toast", motion: "static" });
			writeFileSync(file, legacy);
			const loaded = loadPetSettings(dir).settings;
			expect(selectPet(selectPet(loaded, "toast"), "nori").name).toBe("Toast");
			expect(readFileSync(file, "utf8")).toBe(legacy);
			savePetSettings(dir, loaded);
			expect(JSON.parse(readFileSync(file, "utf8")).nameFollowsPet).toBe(false);
		});
	});

	test("invalid naming metadata is rejected instead of becoming a truthy default-follow flag", () => {
		for (const value of ["false", "true", 0, 1, null, {}]) {
			expect(() => parsePetSettings({ nameFollowsPet: value })).toThrow();
		}
	});
});
