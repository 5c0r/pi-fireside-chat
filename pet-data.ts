import {
	closeSync,
	constants,
	fstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type BuiltinPetId = keyof typeof BUILTIN_PETS;
export type PetId = BuiltinPetId | "custom";

export const PET_COLORS = {
	amber: "235;190;105",
	mint: "125;211;170",
	rose: "236;159;180",
	sky: "140;195;235",
	lavender: "191;173;234",
} as const;
export type PetPalette = "theme" | keyof typeof PET_COLORS;
const PET_COLOR_IDS = Object.keys(PET_COLORS) as Array<keyof typeof PET_COLORS>;
export const PET_PALETTES: readonly PetPalette[] = ["theme", ...PET_COLOR_IDS];

export interface PetSettings {
	pet: PetId;
	name: string;
	nameFollowsPet: boolean;
	palette: PetPalette;
	size: "compact" | "full";
	speed: "slow" | "normal" | "fast";
	personality: "calm" | "playful" | "sleepy";
	placement: "main" | "fireside" | "both";
	motion: "animated" | "static" | "hidden";
	foodRain: boolean;
	customFile: string;
}

export interface SpriteFrames {
	walking: string[][];
	idle: string[][];
	sleep: string[][];
}

export interface PetSprite {
	id: string;
	label: string;
	compact: SpriteFrames;
	full: SpriteFrames;
}

export const DEFAULT_PET_SETTINGS: Readonly<PetSettings> = Object.freeze({
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
});

const SETTINGS_FILE = "fireside-pet.json";
const MAX_CUSTOM_BYTES = 64 * 1024;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const SPRITE_MODES = ["walking", "idle", "sleep"] as const;

/** Error text is untrusted terminal data, even when it comes from JSON.parse or the filesystem. */
export function formatPetError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, char => {
		const code = char.codePointAt(0)!;
		return code <= 0xffff ? `\\u${code.toString(16).padStart(4, "0")}` : `\\u{${code.toString(16)}}`;
	});
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${field} must be an object`);
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new Error(`${field} must be a plain object`);
	}
	return value as Record<string, unknown>;
}

function safeText(value: unknown, field: string, maxLength: number): string {
	if (typeof value !== "string") throw new Error(`${field} must be a string`);
	if (UNSAFE_TEXT.test(value)) throw new Error(`${field} must not contain control or invisible formatting characters`);
	const text = value.trim();
	let length = 0;
	for (const _ of text) {
		length++;
		if (length > maxLength) throw new Error(`${field} must be at most ${maxLength} characters`);
	}
	if (length === 0) throw new Error(`${field} must not be empty`);
	return text;
}

function enumSetting<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
	if (typeof value !== "string" || !allowed.includes(value as T)) {
		throw new Error(`${field} must be one of: ${allowed.join(", ")}`);
	}
	return value as T;
}

export function parsePetSettings(value: unknown): PetSettings {
	if (value === undefined || value === null) return { ...DEFAULT_PET_SETTINGS };
	const fields = requireObject(value, "Pet settings");
	const defaults = DEFAULT_PET_SETTINGS;
	const customFile = fields.customFile === undefined ? defaults.customFile : fields.customFile;
	if (typeof customFile !== "string") throw new Error("customFile must be a string");
	if (UNSAFE_TEXT.test(customFile) || customFile.length > 4096) {
		throw new Error("customFile must be at most 4096 characters without control or invisible formatting characters");
	}
	const pet = enumSetting(fields.pet === undefined ? defaults.pet : fields.pet, PET_IDS, "pet");
	const name = safeText(fields.name === undefined ? defaults.name : fields.name, "name", 24);
	const nameFollowsPet = fields.nameFollowsPet;
	if (nameFollowsPet !== undefined && typeof nameFollowsPet !== "boolean") {
		throw new Error("nameFollowsPet must be a boolean");
	}
	const foodRain = fields.foodRain === undefined ? defaults.foodRain : fields.foodRain;
	if (typeof foodRain !== "boolean") throw new Error("foodRain must be a boolean");
	return {
		pet,
		name,
		// Infer old files once at the reader boundary; selections preserve this intent thereafter.
		nameFollowsPet: nameFollowsPet ?? (pet !== "custom" && name === BUILTIN_PETS[pet].label),
		palette: enumSetting(fields.palette === undefined ? defaults.palette : fields.palette, PET_PALETTES, "palette"),
		size: enumSetting(fields.size === undefined ? defaults.size : fields.size, ["compact", "full"], "size"),
		speed: enumSetting(fields.speed === undefined ? defaults.speed : fields.speed, ["slow", "normal", "fast"], "speed"),
		personality: enumSetting(fields.personality === undefined ? defaults.personality : fields.personality, ["calm", "playful", "sleepy"], "personality"),
		placement: enumSetting(fields.placement === undefined ? defaults.placement : fields.placement, ["main", "fireside", "both"], "placement"),
		motion: enumSetting(fields.motion === undefined ? defaults.motion : fields.motion, ["animated", "static", "hidden"], "motion"),
		foodRain,
		customFile,
	};
}

function parseSpriteFrames(value: unknown, height: number, field: string): SpriteFrames {
	const source = requireObject(value, field);
	const result: SpriteFrames = { walking: [], idle: [], sleep: [] };
	for (const mode of SPRITE_MODES) {
		const frames = source[mode];
		const path = `${field}.${mode}`;
		if (!Array.isArray(frames) || frames.length < 1 || frames.length > 8) {
			throw new Error(`${path} must contain 1..8 frames`);
		}
		let width = 0;
		const normalized: string[][] = [];
		for (let index = 0; index < frames.length; index++) {
			const frame: unknown = frames[index];
			if (!Array.isArray(frame) || frame.length !== height) {
				throw new Error(`${path}[${index}] must contain exactly ${height} ${height === 1 ? "row" : "rows"}`);
			}
			const rows: string[] = [];
			let visible = false;
			for (const row of frame) {
				if (typeof row !== "string" || /[^\x20-\x7e]/.test(row)) {
					throw new Error(`${path}[${index}] rows must contain printable ASCII only (space through tilde)`);
				}
				if (row.length > 32) throw new Error(`${path}[${index}] rows must be at most 32 columns`);
				const trimmed = row.trimEnd();
				if (trimmed.length > 0) visible = true;
				width = Math.max(width, trimmed.length);
				rows.push(trimmed);
			}
			if (!visible) throw new Error(`${path}[${index}] must contain visible sprite content`);
			normalized.push(rows);
		}
		for (const frame of normalized) {
			for (let row = 0; row < frame.length; row++) frame[row] = frame[row].padEnd(width, " ");
		}
		result[mode] = normalized;
	}
	return result;
}

export function parseCustomSprite(value: unknown): PetSprite {
	const source = requireObject(value, "Custom sprite");
	if (source.version !== 1) throw new Error("Custom sprite version must be 1");
	return {
		id: "custom",
		label: safeText(source.label, "label", 32),
		compact: parseSpriteFrames(source.compact, 1, "compact"),
		full: parseSpriteFrames(source.full, 3, "full"),
	};
}

function builtin(id: string, label: string, compact: SpriteFrames, full: SpriteFrames): PetSprite {
	return {
		id,
		label,
		compact: parseSpriteFrames(compact, 1, `${id}.compact`),
		full: parseSpriteFrames(full, 3, `${id}.full`),
	};
}

export const BUILTIN_PETS = {
	miso: builtin("miso", "Miso", {
		walking: [["=^.^=/>"], ["=^.^=\\>"]],
		idle: [["=^.^=~"], ["=^-^=~"]],
		sleep: [["=u.u=z"], ["=u.u=zZ"]],
	}, {
		walking: [
			[" /\\_/\\", "( o.o )~", " /| |\\"],
			[" /\\_/\\", "( o.o )~", " \\| |/"],
		],
		idle: [
			[" /\\_/\\", "( o.o )", " (___)~"],
			[" /\\_/\\", "( -.- )", " (___)~"],
		],
		sleep: [
			["      z", " /\\_/\\", "( -.- )~"],
			["     zZ", " /\\_/\\", "( -.- )~"],
		],
	}),
	toast: builtin("toast", "Toast", {
		walking: [["U(o w)/u~"], ["U(o w)u\\~"]],
		idle: [["U(o w)U~"], ["U(- w)U^"]],
		sleep: [["U(-w-)Uz"], ["U(-w-)UzZ"]],
	}, {
		walking: [
			[" /\\_/\\____", "( o w )___)~", "  /  \\ /  \\"],
			[" /\\_/\\____", "( o w )___)~", "  \\  / \\  /"],
		],
		idle: [
			[" /\\_/\\____", "( o w )___)~", "  u  u  u"],
			[" /\\_/\\____", "( - w )___)^", "  u  u  u"],
		],
		sleep: [
			["          z", "  /\\_/\\___", " ( -w- )___)~"],
			["         zZ", "  /\\_/\\___", " ( -w- )___)~"],
		],
	}),
	mochi: builtin("mochi", "Mochi", {
		walking: [["(o_o)~"], ["~(o_o)"]],
		idle: [["(o.o)"], ["(_o_o_)"]],
		sleep: [["(-.-)z"], ["(-.-)zZ"]],
	}, {
		walking: [
			["   ___", " _/o o\\_", "(___u___)"],
			["   ___", " _/o o\\_", "(__u____)"],
		],
		idle: [
			["   ___", "  /o o\\", " (_____)"],
			["", "  _o_o_", " (_____)"],
		],
		sleep: [
			["       z", "  _____", " (_-_-_)"],
			["      zZ", "  _____", " (_-_-_)"],
		],
	}),
	ember: builtin("ember", "Ember", {
		walking: [["~(o)>/\\"], ["~(o)>\\/"]],
		idle: [["~(o)>^"], ["~(-)>v"]],
		sleep: [["~(-)>z"], ["~(-)>zZ"]],
	}, {
		walking: [
			["  /\\ /\\", "~(o >)\\_", "  / \\"],
			["  /\\ /\\", "~(o >)\\_", "  \\ /"],
		],
		idle: [
			["  /\\_/\\", "~(o >)  \\", "  (___)/"],
			["  __ __", "~(- >)\\/", "  (___)/"],
		],
		sleep: [
			["       z", "  /^__", "~(- >)_)"],
			["      zZ", "  /^__", "~(- >)_)"],
		],
	}),
	pip: builtin("pip", "Pip", {
		walking: [["(\\(^.^)/>"], ["(\\(^.^)\\>"]],
		idle: [["(\\(o.o)~"], ["(/(-.-)~"]],
		sleep: [["(_(-.-)z"], ["(_(-.-)zZ"]],
	}, {
		walking: [
			[" (\\ (\\", "( o.o )o", "  > >"],
			[" (\\ (\\", " (o.o )o", " /  \\"],
		],
		idle: [
			[" (\\ (\\", "( o.o )o", " (___)"],
			[" (\\ /)", "( -.- )o", " (___)"],
		],
		sleep: [
			["  __   z", " ( -.-)o", " (____)"],
			["  __  zZ", " ( -.-)o", "  (___)"],
		],
	}),
	soba: builtin("soba", "Soba", {
		walking: [["^<o.o>/~~"], ["^<o.o>\\~~"]],
		idle: [["^<o.o>~~^"], ["^<-.->~^~"]],
		sleep: [["<(-.-)@z"], ["<(-.-)@zZ"]],
	}, {
		walking: [
			[" /\\_/\\", "< o.o >___/^^", " /  \\ /  \\"],
			[" /\\_/\\", "< o.o >___\\^^", " \\  / \\  /"],
		],
		idle: [
			[" /\\_/\\  /^^", "< o.o >_)", "  u  u"],
			[" /\\_/\\", "< -.- >_)\\^^", "  u  u"],
		],
		sleep: [
			["      z", " /\\__", "< -.-)@)"],
			["     zZ", " /\\__", "< -.-)_@)"],
		],
	}),
	pebble: builtin("pebble", "Pebble", {
		walking: [["n( ._.)_/>"], ["n( ._.)_\\>"]],
		idle: [["n( ._.)__"], ["n( -_.)__"]],
		sleep: [["n(-.-)___z"], ["n(-.-)___zZ"]],
	}, {
		walking: [
			[" n_n______", "( ._      )", " /  /  / /"],
			[" n_n______", "( ._      )", " \\  \\  \\ \\"],
		],
		idle: [
			[" n_n______", "( ._      )", " (________)"],
			[" n_n______", "( -_      )", " (________)"],
		],
		sleep: [
			[" n_n     z", "( -_ _____)", " (________)"],
			[" n_n    zZ", "( -- _____)", " (________)"],
		],
	}),
	waddles: builtin("waddles", "Waddles", {
		walking: [["\\(o>)_/"], ["/(o>)_\\"]],
		idle: [["\\(o>)/"], ["|(->)|"]],
		sleep: [["(u>)_z"], ["(u>)__zZ"]],
	}, {
		walking: [
			["   _", " /(o>)", "  (_)/"],
			["  _", " (o>)\\", " \\(_)"],
		],
		idle: [
			["  _", " (o>)", "/(_)\\"],
			["  _", " (->)", "|(_)|"],
		],
		sleep: [
			["     z", "  _", " (u_>)"],
			["    zZ", "  _", " (u__>)"],
		],
	}),
	sprout: builtin("sprout", "Sprout", {
		walking: [["~/(==)\\o"], ["~\\(==)/o"]],
		idle: [["~(==)o"], ["~(==)."]],
		sleep: [["(====)z"], ["(====)zZ"]],
	}, {
		walking: [
			["   ___", " _/===\\_o", " /     \\"],
			["   ___", " _/===\\_o", " \\     /"],
		],
		idle: [
			["   ___", " _/===\\_o", "  u   u"],
			["   ___", " _/===\\_.", "  u   u"],
		],
		sleep: [
			["       z", "  /===\\", " (_____)"],
			["      zZ", " _/===\\_", " (_____)"],
		],
	}),
	nori: builtin("nori", "Nori", {
		walking: [["}(o.o){/~"], ["}(o.o){\\~"]],
		idle: [["}(o.o){~"], ["=(o.o)=~"]],
		sleep: [["}(-.-)@z"], ["}(-.-)@zZ"]],
	}, {
		walking: [
			[" \\ | /", "}(o.o){___~", "  /  /"],
			[" \\ | /", "}(o.o){___~", "  \\  \\"],
		],
		idle: [
			[" \\ | /", "}(o.o){__~", "  u  u"],
			["  /|\\", "=(o.o)=__~", "  u  u"],
		],
		sleep: [
			["       z", " }(-.-){", "  (__@)"],
			["      zZ", " =(-.-)=", "  (__@)"],
		],
	}),
};

export const BUILTIN_PET_IDS: readonly BuiltinPetId[] = Object.keys(BUILTIN_PETS) as BuiltinPetId[];
export const PET_IDS: readonly PetId[] = [...BUILTIN_PET_IDS, "custom"];

export function selectPet(settings: PetSettings, pet: PetId): PetSettings {
	return {
		...settings,
		pet,
		name: settings.nameFollowsPet && pet !== "custom" ? BUILTIN_PETS[pet].label : settings.name,
	};
}

export function randomizePetSettings(
	settings: PetSettings,
	action: "pet" | "color" | "both",
	random: () => number = Math.random,
): PetSettings {
	let chosen: PetSettings;
	if (action === "pet" || action === "both") {
		const candidates = BUILTIN_PET_IDS.filter(id => id !== settings.pet);
		chosen = selectPet(settings, candidates[Math.floor(random() * candidates.length)]);
	} else {
		chosen = { ...settings };
	}
	if (action === "color" || action === "both") {
		const candidates = PET_COLOR_IDS.filter(palette => palette !== settings.palette);
		chosen.palette = candidates[Math.floor(random() * candidates.length)];
	}
	return chosen;
}

export function loadPetSettings(agentDir: string): { settings: PetSettings; error?: string } {
	try {
		const value: unknown = JSON.parse(readFileSync(join(agentDir, SETTINGS_FILE), "utf8"));
		requireObject(value, "Persisted pet settings");
		return { settings: parsePetSettings(value) };
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return { settings: parsePetSettings(undefined) };
		}
		return {
			settings: parsePetSettings(undefined),
			error: `Could not load pet settings: ${formatPetError(error)}`,
		};
	}
}

export function savePetSettings(agentDir: string, settings: PetSettings): void {
	const validated = parsePetSettings(settings);
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	const temporaryDir = mkdtempSync(join(agentDir, ".fireside-pet-"));
	try {
		const temporaryFile = join(temporaryDir, SETTINGS_FILE);
		writeFileSync(temporaryFile, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		renameSync(temporaryFile, join(agentDir, SETTINGS_FILE));
	} finally {
		rmSync(temporaryDir, { recursive: true, force: true });
	}
}

export function resolvePetSprite(settings: PetSettings): { sprite: PetSprite; error?: string } {
	if (settings.pet !== "custom") return { sprite: BUILTIN_PETS[settings.pet] };
	try {
		if (settings.customFile.trim().length === 0) throw new Error("Choose a local custom sprite JSON file first");
		// Nonblocking open also makes special files safe to reject before any read.
		const fd = openSync(settings.customFile, constants.O_RDONLY | constants.O_NONBLOCK);
		try {
			const stat = fstatSync(fd);
			if (!stat.isFile()) throw new Error("Custom sprite must be a regular local JSON file");
			if (stat.size > MAX_CUSTOM_BYTES) throw new Error("Custom sprite file must be at most 64 KiB");
			// Read one extra byte to catch files that grow after fstat, without an unbounded read.
			const bytes = new Uint8Array(MAX_CUSTOM_BYTES + 1);
			let length = 0;
			while (length < bytes.length) {
				const count = readSync(fd, bytes, length, bytes.length - length, null);
				if (count === 0) break;
				length += count;
			}
			if (length > MAX_CUSTOM_BYTES) throw new Error("Custom sprite file must be at most 64 KiB");
			const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
			return { sprite: parseCustomSprite(JSON.parse(json)) };
		} finally {
			closeSync(fd);
		}
	} catch (error) {
		return {
			sprite: BUILTIN_PETS.miso,
			error: `Could not load custom sprite: ${formatPetError(error)}`,
		};
	}
}
