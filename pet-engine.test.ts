import { describe, expect, test } from "bun:test";
import type { PetSettings, PetSprite } from "./pet-data";
import { PetEngine, type PetClock } from "./pet-engine";

/**
 * Deterministic behavioral tests for PetEngine.
 *
 * All timing is driven through FakeClock (injected PetClock): tests advance
 * the fake wall time and fire interval callbacks manually. No real timers,
 * no randomness, no walltime dependence.
 *
 * Fixtures are handcrafted sprites; the pet-data runtime is never imported.
 */

class FakeClock implements PetClock {
 private t = 0;
 private nextId = 1;
 readonly active = new Map<number, () => void>();
 lastFn: (() => void) | null = null;
 intervalCalls = 0;
 clearCalls = 0;

 now(): number {
  return this.t;
 }
 advance(ms: number): void {
  this.t += ms;
 }
 setInterval(fn: () => void, _ms: number): number {
  const id = this.nextId++;
  this.active.set(id, fn);
  this.lastFn = fn;
  this.intervalCalls++;
  return id;
 }
 clearInterval(handle: unknown): void {
  if (typeof handle === "number") this.active.delete(handle);
  this.clearCalls++;
 }
 /** Fire every currently-active interval callback `times` times. */
 fire(times = 1): void {
  for (let i = 0; i < times; i++) {
   for (const fn of [...this.active.values()]) fn();
  }
 }
}

const BASE: PetSettings = {
 pet: "custom",
 name: "",
 nameFollowsPet: false,
 palette: "theme",
 size: "compact",
 speed: "normal",
 personality: "calm",
 placement: "main",
 motion: "animated",
 foodRain: false,
 customFile: "",
};

function settings(o: Partial<PetSettings> = {}): PetSettings {
 return { ...BASE, ...o };
}

/** Compact rows are 5 cols; full rows are 7 cols. */
function makeSprite(): PetSprite {
 return {
  id: "fixture",
  label: "Fixture",
  compact: {
   walking: [["[o> ]"], ["[o>>]"]],
   idle: [["[o_o]"], ["[-_-]"]],
   sleep: [["[-_]z"]],
  },
  full: {
   walking: [
    ["  ^  ^ ", "[o>  ] ", " /   \\ "],
    ["  ^  ^ ", "[o-  ] ", "  | |  "],
   ],
   idle: [
    ["  ^  ^ ", "[o_o]  ", " /   \\ "],
    ["  ^  ^ ", "[-_-]  ", " /   \\ "],
   ],
   sleep: [["       ", "[-_-]  ", " zzz   "]],
  },
 };
}

function makeEngine(
 clock: FakeClock,
 o: Partial<PetSettings> = {},
 sprite: PetSprite = makeSprite(),
): PetEngine {
 return new PetEngine(settings(o), sprite, clock);
}

/** Leading-space column offset of the pet in the first nonempty row. */
function padding(rows: string[]): number {
 const row = rows.find((r) => r.length > 0) ?? "";
 return /^ */.exec(row)![0].length;
}
const isSleeping = (rows: string[]) => rows.some((r) => r.includes("z"));
const isWalkingDir = (rows: string[]) =>
 rows.some((r) => r.includes(">") || r.includes("<"));
const isSitting = (rows: string[]) =>
 !isSleeping(rows) && rows.some((r) => r.includes("o_o") || r.includes("-_-"));

const TICK = 250;

describe("PetEngine lazy rendering", () => {
 test("no timer before first subscriber even while animated", () => {
  const clock = new FakeClock();
  const engine = makeEngine(clock);
  engine.render(40);
  engine.activity("typing");
  engine.render(40);
  expect(clock.intervalCalls).toBe(0);
  engine.dispose();
 });

 test("render never advances animation from wall time alone", () => {
  const clock = new FakeClock();
  const engine = makeEngine(clock);
  const before = engine.render(40);
  clock.advance(60_000);
  expect(engine.render(40)).toEqual(before);
  expect(clock.intervalCalls).toBe(0);
 });
});

describe("lazy single timer across subscribers", () => {
 test("one interval for many subscribers; every subscriber redrawn", () => {
  const clock = new FakeClock();
  const engine = makeEngine(clock);
  let a = 0;
  let b = 0;
  let c = 0;
  engine.subscribe(() => a++);
  engine.subscribe(() => b++);
  engine.subscribe(() => c++);
  expect(clock.intervalCalls).toBe(1);
  expect(clock.active.size).toBe(1);
  clock.advance(TICK);
  clock.fire();
  expect(a).toBeGreaterThanOrEqual(1);
  expect(b).toBeGreaterThanOrEqual(1);
  expect(c).toBeGreaterThanOrEqual(1);
  engine.dispose();
 });

 test("last unsubscribe stops the timer and further fires do nothing", () => {
  const clock = new FakeClock();
  const engine = makeEngine(clock);
  let redraws = 0;
  const off1 = engine.subscribe(() => redraws++);
  const off2 = engine.subscribe(() => redraws++);
  expect(clock.intervalCalls).toBe(1);
  off1();
  expect(clock.active.size).toBe(1);
  const before = redraws;
  clock.advance(TICK);
  clock.fire();
  expect(redraws).toBeGreaterThan(before);
  off2();
  expect(clock.active.size).toBe(0);
  expect(clock.clearCalls).toBeGreaterThanOrEqual(1);
  const before2 = redraws;
  clock.advance(TICK);
  clock.fire();
  expect(redraws).toBe(before2);
  engine.dispose();
 });

 test("unsubscribe is idempotent and resubscribe reuses a single timer", () => {
  const clock = new FakeClock();
  const engine = makeEngine(clock);
  const off = engine.subscribe(() => { });
  off();
  off();
  expect(clock.active.size).toBe(0);
  engine.subscribe(() => { });
  expect(clock.intervalCalls).toBe(2);
  expect(clock.active.size).toBe(1);
  engine.dispose();
 });

 test("old interval cannot rejoin a later subscription", () => {
  const clock = new FakeClock();
  const engine = makeEngine(clock);
  const off = engine.subscribe(() => { });
  const oldTick = clock.lastFn!;
  off();
  let redraws = 0;
  engine.subscribe(() => redraws++);
  const before = engine.render(80);
  clock.advance(TICK);
  oldTick();
  expect(engine.render(80)).toEqual(before);
  expect(redraws).toBe(0);
  clock.fire();
  expect(engine.render(80)).not.toEqual(before);
  expect(redraws).toBe(1);
  engine.dispose();
 });
});

describe("dispose is permanent", () => {
 test("dispose clears timer; stale captured callback never redraws again", () => {
  const clock = new FakeClock();
  const engine = makeEngine(clock);
  let redraws = 0;
  engine.subscribe(() => redraws++);
  const captured = clock.lastFn!;
  expect(captured).toBeTruthy();
  engine.dispose();
  expect(clock.active.size).toBe(0);
  const before = redraws;
  clock.advance(TICK);
  captured();
  clock.fire();
  expect(redraws).toBe(before);
 });

 test("repeated dispose is safe and nothing can revive callbacks", () => {
  const clock = new FakeClock();
  const engine = makeEngine(clock);
  const off = engine.subscribe(() => { });
  const captured = clock.lastFn!;
  engine.dispose();
  engine.dispose();
  off();
  // Even new subscriptions on a disposed engine must not create timers.
  const off2 = engine.subscribe(() => { });
  off2();
  engine.update(settings({ motion: "animated" }), makeSprite());
  engine.activity("reply");
  expect(clock.active.size).toBe(0);
  const intervalsAfterDispose = clock.intervalCalls;
  clock.advance(TICK);
  captured();
  expect(clock.intervalCalls).toBe(intervalsAfterDispose);
  expect(clock.active.size).toBe(0);
 });
});

describe("motion setting changes", () => {
 test("static mode: zero timers, stationary awake idle rows", () => {
  const clock = new FakeClock();
  const engine = makeEngine(clock, { motion: "static" });
  engine.subscribe(() => { });
  expect(clock.intervalCalls).toBe(0);
  const first = engine.render(40);
  expect(isSitting(first)).toBe(true);
  clock.advance(4000);
  const later = engine.render(40);
  expect(later).toEqual(first);
 });

 test("static never falls asleep", () => {
  const clock = new FakeClock();
  const engine = makeEngine(clock, { motion: "static", personality: "sleepy" });
  engine.subscribe(() => { });
  clock.advance(60_000);
  clock.fire(1); // no timer exists; fire is a no-op
  expect(isSleeping(engine.render(40))).toBe(false);
 });

 test("hidden mode: empty rows and zero timers", () => {
  const clock = new FakeClock();
  const engine = makeEngine(clock, { motion: "hidden" });
  engine.subscribe(() => { });
  expect(clock.intervalCalls).toBe(0);
  expect(engine.render(40)).toEqual([]);
  expect(engine.render(0)).toEqual([]);
 });

 test("update animated->hidden stops timer and hides; hidden->animated restarts one", () => {
  const clock = new FakeClock();
  const engine = makeEngine(clock);
  engine.subscribe(() => { });
  expect(clock.intervalCalls).toBe(1);
  engine.update(settings({ motion: "hidden" }), makeSprite());
  expect(clock.active.size).toBe(0);
  expect(engine.render(40)).toEqual([]);
  engine.update(settings({ motion: "animated" }), makeSprite());
  expect(clock.active.size).toBe(1);
  expect(clock.intervalCalls).toBe(2);
 });

 test("update animated->static stops timer; rows stationary", () => {
  const clock = new FakeClock();
  const engine = makeEngine(clock);
  engine.subscribe(() => { });
  clock.advance(TICK);
  clock.fire(3);
  engine.update(settings({ motion: "static" }), makeSprite());
  expect(clock.active.size).toBe(0);
  const a = engine.render(40);
  clock.advance(TICK);
  clock.fire(2);
  const b = engine.render(40);
  expect(a).toEqual(b);
  expect(isSitting(a)).toBe(true);
 });

 test("update keeps pet state across settings change (name/sprite/size)", () => {
  const clock = new FakeClock();
  const engine = makeEngine(clock);
  engine.subscribe(() => { });
  const sprite2 = makeSprite();
  sprite2.compact = {
   walking: [["[X> ]"], ["[X>>]"]],
   idle: [["[X_X]"], ["[-X-]"]],
   sleep: [["[-X]z"]],
  };
  engine.update(settings({ name: "Rex" }), sprite2);
  const rows = engine.render(40);
  expect(rows.some((r) => r.includes("X"))).toBe(true);
  expect(rows.some((r) => r.includes("Rex"))).toBe(true);
  engine.update(settings({ size: "full" }), makeSprite());
  expect(engine.render(40).length).toBe(3);
 });

 test("settings update redraws even a static subscribed pet", () => {
  const clock = new FakeClock();
  const engine = makeEngine(clock, { motion: "static" });
  let redraws = 0;
  engine.subscribe(() => redraws++);
  engine.update(settings({ motion: "static", name: "Rex" }), makeSprite());
  expect(redraws).toBe(1);
  expect(engine.render(40)[0]).toContain("Rex");
  expect(clock.intervalCalls).toBe(0);
 });
});

describe("movement, edges, mirroring", () => {
 test("pet walks and turns at the right edge without overflow", () => {
  const clock = new FakeClock();
  const engine = makeEngine(clock); // compact, width 5 sprite
  engine.subscribe(() => { });
  const width = 20;
  const bound = width - 5;
  const paddings: number[] = [];
  let sawLeft = false;
  for (let i = 0; i < 60; i++) {
   clock.advance(TICK);
   clock.fire();
   const rows = engine.render(width);
   for (const r of rows) expect(r.length).toBeLessThanOrEqual(width);
   const p = padding(rows);
   expect(p).toBeLessThanOrEqual(bound);
   paddings.push(p);
   if (rows.some((r) => r.includes("<"))) sawLeft = true;
  }
  // walked right at some point
  expect(Math.max(...paddings)).toBeGreaterThan(0);
  // eventually reached the edge
  expect(Math.max(...paddings)).toBe(bound);
  // and turned back (position decreased after the max)
  const maxIdx = paddings.indexOf(Math.max(...paddings));
  expect(paddings.length - 1).toBeGreaterThan(maxIdx);
  expect(Math.min(...paddings.slice(maxIdx))).toBeLessThan(bound);
  // facing-left mirror glyph appeared after turning
  expect(sawLeft).toBe(true);
 });

 test("walking left renders mirrored directional glyph safely", () => {
  const clock = new FakeClock();
  const engine = makeEngine(clock);
  engine.subscribe(() => { });
  engine.render(8);
  let sawLeft = false;
  // small width forces a quick turn
  for (let i = 0; i < 30; i++) {
   clock.advance(TICK);
   clock.fire();
   const rows = engine.render(8);
   if (rows.some((r) => r.includes("<"))) {
    sawLeft = true;
    expect(rows.some((r) => r.includes(">"))).toBe(false);
    expect(rows[0].trimStart()).toMatch(/^\[ ?<{1,2}o\]$/);
   }
   for (const r of rows) {
    expect(r.length).toBeLessThanOrEqual(8);
    // mirror never fabricates control characters
    for (const ch of r) expect(ch.charCodeAt(0)).toBeGreaterThanOrEqual(0x20);
   }
  }
  expect(sawLeft).toBe(true);
 });

 test("resize clamps position: no overflow after shrinking width", () => {
  const clock = new FakeClock();
  const engine = makeEngine(clock);
  engine.subscribe(() => { });
  engine.render(80);
  for (let i = 0; i < 8; i++) {
   clock.advance(TICK);
   clock.fire();
  }
  const wide = engine.render(80);
  expect(padding(wide)).toBeGreaterThan(0);
  const narrow = engine.render(12);
  for (const r of narrow) expect(r.length).toBeLessThanOrEqual(12);
  expect(padding(narrow)).toBeLessThanOrEqual(12 - 5);
  for (let i = 0; i < 20; i++) {
   clock.advance(TICK);
   clock.fire();
   for (const r of engine.render(12)) expect(r.length).toBeLessThanOrEqual(12);
  }
 });

 test("width 0 and tiny widths never overflow", () => {
  const clock = new FakeClock();
  const engine = makeEngine(clock);
  engine.subscribe(() => { });
  clock.advance(TICK);
  clock.fire();
  expect(engine.render(0)).toEqual([]);
  for (const w of [1, 2, 3, 5, 9]) {
   for (const r of engine.render(w)) expect(r.length).toBeLessThanOrEqual(w);
  }
 });
});

describe("speed and personality", () => {
 test("fast outruns slow over identical elapsed time", () => {
  const clockA = new FakeClock();
  const slow = makeEngine(clockA, { speed: "slow" });
  slow.subscribe(() => { });
  const clockB = new FakeClock();
  const fast = makeEngine(clockB, { speed: "fast" });
  fast.subscribe(() => { });
  const width = 400;
  slow.render(width);
  fast.render(width);
  for (let i = 0; i < 24; i++) {
   clockA.advance(TICK);
   clockA.fire();
   clockB.advance(TICK);
   clockB.fire();
  }
  const pSlow = padding(slow.render(width));
  const pFast = padding(fast.render(width));
  expect(pFast).toBeGreaterThan(pSlow);
 });

 test("sleepy sleeps before calm; playful stays awake longest", () => {
  const run = (personality: PetSettings["personality"], ms: number) => {
   const clock = new FakeClock();
   const engine = makeEngine(clock, { personality });
   engine.subscribe(() => { });
   while (clock.now() < ms) {
    clock.advance(TICK);
    clock.fire();
   }
   return isSleeping(engine.render(60));
  };
  // 9s idle
  expect(run("sleepy", 9000)).toBe(true);
  expect(run("calm", 9000)).toBe(false);
  expect(run("playful", 9000)).toBe(false);
  expect(run("calm", 25_000)).toBe(true);
  expect(run("playful", 25_000)).toBe(false);
  // 50s idle: calm (20s) asleep, playful (45s) asleep too
  expect(run("calm", 50_000)).toBe(true);
  expect(run("playful", 50_000)).toBe(true);
 });

 test("personalities animate sitting frames at different rates", () => {
  const run = (personality: PetSettings["personality"]) => {
   const clock = new FakeClock();
   const engine = makeEngine(clock, { personality });
   engine.subscribe(() => { });
   engine.activity("typing");
   clock.advance(750);
   clock.fire();
   return engine.render(40).join("\n");
  };
  expect(run("playful")).not.toBe(run("sleepy"));
 });
});

describe("activity: typing and reply", () => {
 test("reply deltas do not override an active input-activity pause", () => {
  const clock = new FakeClock();
  const engine = makeEngine(clock);
  const off = engine.subscribe(() => { });
  try {
   engine.activity("typing");
   const position = padding(engine.render(60));
   for (let i = 0; i < 4; i++) {
    clock.advance(250);
    engine.activity("reply");
    clock.fire();
    expect(isSitting(engine.render(60))).toBe(true);
    expect(padding(engine.render(60))).toBe(position);
   }
   clock.advance(1000);
   clock.fire();
   expect(isWalkingDir(engine.render(60))).toBe(true);
  } finally { off(); engine.dispose(); }
 });
 test("typing pauses walking and sits; resumes after hold expires", () => {
  const clock = new FakeClock();
  const engine = makeEngine(clock);
  engine.subscribe(() => { });
  engine.activity("typing");
  const before = padding(engine.render(60));
  for (let i = 0; i < 4; i++) {
   clock.advance(TICK);
   clock.fire();
  }
  const during = engine.render(60);
  expect(padding(during)).toBe(before);
  expect(isSitting(during)).toBe(true);
  // hold is 1.5s; at 1s still sitting
  clock.advance(1000 - 4 * TICK);
  clock.fire();
  expect(isSitting(engine.render(60))).toBe(true);
  // after hold expires, walking resumes and position changes
  let moved = false;
  for (let i = 0; i < 8; i++) {
   clock.advance(TICK);
   clock.fire();
   if (padding(engine.render(60)) !== before) moved = true;
  }
  expect(moved).toBe(true);
  expect(isWalkingDir(engine.render(60))).toBe(true);
 });

 test("repeated typing events extend the pause", () => {
  const clock = new FakeClock();
  const engine = makeEngine(clock);
  engine.subscribe(() => { });
  engine.activity("typing");
  for (let i = 0; i < 5; i++) {
   clock.advance(700);
   clock.fire();
   engine.activity("typing");
  }
  expect(isSitting(engine.render(60))).toBe(true);
  expect(isWalkingDir(engine.render(60))).toBe(false);
 });

 test("sleeping pet wakes on reply and walks", () => {
  const clock = new FakeClock();
  const engine = makeEngine(clock, { personality: "sleepy" });
  engine.subscribe(() => { });
  for (let i = 0; i < 34; i++) {
   clock.advance(TICK);
   clock.fire();
  }
  expect(isSleeping(engine.render(60))).toBe(true);
  engine.activity("reply");
  const awake = engine.render(60);
  expect(isSleeping(awake)).toBe(false);
  const p0 = padding(awake);
  let moved = false;
  for (let i = 0; i < 6; i++) {
   clock.advance(TICK);
   clock.fire();
   if (padding(engine.render(60)) !== p0) moved = true;
  }
  expect(moved).toBe(true);
 });

 test("reply suppresses sleep for a bounded window", () => {
  const clock = new FakeClock();
  const engine = makeEngine(clock, { personality: "sleepy" });
  engine.subscribe(() => { });
  for (let i = 0; i < 30; i++) {
   clock.advance(TICK);
   clock.fire();
  }
  engine.activity("reply");
  // 9s after reply: still awake (suppression ~10s)
  for (let i = 0; i < 36; i++) {
   clock.advance(TICK);
   clock.fire();
  }
  expect(isSleeping(engine.render(60))).toBe(false);
  // 12s after reply: asleep again
  for (let i = 0; i < 12; i++) {
   clock.advance(TICK);
   clock.fire();
  }
  expect(isSleeping(engine.render(60))).toBe(true);
 });

 test("sleep stops movement", () => {
  const clock = new FakeClock();
  const engine = makeEngine(clock, { personality: "sleepy" });
  engine.subscribe(() => { });
  for (let i = 0; i < 34; i++) {
   clock.advance(TICK);
   clock.fire();
  }
  const p0 = padding(engine.render(60));
  for (let i = 0; i < 8; i++) {
   clock.advance(TICK);
   clock.fire();
  }
  expect(padding(engine.render(60))).toBe(p0);
 });
});

describe("elapsed-time derivation and catchup bound", () => {
 test("movement derives from clock elapsed time, not fire count", () => {
  const width = 400;
  const clockA = new FakeClock();
  const a = makeEngine(clockA);
  a.subscribe(() => { });
  const clockB = new FakeClock();
  const b = makeEngine(clockB);
  b.subscribe(() => { });
  a.render(width);
  b.render(width);
  // A: one fire covering 1000ms. B: four fires covering 250ms each.
  clockA.advance(1000);
  clockA.fire();
  for (let i = 0; i < 4; i++) {
   clockB.advance(TICK);
   clockB.fire();
  }
  const pa = padding(a.render(width));
  const pb = padding(b.render(width));
  expect(Math.abs(pa - pb)).toBeLessThanOrEqual(2);
  expect(pa).toBeGreaterThan(0);
 });

 test("huge time jump is bounded: no huge catchup movement", () => {
  const clock = new FakeClock();
  const engine = makeEngine(clock); // normal speed
  engine.subscribe(() => { });
  engine.render(2000);
  clock.advance(600_000);
  clock.fire();
  const p = padding(engine.render(2000));
  // dt capped at 5s * 7 cols/s = 35 cols
  expect(p).toBeLessThanOrEqual(36);
 });
});

describe("redraw suppression when visual state unchanged", () => {
 test("tick with no visible change skips redraw", () => {
  const clock = new FakeClock();
  const engine = makeEngine(clock);
  let redraws = 0;
  engine.subscribe(() => redraws++);
  // tiny dt: rounded position and frame unchanged
  clock.advance(10);
  clock.fire();
  expect(redraws).toBe(0);
  clock.advance(400);
  clock.fire();
  expect(redraws).toBeGreaterThanOrEqual(1);
  engine.dispose();
 });
});

describe("row budgets", () => {
 test("full size honors maxRows 3/2/1/0 and collapses under 3 rows", () => {
  const clock = new FakeClock();
  const engine = makeEngine(clock, { size: "full", motion: "static" });
  expect(engine.render(40).length).toBe(3);
  expect(engine.render(40, 3).length).toBe(3);
  const two = engine.render(40, 2);
  expect(two.length).toBe(1);
  const one = engine.render(40, 1);
  expect(one.length).toBe(1);
  // Budgets below three rows select the complete compact sprite.
  expect(two).toEqual(one);
  expect(one).toEqual(["[o_o]"]);
  expect(engine.render(40, 0)).toEqual([]);
 });

 test("compact size always one row regardless of budget", () => {
  const clock = new FakeClock();
  const engine = makeEngine(clock, { size: "compact", motion: "static" });
  expect(engine.render(40).length).toBe(1);
  expect(engine.render(40, 3).length).toBe(1);
  expect(engine.render(40, 2).length).toBe(1);
  expect(engine.render(40, 0)).toEqual([]);
 });
});

describe("display name handling", () => {
 test("name appended only when it fits; never clips or overflows", () => {
  const clock = new FakeClock();
  const engine = makeEngine(clock, { name: "Miso", motion: "static" });
  const fits = engine.render(10); // "[o_o]" + " Miso" = 10
  expect(fits[0]).toContain("Miso");
  expect(fits[0].length).toBeLessThanOrEqual(10);
  const noFit = engine.render(9);
  expect(noFit[0]).not.toContain("Miso");
  expect(noFit[0].length).toBeLessThanOrEqual(9);
 });

 test("full-size name lands on the bottom row when it fits", () => {
  const clock = new FakeClock();
  const engine = makeEngine(clock, {
   name: "Miso",
   size: "full",
   motion: "static",
  });
  const rows = engine.render(40);
  expect(rows.length).toBe(3);
  expect(rows[2]).toContain("Miso");
 });

 test("unicode name is omitted conservatively", () => {
  const clock = new FakeClock();
  const engine = makeEngine(clock, { name: "猫", motion: "static" });
  const rows = engine.render(40);
  expect(rows[0]).not.toContain("猫");
  for (const r of rows) {
   for (const ch of r) expect(ch.charCodeAt(0)).toBeLessThanOrEqual(0x7e);
  }
 });

 test("control characters in name are stripped defensively", () => {
  const clock = new FakeClock();
  const engine = makeEngine(clock, { name: "a\x07b", motion: "static" });
  const rows = engine.render(40);
  expect(rows[0]).toContain("ab");
  expect(rows[0]).not.toContain("\x07");
 });

 test("empty name renders no label artifact", () => {
  const clock = new FakeClock();
  const engine = makeEngine(clock, { name: "", motion: "static" });
  const rows = engine.render(40);
  expect(rows[0].trimEnd()).toBe("[o_o]");
 });
});

describe("preview rollback", () => {
 test("restores original position, pose, frame, sprite and motion after a clamping preview", () => {
  const clock = new FakeClock();
  const engine = makeEngine(clock);
  const off = engine.subscribe(() => { });
  try {
   engine.render(20);
   clock.advance(750);
   clock.fire();
   const original = engine.render(20);
   const rollback = engine.beginPreview();
   const larger = makeSprite();
   larger.full.idle = [["wide animal", "[o_o]      ", " /   \\     "]];
   engine.update(settings({ size: "full", motion: "static" }), larger);
   engine.render(6);
   clock.advance(10_000);
   rollback();
   expect(engine.render(20)).toEqual(original);
   expect(clock.active.size).toBe(1);
   clock.advance(250);
   clock.fire();
   const advanced = engine.render(20);
   expect(advanced).not.toEqual(original);
   rollback();
   expect(engine.render(20)).toEqual(advanced);
  } finally { off(); engine.dispose(); }
 });

 test("restores static mode without leaving a preview timer alive", () => {
  const clock = new FakeClock();
  const engine = makeEngine(clock, { motion: "static" });
  const off = engine.subscribe(() => { });
  try {
   const original = engine.render(40);
   const rollback = engine.beginPreview();
   engine.update(settings({ motion: "animated", name: "Preview" }), makeSprite());
   expect(clock.active.size).toBe(1);
   clock.advance(1000);
   clock.fire();
   rollback();
   expect(engine.render(40)).toEqual(original);
   expect(clock.active.size).toBe(0);
  } finally { off(); engine.dispose(); }
 });

 test("a stale rollback cannot revive a disposed engine", () => {
  const clock = new FakeClock();
  const engine = makeEngine(clock);
  let paints = 0;
  engine.subscribe(() => { paints++; });
  const rollback = engine.beginPreview();
  engine.dispose();
  const before = paints;
  rollback();
  expect(clock.active.size).toBe(0);
  expect(paints).toBe(before);
 });
});
