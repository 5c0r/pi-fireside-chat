import { describe, expect, test } from "bun:test";
import type { PetSettings, PetSprite } from "./pet-data";
import { PetEngine, type PetClock } from "./pet-engine";
import { Feeder } from "./pet-food";

class FakeClock implements PetClock {
	private t = 0;
	private nextId = 1;
	readonly active = new Map<number, () => void>();
	now(): number { return this.t; }
	advance(ms: number): void { this.t += ms; }
	setInterval(fn: () => void): number {
		const id = this.nextId++;
		this.active.set(id, fn);
		return id;
	}
	clearInterval(handle: unknown): void {
		if (typeof handle === "number") this.active.delete(handle);
	}
	fire(times = 1): void {
		for (let i = 0; i < times; i++) for (const fn of [...this.active.values()]) fn();
	}
}

const BASE: PetSettings = {
	pet: "custom", name: "", nameFollowsPet: false, palette: "theme", size: "compact",
	speed: "normal", personality: "calm", placement: "main", motion: "animated",
	customFile: "", foodRain: true,
};
const settings = (o: Partial<PetSettings> = {}): PetSettings => ({ ...BASE, ...o });
const sprite: PetSprite = {
	id: "fixture", label: "Fixture",
	compact: { walking: [["[o> ]"], ["[o>>]"]], idle: [["[o_o]"], ["[-_-]"]], sleep: [["[-_]z"]] },
	full: {
		walking: [["  ^  ^ ", "[o>  ] ", " /   \\ "], ["  ^  ^ ", "[o-  ] ", "  | |  "]],
		idle: [["  ^  ^ ", "[o_o]  ", " /   \\ "], ["  ^  ^ ", "[-_-]  ", " /   \\ "]],
		sleep: [["       ", "[-_-]  ", " zzz   "]],
	},
};
const engine = (clock: FakeClock, o: Partial<PetSettings> = {}, feeder?: Feeder) =>
	new PetEngine(settings(o), sprite, clock, feeder);
const rowsText = (rows: string[]) => rows.join("\n");
const foodGlyphs = (rows: string[]) =>
	rows.join("").split("").filter(c => /[a-zA-Z0-9{}()]/.test(c)).length;

describe("engine food integration", () => {
	test("ingesting visible text drops bounded food into the full-size strip rows", () => {
		const clock = new FakeClock();
		const pet = engine(clock, { size: "full" });
		const off = pet.subscribe(() => { });
		try {
			pet.render(40, 3);
			expect(pet.feedDelta("function value() { return 42; }")).toBe(1);
			clock.advance(250); clock.fire();
			const rows = pet.render(40, 3);
			expect(rows).toHaveLength(3);
			expect(foodGlyphs(rows)).toBeGreaterThan(0);
			for (let i = 0; i < 30; i++) {
				clock.advance(250); clock.fire();
				const next = pet.render(40, 3);
				expect(next).toHaveLength(3);
				expect(next.every(row => row.length <= 40)).toBe(true);
			}
		} finally { off(); pet.dispose(); }
	});

	test("eleven rapid deltas never exceed ten visible pieces and skip bursts without backlog", () => {
		const clock = new FakeClock();
		const food = new Feeder(clock, () => 0.75);
		const pet = engine(clock, { size: "full" }, food);
		const off = pet.subscribe(() => { });
		try {
			pet.render(40, 3);
			let spawned = 0;
			for (let i = 0; i < 30; i++) {
				spawned += pet.feedDelta("abc def");
				clock.advance(50);
			}
			expect(spawned).toBe(3);
			// Do not tick while filling the cap: eating would free slots or start digestion.
			for (let i = 0; i < 12; i++) {
				clock.advance(520);
				spawned += pet.feedDelta("xy");
				expect(food.pieces(40, 3).length).toBeLessThanOrEqual(10);
				expect(pet.render(40, 3).every(row => row.length <= 40)).toBe(true);
			}
			expect(spawned).toBe(10);
			expect(food.pieces(40, 3)).toHaveLength(10);
			for (let i = 0; i < 6; i++) {
				clock.advance(600);
				expect(pet.feedDelta("zz")).toBe(0);
			}
			expect(food.pieces(40, 3)).toHaveLength(10);
		} finally { off(); pet.dispose(); }
	});

	test("landed food is chased, munched visibly, and five meals force a six-second digestion sleep", () => {
		const clock = new FakeClock();
		const food = new Feeder(clock, () => 0.75);
		const pet = engine(clock, { size: "full", speed: "slow" }, food);
		const off = pet.subscribe(() => { });
		try {
			pet.render(60, 3);
			let munched = false;
			for (let meal = 0; meal < 5; meal++) {
				clock.advance(600);
				expect(pet.feedDelta("q" + meal)).toBe(1);
				for (let i = 0; i < 100 && food.consumed() < meal + 1; i++) {
					clock.advance(100); clock.fire();
					if (/nom|~/.test(rowsText(pet.render(60, 3)))) munched = true;
				}
				expect(food.consumed()).toBe(meal + 1);
			}
			expect(munched).toBe(true);
			expect(food.phase()).toBe("satisfied");
			expect(rowsText(pet.render(60, 3))).not.toContain("zzz");
			for (let i = 0; i < 12; i++) { clock.advance(100); clock.fire(); }
			expect(food.phase()).toBe("digesting");
			// Stay inside the six-second nap; a 60-second meal loop would already have ended it.
			for (let i = 0; i < 20; i++) {
				pet.activity("reply");
				expect(rowsText(pet.render(60, 3))).toContain("zzz");
				clock.advance(150);
				expect(pet.feedDelta("zz")).toBe(0);
				clock.fire();
			}
			expect(food.pieces(60, 3)).toHaveLength(0);
			expect(rowsText(pet.render(60, 3))).toContain("zzz");
			clock.advance(2999); clock.fire();
			expect(food.phase()).toBe("digesting");
			clock.advance(1); clock.fire();
			expect(food.phase()).toBe("idle");
			expect(food.consumed()).toBe(0);
			expect(rowsText(pet.render(60, 3))).not.toContain("zzz");
		} finally { off(); pet.dispose(); }
	});

	for (const size of ["full", "compact"] as const) {
		test(`${size} leftovers keep exact floor cells through rest and are eaten after waking without new deltas`, () => {
			const clock = new FakeClock();
			let dropColumn = 16;
			const food = new Feeder(clock, () => dropColumn / 96);
			const pet = engine(clock, { size, speed: "slow", name: "Pip Pal" }, food);
			const height = size === "full" ? 3 : 1;
			const floorRow = height - 1;
			const petColumn = size === "full" ? 14 : 15;
			const spriteWidth = size === "full" ? 7 : 5;
			const sleepCells = size === "full"
				? ["       ", "[-_-]  ", " zzz   "] : ["[-_]z"];
			const leftovers = [
				{ id: 6, glyph: "oak", column: 56, row: floorRow, landed: true },
				{ id: 7, glyph: "elm", column: 68, row: floorRow, landed: true },
				{ id: 8, glyph: "sky", column: 78, row: floorRow, landed: true },
			];
			const off = pet.subscribe(() => { });
			try {
				pet.render(96, height);
				for (let meal = 0; meal < 5; meal++) {
					expect(pet.feedDelta("m" + meal + ";")).toBe(1);
					clock.advance(500);
				}
				dropColumn = 56;
				expect(pet.feedDelta("oak")).toBe(1);
				clock.advance(500);
				dropColumn = 68;
				expect(pet.feedDelta("elm")).toBe(1);
				for (let i = 0; i < 100 && food.consumed() < 4; i++) {
					clock.advance(100); clock.fire();
				}
				expect(food.consumed()).toBe(4);
				expect(food.phase()).toBe("munching");
				expect(food.targetId()).toBe(5);
				clock.advance(500); clock.fire();
				dropColumn = 78;
				expect(pet.feedDelta("sky")).toBe(1);
				clock.advance(200); clock.fire();
				expect(food.phase()).toBe("satisfied");
				expect(food.consumed()).toBe(5);
				expect(food.targetId()).toBeNull();
				expect(food.pieces(96, height)).toEqual([
					...leftovers.slice(0, 2),
					{ ...leftovers[2], row: 0, landed: size === "compact" },
				]);
				const satisfied = pet.render(96, height);
				expect(satisfied[floorRow].slice(56, 59)).toBe("oak");
				expect(satisfied[floorRow].slice(68, 71)).toBe("elm");
				expect(satisfied[0].slice(78, 81)).toBe("sky");
				expect(pet.feedDelta("skip")).toBe(0);
				clock.advance(150); clock.fire();
				expect(food.phase()).toBe("satisfied");
				expect(food.pieces(96, height)).toEqual([
					...leftovers.slice(0, 2),
					{ ...leftovers[2], row: size === "full" ? 1 : 0, landed: size === "compact" },
				]);
				expect(pet.render(96, height)[size === "full" ? 1 : 0].slice(78, 81)).toBe("sky");
				for (const [advance, phase] of [
					[350, "satisfied"], [699, "satisfied"],
					[1, "digesting"], [5999, "digesting"],
				] as const) {
					clock.advance(advance); clock.fire();
					if (advance === 1) pet.activity("typing");
					pet.activity("reply");
					expect(food.phase()).toBe(phase);
					expect(food.consumed()).toBe(5);
					expect(food.targetId()).toBeNull();
					expect(food.pieces(96, height)).toEqual(leftovers);
					expect(pet.feedDelta("skip")).toBe(0);
					const rows = pet.render(96, height);
					expect(rows[floorRow].slice(56, 59)).toBe("oak");
					expect(rows[floorRow].slice(68, 71)).toBe("elm");
					expect(rows[floorRow].slice(78, 81)).toBe("sky");
					expect(rows[floorRow].slice(petColumn + spriteWidth + 1, petColumn + spriteWidth + 8))
						.toBe("Pip Pal");
					const pose = rows.map(row => row.padEnd(96).slice(petColumn, petColumn + spriteWidth));
					if (phase === "digesting") expect(pose).toEqual(sleepCells);
					else expect(pose).not.toEqual(sleepCells);
				}
				clock.advance(1); clock.fire();
				expect(food.phase()).toBe("chasing");
				expect(food.targetId()).toBe(6);
				expect(food.consumed()).toBe(0);
				expect(food.pieces(96, height)).toEqual(leftovers);
				expect(pet.render(96, height).map(row => row.padEnd(96).slice(petColumn, petColumn + spriteWidth)))
					.not.toEqual(sleepCells);
				for (const [meal, remainingIds] of [[1, [7, 8]], [2, [8]], [3, []]] as const) {
					for (let i = 0; i < 100 && food.consumed() < meal; i++) {
						clock.advance(100); clock.fire();
					}
					expect(food.consumed()).toBe(meal);
					expect(food.pieces(96, height).map(piece => piece.id)).toEqual(remainingIds);
				}
			} finally { off(); pet.dispose(); }
		});
	}

	test("foodRain off and static motion stop sampling without touching saved speed", () => {
		const clock = new FakeClock();
		const food = new Feeder(clock, () => 0.75);
		const pet = engine(clock, { size: "full" }, food);
		const off = pet.subscribe(() => { });
		try {
			const original = pet.render(40, 3);
			pet.feedDelta("on");
			pet.update(settings({ size: "full", foodRain: false }), sprite);
			expect(pet.feedDelta("nope")).toBe(0);
			expect(food.pieces(40, 3)).toHaveLength(0);
			expect(pet.render(40, 3)).toEqual(original);
			pet.update(settings({ size: "full", foodRain: true, motion: "static" }), sprite);
			expect(pet.feedDelta("nope")).toBe(0);
			pet.update(settings({ size: "full", foodRain: true, motion: "animated" }), sprite);
			expect(pet.feedDelta("yes")).toBe(1);
		} finally { off(); pet.dispose(); }
	});

	test("typing pause stops the chase while food keeps falling; compact mode grounds treats in one row", () => {
		const clock = new FakeClock();
		const pet = engine(clock, { size: "full" });
		const off = pet.subscribe(() => { });
		try {
			pet.render(40, 3);
			pet.feedDelta("data");
			pet.activity("typing");
			const held = pet.render(40, 3);
			clock.advance(1000); clock.fire();
			const moved = pet.render(40, 3);
			expect(held).not.toEqual(moved);
			expect(foodGlyphs(moved)).toBeGreaterThan(0);
		} finally { off(); pet.dispose(); }
		const compactClock = new FakeClock();
		const compact = engine(compactClock, { size: "compact" });
		const off2 = compact.subscribe(() => { });
		try {
			compact.render(40, 1);
			expect(compact.feedDelta("hi")).toBe(1);
			compactClock.advance(1200); compactClock.fire();
			const row = compact.render(40, 1);
			expect(row).toHaveLength(1);
			expect(row[0].length).toBeLessThanOrEqual(40);
			expect(/[a-z]/.test(row[0])).toBe(true);
		} finally { off2(); compact.dispose(); }
	});

	test("preview rollback restores food, phase, counter, and shifted deadlines together", () => {
		const clock = new FakeClock();
		const pet = engine(clock, { size: "full" });
		const off = pet.subscribe(() => { });
		try {
			pet.render(40, 3);
			pet.feedDelta("keep");
			clock.advance(2000); clock.fire();
			const original = pet.render(40, 3);
			const rollback = pet.beginPreview();
			pet.feedDelta("extra");
			pet.update(settings({ size: "compact", foodRain: true }), sprite);
			clock.advance(4000); clock.fire();
			expect(pet.render(40, 1)).toHaveLength(1);
			rollback();
			expect(pet.render(40, 3)).toEqual(original);
		} finally { off(); pet.dispose(); }
	});

	test("narrow widths clamp food and chase never overflows the strip", () => {
		const clock = new FakeClock();
		const pet = engine(clock, { size: "full" });
		const off = pet.subscribe(() => { });
		try {
			pet.render(8, 3);
			pet.feedDelta("wide fragment");
			for (let i = 0; i < 200; i++) {
				clock.advance(100); clock.fire();
				const rows = pet.render(8, 3);
				expect(rows.every(row => row.length <= 8)).toBe(true);
			}
		} finally { off(); pet.dispose(); }
	});
});

describe("no visible surface feeding guard", () => {
	test("deltas are rejected with zero subscribers and feeding stops when the last surface detaches", () => {
		const clock = new FakeClock();
		const food = new Feeder(clock, () => 0.75);
		const pet = engine(clock, { size: "full", placement: "fireside" }, food);
		try {
			const baseline = pet.render(40, 3).join("\n");
			expect(pet.feedDelta("unseen")).toBe(0);
			const off = pet.subscribe(() => { });
			expect(pet.feedDelta("fresh")).toBe(1);
			expect(food.pieces(40, 3).length).toBe(1);
			off();
			expect(pet.feedDelta("hidden")).toBe(0);
			expect(food.pieces(40, 3)).toEqual([]);
			expect(pet.render(40, 3).join("\n")).toBe(baseline);
		} finally { pet.dispose(); }
	});
});

describe("zero-space surface feeding guard", () => {
	test("zero-row or zero-column renders clear feeding; a restored surface resumes sampling", () => {
		const clock = new FakeClock();
		const food = new Feeder(clock, () => 0.75);
		const pet = engine(clock, { size: "full", placement: "fireside" }, food);
		try {
			const off = pet.subscribe(() => { });
			pet.render(40, 3);
			expect(pet.feedDelta("live")).toBe(1);
			expect(food.pieces(40, 3).length).toBe(1);
			expect(pet.render(40, 0)).toEqual([]);
			expect(food.pieces(40, 3)).toEqual([]);
			clock.advance(600); clock.fire();
			expect(pet.feedDelta("gone")).toBe(0);
			clock.advance(600); clock.fire();
			const rows = pet.render(40, 3);
			expect(rows).toHaveLength(3);
			clock.advance(600);
			expect(pet.feedDelta("back")).toBe(1);
			expect(food.pieces(40, 3).length).toBe(1);
			expect(pet.render(0, 3)).toEqual([]);
			expect(food.pieces(40, 3)).toEqual([]);
			clock.advance(600); clock.fire();
			expect(pet.feedDelta("gone2")).toBe(0);
			off();
		} finally { pet.dispose(); }
	});
});

describe("review acceptance corrections", () => {
	for (const source of ["main", "fireside"] as const) {
		test(`${source} typing hold discards new food but preserves falling food and resumes at 1500ms`, () => {
			const clock = new FakeClock();
			const food = new Feeder(clock, () => 0.75);
			const pet = engine(clock, { size: "full", speed: "slow" }, food);
			const off = pet.subscribe(() => { });
			try {
				pet.render(80, 3);
				expect(pet.feedDelta("old", source)).toBe(1);
				pet.activity("typing");
				expect(pet.feedDelta("drop", source)).toBe(0);
				clock.advance(500); clock.fire();
				expect(food.pieces(80, 3)[0]).toMatchObject({ glyph: "old", row: 1, landed: false });
				expect(pet.feedDelta("drop", source)).toBe(0);
				clock.advance(999); clock.fire();
				expect(pet.feedDelta("drop", source)).toBe(0);
				expect(food.pieces(80, 3)).toHaveLength(1);
				expect(food.consumed()).toBe(0);
				clock.advance(1);
				expect(pet.feedDelta("new", source)).toBe(1);
				expect(food.pieces(80, 3).map(piece => piece.glyph)).toEqual(["old", "new"]);
				pet.update(settings({ size: "full", speed: "slow", foodRain: false }), sprite);
				const before = pet.render(80, 3)[1].indexOf("[");
				clock.advance(1000); clock.fire();
				expect(pet.render(80, 3)[1].indexOf("[") - before).toBe(3);
			} finally { off(); pet.dispose(); }
		});
	}

	test("source parsers stay independent while typing discards control syntax", () => {
		const clock = new FakeClock();
		const food = new Feeder(clock, () => 0);
		const pet = engine(clock, { size: "full" }, food);
		const off = pet.subscribe(() => { });
		try {
			pet.render(80, 3);
			pet.activity("typing");
			expect(pet.feedDelta("\x1b]52;c;", "main")).toBe(0);
			clock.advance(1500);
			expect(pet.feedDelta("SECRET", "main")).toBe(0);
			expect(pet.feedDelta("ok", "fireside")).toBe(1);
			clock.advance(500);
			expect(pet.feedDelta("\x1b", "main")).toBe(0);
			expect(pet.feedDelta("\\yes", "main")).toBe(1);
			expect(food.pieces(80, 3).map(piece => piece.glyph)).toEqual(["ok", "yes"]);
		} finally { off(); pet.dispose(); }
	});

	for (const source of ["main", "fireside"] as const) {
		const other = source === "main" ? "fireside" : "main";
		for (const change of ["prefix", "terminator", "reset"] as const) {
			test(`live parser preview Cancel preserves ${source} ${change} while restoring typing deadline`, () => {
				const clock = new FakeClock();
				const food = new Feeder(clock, () => 0);
				const pet = engine(clock, { size: "full" }, food);
				const off = pet.subscribe(() => { });
				try {
					pet.render(80, 3);
					pet.feedDelta("\x1b]52;c;", other);
					if (change !== "prefix") pet.feedDelta("\x1b]52;c;", source);
					pet.activity("typing");
					const rollback = pet.beginPreview();
					clock.advance(2000);
					if (change === "prefix") pet.feedDelta("\x1b]52;c;", source);
					else if (change === "terminator") pet.feedDelta("SECRET\x07", source);
					else pet.resetFeed(source);
					rollback();
					expect(pet.feedDelta("held", source)).toBe(0);
					expect(pet.feedDelta("held", other)).toBe(0);
					clock.advance(1500);
					if (change === "prefix") expect(pet.feedDelta("SECRET\x07", source)).toBe(0);
					expect(pet.feedDelta("ok", source)).toBe(1);
					clock.advance(500);
					expect(pet.feedDelta("SECRET", other)).toBe(0);
					expect(pet.feedDelta("\x07yes", other)).toBe(1);
					expect(food.pieces(80, 3).map(piece => piece.glyph)).toEqual(["ok", "yes"]);
				} finally { off(); pet.dispose(); }
			});
		}
	}

	for (const reverse of [false, true]) {
		test(`mixed compact/full views keep full fall timing with render order ${reverse}`, () => {
			const clock = new FakeClock();
			const food = new Feeder(clock, () => 0.75);
			const pet = engine(clock, { size: "full", placement: "both" }, food);
			const offMain = pet.subscribe(() => { }, "main");
			const offSide = pet.subscribe(() => { }, "fireside");
			const paint = () => {
				if (reverse) {
					pet.render(20, 1, "main");
					pet.render(80, 3, "fireside");
				} else {
					pet.render(80, 3, "fireside");
					pet.render(20, 1, "main");
				}
			};
			try {
				paint();
				expect(pet.feedDelta("abc")).toBe(1);
				clock.advance(250); clock.fire(); paint();
				expect(food.pieces(80, 3)[0]).toMatchObject({ column: 60, row: 0, landed: false });
				clock.advance(250); clock.fire(); paint();
				expect(food.pieces(80, 3)[0]).toMatchObject({ row: 1, landed: false });
				expect(food.targetId()).toBeNull();
				clock.advance(200); clock.fire(); paint();
				expect(food.pieces(80, 3)[0]?.landed).toBe(true);
				expect(food.targetId()).toBe(1);
				offSide();
				clock.advance(250); clock.fire();
				expect(food.pieces(20, 1)).toEqual([]);
				expect(pet.feedDelta("new")).toBe(1);
				expect(food.pieces(20, 1)[0]?.column).toBe(15);
			} finally { offMain(); offSide(); pet.dispose(); }
		});
	}

	test("a zero-row Fireside view cannot erase a drawable main view", () => {
		const clock = new FakeClock();
		const food = new Feeder(clock, () => 0.75);
		const pet = engine(clock, { size: "full", placement: "both" }, food);
		const offMain = pet.subscribe(() => { }, "main");
		const offSide = pet.subscribe(() => { }, "fireside");
		try {
			pet.render(80, 3, "main");
			pet.render(40, 3, "fireside");
			expect(pet.feedDelta("old")).toBe(1);
			expect(pet.render(40, 0, "fireside")).toEqual([]);
			clock.advance(500); clock.fire();
			expect(food.pieces(80, 3)[0]).toMatchObject({ glyph: "old", row: 1 });
			expect(pet.feedDelta("new", "fireside")).toBe(1);
			offMain();
			for (let i = 0; i < 4; i++) {
				clock.advance(600); clock.fire();
				expect(pet.feedDelta("no", "fireside")).toBe(0);
				expect(food.pieces(80, 3)).toEqual([]);
				expect(food.consumed()).toBe(0);
			}
			pet.render(40, 3, "fireside");
			expect(pet.feedDelta("yes", "fireside")).toBe(1);
			clock.advance(1000); clock.fire();
			expect(food.pieces(40, 3)[0]?.landed).toBe(true);
			expect(pet.render(40, 3, "fireside")[1].indexOf("[")).toBeGreaterThan(0);
		} finally { offMain(); offSide(); pet.dispose(); }
	});
});
