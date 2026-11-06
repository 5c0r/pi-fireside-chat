import { describe, expect, test } from "bun:test";
import type { PetClock } from "./pet-engine";
import { Feeder } from "./pet-food";

/**
 * Deterministic behavioral tests for the pure Feeder (streaming crumbs).
 *
 * All timing is driven through FakeClock and all randomness through scripted
 * FakeRandom values. No real timers (the Feeder must never call
 * setInterval/clearInterval), no walltime dependence, no statistical or
 * distribution assertions — only exact deterministic outcomes.
 *
 * Contract constants appear here as literals on purpose; the module keeps
 * them private.
 */

const SPAWN_MIN_INTERVAL_MS = 500;
const MAX_ACTIVE = 10;
const FULL_AFTER = 5;
const SATISFIED_MS = 1200;
const DIGEST_MS = 6000;
const MUNCH_MS = 700;

const ALLOW = /^[A-Za-z0-9_{}()<>/=+\-*.;:]{1,3}$/;

class FakeClock implements PetClock {
 private t = 0;
 intervalCalls = 0;
 clearCalls = 0;

 now(): number {
  return this.t;
 }
 advance(ms: number): void {
  this.t += ms;
 }
 setInterval(_fn: () => void, _ms: number): number {
  this.intervalCalls++;
  return 0;
 }
 clearInterval(_handle: unknown): void {
  this.clearCalls++;
 }
}

function fakeRandom(values: number[]): { next: () => number; calls: number[] } {
 const seen: number[] = [];
 const next = (): number => {
  const v = values.length > 1 ? (values.shift() as number) : values[0];
  seen.push(v);
  return v;
 };
 return { next, calls: seen };
}

function makeFeeder(values: number[] = [0.25]) {
 const clock = new FakeClock();
 const rnd = fakeRandom(values);
 const feeder = new Feeder(clock, rnd.next);
 return { clock, rnd, feeder };
}

/** Land every piece spawned so far by stepping well past its fall time. */
function landAll(feeder: Feeder, atMs: number): void {
 feeder.step(atMs);
}

function glyphAt(feeder: Feeder, columns = 80, rows = 3): string {
 const pieces = feeder.pieces(columns, rows);
 return pieces[0]?.glyph ?? "";
}

describe("Feeder", () => {
 test("fresh feeder is idle with no pieces, target, or consumed count", () => {
  const { feeder } = makeFeeder();
  expect(feeder.phase()).toBe("idle");
  expect(feeder.consumed()).toBe(0);
  expect(feeder.targetId()).toBe(null);
  expect(feeder.pieces(80, 3)).toEqual([]);
 });

 test("never registers timers on the clock", () => {
  const { clock, feeder } = makeFeeder();
  feeder.ingestDelta("fn", 0);
  feeder.step(700);
  feeder.beginMunch(1, 700);
  feeder.step(1400);
  feeder.beginPreview()();
  feeder.clear();
  expect(clock.intervalCalls).toBe(0);
  expect(clock.clearCalls).toBe(0);
 });

 describe("sanitizer", () => {
  const corpus: Array<[string, string | null]> = [
   ["fn", "fn"],
   ["\u001b[31merr\u001b[0m", "err"],
   ["\u001b]0;title\u0007ok", "ok"],
   ["\u001b]0;title\u001b\\ok", "ok"],
   ["\u009b31merr\u009b0m", "err"],
   ["\u009d0;title\u009cok", "ok"],
   ["\u001b[31", null],
   ["\u001b]unclosed title", null],
   ["\u001b[31ok", "k"],
   ["\u{1F346}nom\u{1F600}", "nom"],
   ["\u200Bhi\u200D", "hi"],
   ["hi\uD83D", "hi"],
   ["\u0007\u0000ok", "ok"],
   ["\u007Fok", "ok"],
   ["   ", null],
   ["", null],
   ["\n\t\r\n", null],
   ["??? !!!", null],
   ["\u001b[31m\u001b[0m", null],
  ];

  for (const [text, expected] of corpus) {
   test(`ingest ${JSON.stringify(text)} -> ${expected === null ? "no spawn" : expected}`, () => {
    const { feeder } = makeFeeder([0]);
    const spawned = feeder.ingestDelta(text, 1000);
    if (expected === null) {
     expect(spawned).toBe(0);
     expect(feeder.pieces(80, 3)).toEqual([]);
    } else {
     expect(spawned).toBe(1);
     expect(glyphAt(feeder)).toBe(expected);
    }
   });
  }

  test("every produced glyph matches the allowlist and is 1-3 visible ASCII chars", () => {
   for (const [text] of corpus) {
    const { feeder } = makeFeeder([0.3]);
    const spawned = feeder.ingestDelta(text, 0);
    if (spawned === 0) continue;
    for (const piece of feeder.pieces(80, 3)) {
     expect(piece.glyph).toMatch(ALLOW);
     expect(piece.glyph.length).toBeGreaterThanOrEqual(1);
     expect(piece.glyph.length).toBeLessThanOrEqual(3);
     for (const ch of piece.glyph) {
      expect(ch.charCodeAt(0)).toBeGreaterThanOrEqual(0x20);
      expect(ch.charCodeAt(0)).toBeLessThanOrEqual(0x7e);
     }
    }
   }
  });

  test("prefers 2-3 length runs over single characters", () => {
   const a = makeFeeder([0]);
   expect(a.feeder.ingestDelta("x fn y", 0)).toBe(1);
   expect(glyphAt(a.feeder)).toBe("fn");
   const b = makeFeeder([0.9]);
   expect(b.feeder.ingestDelta("a bc 42", 0)).toBe(1);
   expect(glyphAt(b.feeder)).toBe("42");
  });

  test("uses single-character run only when no longer run exists", () => {
   const { feeder } = makeFeeder([0]);
   expect(feeder.ingestDelta("x  y", 0)).toBe(1);
   expect(glyphAt(feeder)).toBe("x");
  });

  test("long runs yield a 3-char window at the injected random offset", () => {
   const a = makeFeeder([0]);
   expect(a.feeder.ingestDelta("function", 0)).toBe(1);
   expect(glyphAt(a.feeder)).toBe("fun");
   const b = makeFeeder([0.9]);
   expect(b.feeder.ingestDelta("function", 0)).toBe(1);
   expect(glyphAt(b.feeder)).toBe("ion");
  });

  test("run of exactly 3 chars is used whole", () => {
   const { feeder } = makeFeeder([0]);
   expect(feeder.ingestDelta("abc", 0)).toBe(1);
   expect(glyphAt(feeder)).toBe("abc");
  });

  test("ingestDelta defaults atMs to clock.now()", () => {
   const { clock, feeder } = makeFeeder([0]);
   clock.advance(1234);
   expect(feeder.ingestDelta("fn")).toBe(1);
   expect(feeder.pieces(80, 3).length).toBe(1);
  });
 });

 describe("spawn gate and cap", () => {
  test("second ingest within 500ms is skipped with no backlog", () => {
   const { feeder } = makeFeeder([0.2]);
   expect(feeder.ingestDelta("fn", 0)).toBe(1);
   expect(feeder.ingestDelta("ok", 100)).toBe(0);
   expect(feeder.ingestDelta("ok", 499)).toBe(0);
   expect(feeder.ingestDelta("ok", 500)).toBe(1);
   expect(feeder.pieces(80, 3).length).toBe(2);
  });

  test("delta with no visible fragment does not consume the spawn gate", () => {
   const { feeder } = makeFeeder([0.2]);
   expect(feeder.ingestDelta("fn", 0)).toBe(1);
   expect(feeder.ingestDelta("   ", 200)).toBe(0);
   expect(feeder.ingestDelta("ok", 600)).toBe(1);
   expect(feeder.pieces(80, 3).length).toBe(2);
  });

  test("eleventh piece is rejected while ten remain active", () => {
   const { feeder } = makeFeeder([0.2]);
   for (let i = 0; i < MAX_ACTIVE; i++) {
    expect(feeder.ingestDelta(`p${i}`, i * 1000)).toBe(1);
    feeder.step(i * 1000 + 50);
   }
   expect(feeder.pieces(80, 3).length).toBe(MAX_ACTIVE);
   expect(feeder.ingestDelta("fn", 20000)).toBe(0);
   expect(feeder.pieces(80, 3).length).toBe(MAX_ACTIVE);
  });

  test("piece in the mouth still counts toward the cap", () => {
   const { feeder } = makeFeeder([0.2]);
   for (let i = 0; i < MAX_ACTIVE; i++) {
    expect(feeder.ingestDelta(`p${i}`, i * 1000)).toBe(1);
   }
   landAll(feeder, 10000);
   expect(feeder.phase()).toBe("chasing");
   expect(feeder.targetId()).toBe(1);
   feeder.beginMunch(1, 10000);
   expect(feeder.phase()).toBe("munching");
   expect(feeder.pieces(80, 3).length).toBe(MAX_ACTIVE);
   expect(feeder.ingestDelta("fn", 20000)).toBe(0);
  });

  test("capacity frees only after step removes the munched piece", () => {
   const { feeder } = makeFeeder([0.2]);
   for (let i = 0; i < MAX_ACTIVE; i++) {
    expect(feeder.ingestDelta(`p${i}`, i * 1000)).toBe(1);
   }
   landAll(feeder, 10000);
   feeder.beginMunch(1, 10000);
   expect(feeder.ingestDelta("fn", 10700)).toBe(0);
   feeder.step(10700);
   expect(feeder.pieces(80, 3).length).toBe(MAX_ACTIVE - 1);
   expect(feeder.ingestDelta("fn", 20000)).toBe(1);
  });

  test("burst of 20 deltas across 10s never exceeds 2/sec sustained or 10 active", () => {
   const { feeder } = makeFeeder([0.1]);
   const spawnTimes: number[] = [];
   for (let i = 0; i < 20; i++) {
    const t = i * SPAWN_MIN_INTERVAL_MS;
    if (feeder.ingestDelta("d", t) === 1) spawnTimes.push(t);
    feeder.step(t);
    expect(feeder.pieces(80, 3).length).toBeLessThanOrEqual(MAX_ACTIVE);
   }
   expect(spawnTimes.length).toBeLessThanOrEqual(20);
   for (let w = 0; w < 20; w++) {
    const start = w * SPAWN_MIN_INTERVAL_MS;
    const inWindow = spawnTimes.filter((t) => t >= start && t < start + 1000).length;
    expect(inWindow).toBeLessThanOrEqual(2);
   }
  });
 });

 describe("falling and landing", () => {
  test("row advances one per 350ms and lands at rows-1", () => {
   const { clock, feeder } = makeFeeder([0.2]);
   expect(feeder.ingestDelta("fn", 1000)).toBe(1);
   feeder.step(1000);
   expect(feeder.pieces(80, 3)).toEqual([
    { id: 1, glyph: "fn", column: 16, row: 0, landed: false },
   ]);
   clock.advance(349);
   feeder.step(1349);
   expect(feeder.pieces(80, 3)[0]?.row).toBe(0);
   expect(feeder.pieces(80, 3)[0]?.landed).toBe(false);
   feeder.step(1350);
   expect(feeder.pieces(80, 3)[0]?.row).toBe(1);
   feeder.step(1700);
   const landed = feeder.pieces(80, 3)[0];
   expect(landed?.row).toBe(2);
   expect(landed?.landed).toBe(true);
   feeder.step(2400);
   expect(feeder.pieces(80, 3)[0]?.row).toBe(2);
  });

  test("land row clamps to rows-1 for fewer rows", () => {
   const { feeder } = makeFeeder([0.2]);
   feeder.ingestDelta("fn", 0);
   feeder.setViewport(80, 2);
   feeder.step(350);
   const piece = feeder.pieces(80, 2)[0];
   expect(piece?.row).toBe(1);
   expect(piece?.landed).toBe(true);
  });

  test("step is idempotent per timestamp", () => {
   const { feeder } = makeFeeder([0.2]);
   feeder.ingestDelta("fn", 0);
   feeder.step(700);
   feeder.beginMunch(1, 700);
   feeder.step(1400);
   feeder.step(1400);
   expect(feeder.consumed()).toBe(1);
   expect(feeder.pieces(80, 3)).toEqual([]);
  });

  test("step ignores out-of-order timestamps", () => {
   const { feeder } = makeFeeder([0.2]);
   feeder.ingestDelta("fn", 0);
   feeder.step(2000);
   const landed = feeder.pieces(80, 3)[0]?.landed;
   feeder.step(1000);
   expect(feeder.pieces(80, 3)[0]?.landed).toBe(landed);
  });
 });

 describe("targeting and munching", () => {
  test("first landed piece becomes the stable target; later pieces do not steal", () => {
   const { feeder } = makeFeeder([0.2]);
   expect(feeder.ingestDelta("fn", 0)).toBe(1);
   feeder.step(700);
   expect(feeder.phase()).toBe("chasing");
   expect(feeder.targetId()).toBe(1);
   expect(feeder.ingestDelta("ok", 1000)).toBe(1);
   feeder.step(1700);
   expect(feeder.targetId()).toBe(1);
   feeder.step(3000);
   expect(feeder.targetId()).toBe(1);
  });

  test("after a meal selects nearer N8 before older F72 and keeps that target", () => {
   const { feeder } = makeFeeder([0, 0.5, 0, 0.9, 0, 0.1, 0, 0]);
   feeder.ingestDelta("A", 0);
   feeder.step(700, { position: 40, width: 5 });
   feeder.beginMunch(1, 700);
   feeder.ingestDelta("F", 800);
   feeder.ingestDelta("N", 1300);
   feeder.step(2100, { position: 0, width: 5 });
   expect(feeder.pieces(80, 3).map(piece => [piece.glyph, piece.column])).toEqual([["F", 72], ["N", 8]]);
   expect(feeder.consumed()).toBe(1);
   expect(feeder.targetId()).toBe(3);
   feeder.ingestDelta("C", 2200);
   feeder.step(3000, { position: 0, width: 5 });
   expect(feeder.targetId()).toBe(3);
  });

  test("beginMunch is idempotent per piece and piece stays counted until MUNCH_MS", () => {
   const { feeder } = makeFeeder([0.2]);
   feeder.ingestDelta("fn", 0);
   feeder.step(1000);
   feeder.beginMunch(1, 1000);
   feeder.beginMunch(1, 1600);
   feeder.step(1699);
   expect(feeder.pieces(80, 3).length).toBe(1);
   expect(feeder.phase()).toBe("munching");
   feeder.step(1700);
   expect(feeder.pieces(80, 3)).toEqual([]);
   expect(feeder.consumed()).toBe(1);
   expect(feeder.phase()).toBe("idle");
  });

  test("beginMunch with unknown piece id is a no-op", () => {
   const { feeder } = makeFeeder([0.2]);
   feeder.beginMunch(99, 0);
   expect(feeder.phase()).toBe("idle");
   expect(feeder.pieces(80, 3)).toEqual([]);
  });
 });

 describe("fullness, satisfaction, digestion", () => {
  function reachSatisfied() {
   const { feeder } = makeFeeder([0.2]);
   for (let i = 0; i <= FULL_AFTER; i++) {
    feeder.ingestDelta(`p${i}`, i * 1000);
   }
   landAll(feeder, 6000);
   for (let k = 1; k <= FULL_AFTER; k++) {
    const start = 6000 + (k - 1) * MUNCH_MS;
    feeder.beginMunch(k, start);
    feeder.step(start + MUNCH_MS);
   }
   return { feeder };
  }

  test("exactly five eaten: leftovers retained, phase satisfied, target null", () => {
   const { feeder } = reachSatisfied();
   expect(feeder.consumed()).toBe(FULL_AFTER);
   expect(feeder.phase()).toBe("satisfied");
   expect(feeder.targetId()).toBe(null);
   expect(feeder.pieces(80, 3)).toEqual([
    { id: 6, glyph: "p5", column: 16, row: 2, landed: true },
   ]);
  });

  test("satisfied lasts SATISFIED_MS then digesting lasts DIGEST_MS then resumes chasing with consumed reset", () => {
   const { feeder } = reachSatisfied();
   const satisfiedAt = 6000 + FULL_AFTER * MUNCH_MS;
   feeder.step(satisfiedAt + SATISFIED_MS - 1);
   expect(feeder.phase()).toBe("satisfied");
   feeder.step(satisfiedAt + SATISFIED_MS);
   expect(feeder.phase()).toBe("digesting");
   expect(feeder.consumed()).toBe(FULL_AFTER);
   feeder.step(satisfiedAt + SATISFIED_MS + DIGEST_MS - 1);
   expect(feeder.phase()).toBe("digesting");
   feeder.step(satisfiedAt + SATISFIED_MS + DIGEST_MS);
   expect(feeder.phase()).toBe("chasing");
   expect(feeder.targetId()).toBe(6);
   expect(feeder.consumed()).toBe(0);
  });

  test("ingest returns 0 while satisfied or digesting", () => {
   const { feeder } = reachSatisfied();
   const satisfiedAt = 6000 + FULL_AFTER * MUNCH_MS;
   expect(feeder.ingestDelta("fn", satisfiedAt + 100)).toBe(0);
   feeder.step(satisfiedAt + SATISFIED_MS);
   expect(feeder.phase()).toBe("digesting");
   expect(feeder.ingestDelta("fn", satisfiedAt + SATISFIED_MS + 1000)).toBe(0);
  });

  test("six-second digest ignores repeated ingest and step bursts; wake resets consumed and allows food again", () => {
   const { feeder } = reachSatisfied();
   const satisfiedAt = 6000 + FULL_AFTER * MUNCH_MS;
   const digestStart = satisfiedAt + SATISFIED_MS;
   feeder.step(digestStart);
   expect(feeder.phase()).toBe("digesting");
   for (let j = 0; j < 10; j++) {
    const t = digestStart + 100 + j * 100;
    expect(feeder.ingestDelta("fn", t)).toBe(0);
    feeder.step(t);
    expect(feeder.phase()).toBe("digesting");
    expect(feeder.pieces(80, 3)).toEqual([
     { id: 6, glyph: "p5", column: 16, row: 2, landed: true },
    ]);
   }
   feeder.step(digestStart + DIGEST_MS);
   expect(feeder.phase()).toBe("chasing");
   expect(feeder.targetId()).toBe(6);
   expect(feeder.consumed()).toBe(0);
   expect(feeder.ingestDelta("fn", digestStart + DIGEST_MS + 1000)).toBe(1);
  });

  test("landed leftovers retain identity through full and nap, then wake targets and consumes them without new deltas", () => {
   const { clock, feeder } = makeFeeder([
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.9, 0, 0.1,
   ]);
   const pet = { position: 0, width: 5 };
   for (const glyph of ["p0", "p1", "p2", "p3", "p4", "F", "N"]) {
    expect(feeder.ingestDelta(glyph)).toBe(1);
    clock.advance(500);
   }
   clock.advance(500);
   feeder.step(clock.now(), pet);
   for (let id = 1; id <= 5; id++) {
    expect(feeder.targetId()).toBe(id);
    feeder.beginMunch(id, clock.now());
    clock.advance(700);
    feeder.step(clock.now(), pet);
   }
   for (const [atMs, phase] of [
    [7500, "satisfied"],
    [7600, "satisfied"],
    [8699, "satisfied"],
    [8700, "digesting"],
    [8800, "digesting"],
    [14699, "digesting"],
   ] as const) {
    clock.advance(atMs - clock.now());
    feeder.step(clock.now(), pet);
    expect(feeder.phase()).toBe(phase);
    expect(feeder.targetId()).toBe(null);
    expect(feeder.consumed()).toBe(5);
    expect(feeder.ingestDelta("new")).toBe(0);
    expect(feeder.pieces(80, 3)).toEqual([
     { id: 6, glyph: "F", column: 72, row: 2, landed: true },
     { id: 7, glyph: "N", column: 8, row: 2, landed: true },
    ]);
   }
   clock.advance(1);
   feeder.step(clock.now(), pet);
   expect(feeder.phase()).toBe("chasing");
   expect(feeder.consumed()).toBe(0);
   expect(feeder.targetId()).toBe(7);
   expect(feeder.pieces(80, 3)).toEqual([
    { id: 6, glyph: "F", column: 72, row: 2, landed: true },
    { id: 7, glyph: "N", column: 8, row: 2, landed: true },
   ]);
   feeder.beginMunch(7, clock.now());
   clock.advance(699);
   feeder.step(clock.now(), pet);
   expect(feeder.phase()).toBe("munching");
   expect(feeder.targetId()).toBe(7);
   expect(feeder.consumed()).toBe(0);
   expect(feeder.pieces(80, 3)).toEqual([
    { id: 6, glyph: "F", column: 72, row: 2, landed: true },
    { id: 7, glyph: "N", column: 8, row: 2, landed: true, eatenAt: 14700 },
   ]);
   clock.advance(1);
   feeder.step(clock.now(), pet);
   expect(feeder.phase()).toBe("chasing");
   expect(feeder.targetId()).toBe(6);
   expect(feeder.consumed()).toBe(1);
   expect(feeder.pieces(80, 3)).toEqual([
    { id: 6, glyph: "F", column: 72, row: 2, landed: true },
   ]);
   feeder.beginMunch(6, clock.now());
   clock.advance(700);
   feeder.step(clock.now(), pet);
   expect(feeder.phase()).toBe("idle");
   expect(feeder.targetId()).toBe(null);
   expect(feeder.consumed()).toBe(2);
   expect(feeder.pieces(80, 3)).toEqual([]);
  });

  for (const { landingPhase, rows, samples } of [
   {
    landingPhase: "satisfied",
    rows: 3,
    samples: [
     { atMs: 8500, phase: "satisfied", row: 0, landed: false },
     { atMs: 8749, phase: "satisfied", row: 0, landed: false },
     { atMs: 8750, phase: "satisfied", row: 1, landed: false },
     { atMs: 9099, phase: "satisfied", row: 1, landed: false },
     { atMs: 9100, phase: "satisfied", row: 2, landed: true },
     { atMs: 9699, phase: "satisfied", row: 2, landed: true },
     { atMs: 9700, phase: "digesting", row: 2, landed: true },
     { atMs: 15699, phase: "digesting", row: 2, landed: true },
    ],
   },
   {
    landingPhase: "digesting",
    rows: 8,
    samples: [
     { atMs: 8500, phase: "satisfied", row: 0, landed: false },
     { atMs: 8750, phase: "satisfied", row: 1, landed: false },
     { atMs: 9100, phase: "satisfied", row: 2, landed: false },
     { atMs: 9450, phase: "satisfied", row: 3, landed: false },
     { atMs: 9699, phase: "satisfied", row: 3, landed: false },
     { atMs: 9700, phase: "digesting", row: 3, landed: false },
     { atMs: 9799, phase: "digesting", row: 3, landed: false },
     { atMs: 9800, phase: "digesting", row: 4, landed: false },
     { atMs: 10150, phase: "digesting", row: 5, landed: false },
     { atMs: 10500, phase: "digesting", row: 6, landed: false },
     { atMs: 10849, phase: "digesting", row: 6, landed: false },
     { atMs: 10850, phase: "digesting", row: 7, landed: true },
     { atMs: 15699, phase: "digesting", row: 7, landed: true },
    ],
   },
  ] as const) {
   test(`airborne leftovers keep falling and land during ${landingPhase}`, () => {
    const { clock, feeder } = makeFeeder([0.2]);
    feeder.setViewport(80, rows);
    for (let i = 0; i < 5; i++) {
     expect(feeder.ingestDelta(`p${i}`)).toBe(1);
     clock.advance(500);
    }
    clock.advance(2500);
    feeder.step(clock.now());
    for (let id = 1; id <= 4; id++) {
     feeder.beginMunch(id, clock.now());
     clock.advance(700);
     feeder.step(clock.now());
    }
    feeder.beginMunch(5, clock.now());
    clock.advance(600);
    expect(feeder.ingestDelta("air")).toBe(1);
    expect(feeder.pieces(80, rows)).toEqual([
     { id: 5, glyph: "p4", column: 16, row: rows - 1, landed: true, eatenAt: 7800 },
     { id: 6, glyph: "air", column: 16, row: 0, landed: false },
    ]);
    for (const { atMs, phase, row, landed } of samples) {
     clock.advance(atMs - clock.now());
     feeder.step(clock.now());
     expect(feeder.phase()).toBe(phase);
     expect(feeder.targetId()).toBe(null);
     expect(feeder.consumed()).toBe(5);
     expect(feeder.ingestDelta("new")).toBe(0);
     expect(feeder.pieces(80, rows)).toEqual([
      { id: 6, glyph: "air", column: 16, row, landed },
     ]);
    }
    clock.advance(1);
    feeder.step(clock.now());
    expect(feeder.phase()).toBe("chasing");
    expect(feeder.targetId()).toBe(6);
    expect(feeder.consumed()).toBe(0);
    feeder.beginMunch(6, clock.now());
    clock.advance(700);
    feeder.step(clock.now());
    expect(feeder.phase()).toBe("idle");
    expect(feeder.targetId()).toBe(null);
    expect(feeder.consumed()).toBe(1);
    expect(feeder.pieces(80, rows)).toEqual([]);
   });
  }
 });

 describe("clamping and removal", () => {
  test("initial viewport constrains spawn columns and compact treats land on row zero", () => {
   const clock = new FakeClock();
   const feeder = new Feeder(clock, () => 0.95, { columns: 20, rows: 1 });
   expect(feeder.ingestDelta("fn")).toBe(1);
   feeder.step(0);
   expect(feeder.pieces(20, 1)).toEqual([
    { id: 1, glyph: "fn", column: 19, row: 0, landed: true },
   ]);
   expect(feeder.targetId()).toBe(1);
  });

  test("explicit canonical viewport constrains subsequent spawns", () => {
   const { feeder } = makeFeeder([0.95]);
   feeder.setViewport(20, 3);
   expect(feeder.ingestDelta("fn", 0)).toBe(1);
   expect(feeder.pieces(20, 3)[0]?.column).toBe(19);
  });

  test("zero dimensions return no pieces and step removes unreachable pieces", () => {
   const { feeder } = makeFeeder([0.2]);
   feeder.ingestDelta("fn", 0);
   expect(feeder.pieces(0, 3)).toEqual([]);
   feeder.setViewport(0, 3);
   feeder.step(1);
   expect(feeder.pieces(80, 3)).toEqual([]);
   expect(feeder.targetId()).toBe(null);
  });

  test("render copies cannot mutate stored pieces", () => {
   const { feeder } = makeFeeder([0.2]);
   feeder.ingestDelta("fn", 0);
   const pieces = feeder.pieces(80, 3);
   pieces[0].glyph = "bad";
   pieces[0].column = 1000;
   pieces.length = 0;
   expect(feeder.pieces(80, 3)[0]?.glyph).toBe("fn");
   expect(feeder.pieces(80, 3)[0]?.column).toBe(16);
  });

  test("pieces render clamped inside columns and are removed once unreachable", () => {
   const { feeder } = makeFeeder([0.95]);
   expect(feeder.ingestDelta("fn", 0)).toBe(1);
   expect(feeder.pieces(80, 3)[0]?.column).toBe(76);
   expect(feeder.pieces(40, 3)[0]?.column).toBe(39);
   feeder.setViewport(40, 3);
   feeder.step(1000);
   expect(feeder.pieces(40, 3)).toEqual([]);
  });

  test("removal of the target piece returns phase to idle then re-picks", () => {
   const { feeder } = makeFeeder([0.95, 0.95, 0.1, 0.1]);
   expect(feeder.ingestDelta("fn", 0)).toBe(1);
   expect(feeder.ingestDelta("ok", 1000)).toBe(1);
   feeder.step(2000, { position: 76, width: 5 });
   expect(feeder.targetId()).toBe(1);
   feeder.setViewport(40, 3);
   feeder.step(3000);
   expect(feeder.pieces(40, 3).length).toBe(1);
   expect(feeder.targetId()).toBe(2);
   expect(feeder.phase()).toBe("chasing");
  });

  test("projection alone never removes a reachable piece", () => {
   const { feeder } = makeFeeder([0.95]);
   feeder.ingestDelta("fn", 0);
   feeder.pieces(2, 1);
   feeder.step(1000);
   expect(feeder.pieces(80, 3).length).toBe(1);
  });

  test("render rows always stay inside [0, rows)", () => {
   const { feeder } = makeFeeder([0.2]);
   feeder.ingestDelta("fn", 0);
   feeder.step(5000);
   const piece = feeder.pieces(80, 2)[0];
   expect(piece?.row).toBe(1);
   expect(piece?.row).toBeLessThan(2);
  });
 });

 describe("beginPreview deep snapshot", () => {
  test("restore shifts fall deadlines by preview elapsed ms and preserves state", () => {
   const { clock, feeder } = makeFeeder([0.2]);
   feeder.ingestDelta("fn", 1000);
   feeder.ingestDelta("ok", 2000);
   feeder.step(2500);
   expect(feeder.phase()).toBe("chasing");
   clock.advance(2500);
   const restore = feeder.beginPreview();
   clock.advance(3000);
   expect(feeder.ingestDelta("zz", 5500)).toBe(1);
   feeder.step(5500);
   expect(feeder.pieces(80, 3).length).toBe(3);
   restore();
   const pieces = feeder.pieces(80, 3);
   expect(pieces.length).toBe(2);
   expect(feeder.phase()).toBe("chasing");
   expect(feeder.targetId()).toBe(1);
   expect(feeder.consumed()).toBe(0);
   const first = pieces.find((p) => p.id === 1);
   const second = pieces.find((p) => p.id === 2);
   expect(first?.landed).toBe(true);
   expect(first?.row).toBe(2);
   expect(second?.landed).toBe(false);
   expect(second?.row).toBe(1);
  });

  test("restore is idempotent once", () => {
   const { clock, feeder } = makeFeeder([0.2]);
   feeder.ingestDelta("fn", 1000);
   feeder.step(1500);
   clock.advance(1500);
   const restore = feeder.beginPreview();
   clock.advance(3000);
   restore();
   const rowAfterFirst = feeder.pieces(80, 3)[0]?.row;
   restore();
   expect(feeder.pieces(80, 3)[0]?.row).toBe(rowAfterFirst);
  });

  test("restore shifts satisfied deadline so preview elapsed time does not shorten the nap", () => {
   const { clock, feeder } = makeFeeder([0.2]);
   for (let i = 0; i < FULL_AFTER; i++) {
    feeder.ingestDelta(`p${i}`, i * 1000);
   }
   landAll(feeder, 6000);
   for (let k = 1; k <= FULL_AFTER; k++) {
    const start = 6000 + (k - 1) * MUNCH_MS;
    feeder.beginMunch(k, start);
    feeder.step(start + MUNCH_MS);
   }
   const satisfiedAt = 6000 + FULL_AFTER * MUNCH_MS;
   expect(feeder.phase()).toBe("satisfied");
   clock.advance(satisfiedAt);
   const restore = feeder.beginPreview();
   clock.advance(4000);
   feeder.step(satisfiedAt + 4000);
   expect(feeder.phase()).toBe("digesting");
   restore();
   expect(feeder.phase()).toBe("satisfied");
   expect(feeder.consumed()).toBe(FULL_AFTER);
   feeder.step(satisfiedAt + 4000 + 100);
   expect(feeder.phase()).toBe("satisfied");
   feeder.step(satisfiedAt + SATISFIED_MS + 4000);
   expect(feeder.phase()).toBe("digesting");
  });

  test("restore preserves partial munch, consumed count, and shifts its deadline", () => {
   const { clock, feeder } = makeFeeder([0.2]);
   feeder.ingestDelta("fn", 0);
   feeder.ingestDelta("ok", 1000);
   feeder.step(2000);
   feeder.beginMunch(1, 2000);
   feeder.step(2700);
   feeder.beginMunch(2, 2700);
   feeder.step(3000);
   clock.advance(3000);
   const restore = feeder.beginPreview();
   clock.advance(5000);
   feeder.step(8000);
   expect(feeder.consumed()).toBe(2);
   restore();
   expect(feeder.phase()).toBe("munching");
   expect(feeder.consumed()).toBe(1);
   expect(feeder.targetId()).toBe(2);
   expect(feeder.pieces(80, 3)[0]?.eatenAt).toBe(7700);
   feeder.step(8399);
   expect(feeder.consumed()).toBe(1);
   feeder.step(8400);
   expect(feeder.consumed()).toBe(2);
  });

  test("restore shifts the global spawn gate and restores viewport dimensions", () => {
   const { clock, feeder } = makeFeeder([0.95]);
   feeder.ingestDelta("fn", 1000);
   clock.advance(1100);
   const restore = feeder.beginPreview();
   feeder.setViewport(2, 1);
   clock.advance(5000);
   restore();
   expect(feeder.ingestDelta("ok", 6100)).toBe(0);
   expect(feeder.ingestDelta("ok", 6500)).toBe(1);
   expect(feeder.pieces(80, 3)[1]?.column).toBe(76);
  });

  test("restore shifts an active digestion deadline without resetting consumed", () => {
   const { clock, feeder } = makeFeeder([0.2]);
   for (let i = 0; i < 5; i++) feeder.ingestDelta("fn", i * 1000);
   feeder.step(6000);
   for (let id = 1; id <= 5; id++) {
    feeder.beginMunch(id, 6000 + (id - 1) * 700);
    feeder.step(6000 + id * 700);
   }
   feeder.step(10700);
   clock.advance(10700);
   const restore = feeder.beginPreview();
   clock.advance(5000);
   feeder.clear();
   restore();
   expect(feeder.phase()).toBe("digesting");
   expect(feeder.consumed()).toBe(5);
   feeder.step(21699);
   expect(feeder.phase()).toBe("digesting");
   feeder.step(21700);
   expect(feeder.phase()).toBe("idle");
   expect(feeder.consumed()).toBe(0);
  });

  test("restore overwrites a clear() performed during preview", () => {
   const { feeder } = makeFeeder([0.2]);
   feeder.ingestDelta("fn", 0);
   feeder.step(1000);
   const restore = feeder.beginPreview();
   feeder.clear();
   expect(feeder.pieces(80, 3)).toEqual([]);
   restore();
   expect(feeder.pieces(80, 3).length).toBe(1);
   expect(feeder.phase()).toBe("chasing");
   expect(feeder.targetId()).toBe(1);
  });
 });

 describe("clear", () => {
  test("clear drops food, counter, phase, target and resets the spawn gate", () => {
   const { feeder } = makeFeeder([0.2]);
   feeder.ingestDelta("fn", 0);
   feeder.ingestDelta("ok", 1000);
   feeder.step(2000);
   feeder.beginMunch(1, 2000);
   feeder.clear();
   expect(feeder.pieces(80, 3)).toEqual([]);
   expect(feeder.phase()).toBe("idle");
   expect(feeder.consumed()).toBe(0);
   expect(feeder.targetId()).toBe(null);
   expect(feeder.ingestDelta("fn", 1100)).toBe(1);
  });
 });
});

describe("incremental control filtering", () => {
 const controls = [
  "\x1b[31m", "\x9b31m",
  "\x1b]52;c;SECRET\x07", "\x1b]52;c;SECRET\x1b\\", "\x9d52;c;SECRET\x9c",
  "\x1bPSECRET\x1b\\", "\x90SECRET\x9c",
  "\x1bXSECRET\x1b\\", "\x98SECRET\x9c",
  "\x1b^SECRET\x1b\\", "\x9eSECRET\x9c",
  "\x1b_SECRET\x1b\\", "\x9fSECRET\x9c",
  "\x1b(B",
 ];
 for (const control of controls) {
  test(`all split boundaries consume ${JSON.stringify(control)} without sampling metadata`, () => {
   for (let split = 1; split < control.length; split++) {
    const { feeder } = makeFeeder([0]);
    expect(feeder.ingestDelta(control.slice(0, split), 0)).toBe(0);
    expect(feeder.ingestDelta(control.slice(split) + "ok", 500)).toBe(1);
    expect(feeder.pieces(80, 3).map(piece => piece.glyph)).toEqual(["ok"]);
   }
  });
 }
 test("one-character chunks consume payload and split ST with constant parser state", () => {
  const { feeder } = makeFeeder([0]);
  for (const char of "\x1b]52;c;" + "SECRET".repeat(2000) + "\x1b\\") {
   expect(feeder.ingestDelta(char, 0)).toBe(0);
  }
  expect(feeder.ingestDelta("ok", 500)).toBe(1);
  expect(glyphAt(feeder)).toBe("ok");
 });
 test("main and Fireside control modes are independent", () => {
  const { feeder } = makeFeeder([0]);
  expect(feeder.ingestDelta("\x1b]52;c;", 0, "main")).toBe(0);
  expect(feeder.ingestDelta("ok", 500, "fireside")).toBe(1);
  expect(feeder.ingestDelta("SECRET", 1000, "main")).toBe(0);
  expect(feeder.ingestDelta("\x1b[", 1000, "fireside")).toBe(0);
  expect(feeder.ingestDelta("\x07yes", 1000, "main")).toBe(1);
  expect(feeder.ingestDelta("31mnew", 1500, "fireside")).toBe(1);
  expect(feeder.pieces(80, 3).map(piece => piece.glyph)).toEqual(["ok", "yes", "new"]);
 });
 for (const blocked of ["admission", "rate", "cap", "fullness"] as const) {
  test(`control syntax evolves through ${blocked} rejection without backlog`, () => {
   const { feeder } = makeFeeder([0]);
   let now = 10000;
   if (blocked === "rate") feeder.ingestDelta("old", now);
   if (blocked === "cap") for (let i = 0; i < 10; i++) feeder.ingestDelta("old", i * 500);
   if (blocked === "fullness") {
    for (let i = 0; i < 5; i++) feeder.ingestDelta("old", i * 500);
    feeder.step(3000);
    for (let id = 1; id <= 5; id++) {
     feeder.beginMunch(id, 3000 + (id - 1) * 700);
     feeder.step(3000 + id * 700);
    }
    expect(feeder.phase()).toBe("satisfied");
    now = 6500;
   }
   expect(feeder.ingestDelta("\x1b]52;c;", now, "main", blocked !== "admission")).toBe(0);
   if (blocked === "cap") feeder.clear();
   if (blocked === "fullness") {
    feeder.step(now + 1200);
    feeder.step(now + 7200);
   }
   now += 8000;
   expect(feeder.ingestDelta("SECRET", now, "main")).toBe(0);
   expect(feeder.ingestDelta("\x07ok", now + 500, "main")).toBe(1);
   expect(feeder.pieces(80, 3).at(-1)?.glyph).toBe("ok");
  });
 }
 test("a discarded terminator releases its source even when sampling is blocked", () => {
  const { feeder } = makeFeeder([0]);
  feeder.ingestDelta("\x1b]52;c;", 0, "main");
  expect(feeder.ingestDelta("SECRET\x1b\\drop", 500, "main", false)).toBe(0);
  expect(feeder.ingestDelta("ok", 1000, "main")).toBe(1);
  expect(glyphAt(feeder)).toBe("ok");
 });
 for (const source of ["main", "fireside"] as const) {
  const other = source === "main" ? "fireside" : "main";
  for (const control of [
   { name: "OSC", prefix: "\x1b]52;c;", end: "SECRET\x07" },
   { name: "CSI", prefix: "\x1b[", end: "31m" },
  ]) {
   test(`live parser preview Cancel preserves ${source} ${control.name} prefix received during preview`, () => {
    const { feeder } = makeFeeder([0]);
    const restore = feeder.beginPreview();
    expect(feeder.ingestDelta(control.prefix, 0, source)).toBe(0);
    restore();
    expect(feeder.ingestDelta("ok", 500, other)).toBe(1);
    expect(feeder.ingestDelta(control.end, 1000, source)).toBe(0);
    expect(feeder.ingestDelta("yes", 1500, source)).toBe(1);
    expect(feeder.pieces(80, 3).map(piece => piece.glyph)).toEqual(["ok", "yes"]);
   });

   test(`live parser preview Cancel preserves ${source} ${control.name} terminator received during preview`, () => {
    const { feeder } = makeFeeder([0]);
    expect(feeder.ingestDelta(control.prefix, 0, source)).toBe(0);
    const restore = feeder.beginPreview();
    expect(feeder.ingestDelta(control.end, 0, source, false)).toBe(0);
    restore();
    expect(feeder.ingestDelta("ok", 500, source)).toBe(1);
    expect(feeder.ingestDelta("yes", 1000, other)).toBe(1);
    expect(feeder.pieces(80, 3).map(piece => piece.glyph)).toEqual(["ok", "yes"]);
   });

   test(`live parser preview Cancel preserves ${source} ${control.name} reset without resetting the other source`, () => {
    const { feeder } = makeFeeder([0]);
    feeder.ingestDelta(control.prefix, 0, source);
    feeder.ingestDelta("\x1b]52;c;", 0, other);
    const restore = feeder.beginPreview();
    feeder.resetSource(source);
    restore();
    expect(feeder.ingestDelta("ok", 500, source)).toBe(1);
    expect(feeder.ingestDelta("SECRET", 1000, other)).toBe(0);
    expect(feeder.ingestDelta("\x07yes", 1000, other)).toBe(1);
    expect(feeder.pieces(80, 3).map(piece => piece.glyph)).toEqual(["ok", "yes"]);
   });
  }
 }
});

describe("canonical feeder geometry", () => {
 test("compact projection cannot land food in a full world", () => {
  const { feeder } = makeFeeder([0.9]);
  feeder.ingestDelta("F", 0);
  feeder.pieces(20, 1);
  feeder.step(250);
  expect(feeder.pieces(80, 3)[0]).toMatchObject({ column: 72, row: 0, landed: false });
  feeder.pieces(0, 0);
  feeder.step(500);
  expect(feeder.pieces(80, 3)[0]).toMatchObject({ column: 72, row: 1, landed: false });
  expect(feeder.targetId()).toBeNull();
  feeder.step(700);
  expect(feeder.pieces(80, 3)[0]?.landed).toBe(true);
 });
 test("nearest selection compares reachable travel and keeps insertion-order ties", () => {
  const { feeder } = makeFeeder([0, 0.9, 0, 0.95]);
  feeder.setViewport(20, 3);
  feeder.ingestDelta("F", 0);
  feeder.ingestDelta("N", 500);
  feeder.step(1200, { position: 10, width: 10 });
  expect(feeder.targetId()).toBe(1);
 });
});
