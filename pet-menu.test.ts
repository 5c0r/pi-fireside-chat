import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PET_SETTINGS, BUILTIN_PETS, loadPetSettings, savePetSettings, resolvePetSprite, type PetSettings } from "./pet-data";
import { PetEngine, type PetClock } from "./pet-engine";
import { createPetMenu } from "./pet-menu";

const keys: Record<string, string> = { up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C", enter: "\r", escape: "\x1b", backspace: "\x7f", r: "r" };
const fieldLabels = ["Random pet", "Random color", "Surprise me", "Pet", "Name", "Color", "Size", "Speed", "Personality", "Placement", "Motion", "Food rain", "Custom sprite file", "Save preferences"];
function menu(options: {
 commit?: (value: typeof DEFAULT_PET_SETTINGS) => void;
 rows?: number;
 random?: () => number;
 key?: (data: string, key: string) => boolean;
 settings?: Partial<PetSettings>;
 engine?: PetEngine;
} = {}) {
 const settings: PetSettings = { ...DEFAULT_PET_SETTINGS, motion: "static", ...options.settings };
 const engine = options.engine ?? new PetEngine(settings, settings.pet === "custom" ? BUILTIN_PETS.miso : BUILTIN_PETS[settings.pet]);
 let closed = 0;
 const component = createPetMenu({
  settings, engine,
  rows: () => options.rows ?? 24,
  key: options.key ?? ((data, key) => data === keys[key]),
  clip: (text, width) => text.slice(0, Math.max(0, width)),
  color: (_palette, text) => text,
  redraw: () => { },
  commit: options.commit ?? (() => { }), done: () => { closed++; },
  random: options.random,
 });
 return {
  component, engine, closed: () => closed,
  key: (key: string) => component.handleInput(keys[key]),
  text: () => component.render(70).join("\n"),
  select(label: string) {
   for (const _ of fieldLabels) component.handleInput(keys.up);
   for (const _ of fieldLabels) {
    if (component.render(200).some(line => line === `> ${label}` || line.startsWith(`> ${label}: `))) return;
    component.handleInput(keys.down);
   }
   throw new Error(`Menu control not reachable: ${label}`);
  },
 };
}

function fakeClock(): PetClock & { advance(ms: number): void; fire(): void } {
 let now = 0;
 let next = 1;
 const timers = new Map<number, () => void>();
 return {
  now: () => now,
  setInterval: fn => { const id = next++; timers.set(id, fn); return id; },
  clearInterval: id => { timers.delete(id as number); },
  advance: ms => { now += ms; },
  fire: () => { for (const fn of [...timers.values()]) fn(); },
 };
}

/** A valid custom sprite whose compact frame is narrower than every builtin. */
function writeNarrowSprite(dir: string): string {
 const file = join(dir, "narrow.json");
 writeFileSync(file, JSON.stringify({
  version: 1, label: "Nub",
  compact: { walking: [["--)>"]], idle: [["-o-"]], sleep: [["-z-"]] },
  full: {
   walking: [["   ", "--)>", "   "]],
   idle: [["   ", "-o-", "   "]],
   sleep: [[" z ", " - ", " z "]],
  },
 }));
 return file;
}

/** Leading-space column offset of the pet in its first rendered row. */
const padding = (rows: string[]) => rows[0]?.match(/^ */)?.[0].length ?? 0;

describe("pet customization", () => {
 test("applies edited choices and a name through real persisted preferences", () => {
  const dir = mkdtempSync(join(tmpdir(), "fireside-menu-"));
  const ui = menu({ commit: value => savePetSettings(dir, value) });
  try {
   ui.select("Pet"); ui.key("right"); // Toast
   ui.select("Name"); ui.key("enter");
   for (let i = 0; i < 5; i++) ui.key("backspace");
   ui.component.handleInput("Biscuit"); ui.key("enter");
   ui.select("Color"); ui.key("right");
   ui.select("Save preferences");
   ui.key("enter");
   const saved = loadPetSettings(dir).settings;
   expect(saved.pet).toBe("toast");
   expect(saved.name).toBe("Biscuit");
   expect(saved.palette).toBe("amber");
   expect(ui.closed()).toBe(1);
  } finally { ui.component.dispose?.(); ui.engine.dispose(); rmSync(dir, { recursive: true, force: true }); }
 });
 test("Escape discards preview and never writes preferences", () => {
  let writes = 0;
  const ui = menu({ commit: () => { writes++; } });
  try {
   const original = ui.engine.render(70);
   ui.select("Pet"); ui.key("right");
   expect(ui.engine.render(70)).not.toEqual(original);
   ui.key("escape");
   expect(ui.engine.render(70)).toEqual(original);
   expect(writes).toBe(0);
   expect(ui.closed()).toBe(1);
  } finally { ui.component.dispose?.(); ui.engine.dispose(); }
 });
 test("invalid custom sprite blocks saving and remains recoverable", () => {
  let writes = 0;
  const ui = menu({ commit: () => { writes++; } });
  try {
   ui.select("Pet");
   for (const _ of Object.keys(BUILTIN_PETS)) ui.key("right"); // custom, no path
   ui.select("Save preferences");
   ui.key("enter");
   expect(writes).toBe(0);
   expect(ui.closed()).toBe(0);
   expect(ui.text()).toMatch(/custom|file/i);
   ui.select("Pet");
   ui.key("right"); // back to Miso
   ui.select("Save preferences");
   ui.key("enter");
   expect(writes).toBe(1);
   expect(ui.closed()).toBe(1);
  } finally { ui.component.dispose?.(); ui.engine.dispose(); }
 });
 test("short terminal keeps selected control visible and clips every row", () => {
  const ui = menu({ rows: 8 });
  try {
   ui.select("Save preferences");
   const lines = ui.component.render(24);
   expect(lines.length).toBeLessThanOrEqual(8);
   expect(lines.every(line => line.length <= 24)).toBe(true);
   expect(lines.join("\n")).toContain("Save");
  } finally { ui.component.dispose?.(); ui.engine.dispose(); }
 });
 test("save errors keep menu open and permit retry", () => {
  let attempts = 0;
  const ui = menu({ commit: () => { if (++attempts === 1) throw new Error("Read-only directory"); } });
  try {
   ui.select("Save preferences");
   ui.key("enter");
   expect(ui.closed()).toBe(0);
   expect(ui.text()).toContain("Read-only directory");
   ui.key("enter");
   expect(attempts).toBe(2);
   expect(ui.closed()).toBe(1);
  } finally { ui.component.dispose?.(); ui.engine.dispose(); }
 });
 test("save errors cannot inject terminal controls through menu text", () => {
  const ui = menu({ commit: () => { throw new Error("write failed: \u001b[2J\u009b0m\u202e"); } });
  try {
   ui.select("Save preferences");
   ui.key("enter");
   const errorRow = ui.component.render(200).at(-1) ?? "";
   const unsafeCodes = Array.from(errorRow).filter(char => /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(char)).map(char => char.codePointAt(0));
   expect(unsafeCodes).toEqual([]);
   expect(errorRow.includes("write failed:")).toBe(true);
   expect(errorRow.includes("\\u001b")).toBe(true);
   expect(ui.closed()).toBe(0);
  } finally { ui.component.dispose?.(); ui.engine.dispose(); }
 });
});

describe("pet randomization", () => {
 test("random pet previews the first eligible builtin and rerolls without closing or startup randomness", () => {
  let calls = 0;
  const ui = menu({ random: () => { calls++; return 0; } });
  try {
   const original = ui.engine.render(70);
   expect(calls).toBe(0);
   expect(ui.text()).toContain("> Random pet");
   ui.key("enter");
   expect(calls).toBe(1);
   expect(ui.text()).toContain("Pet: toast");
   expect(ui.text()).toContain("Name: Toast");
   expect(ui.engine.render(70)).not.toEqual(original);
   expect(ui.closed()).toBe(0);
   ui.key("enter");
   expect(calls).toBe(2);
   expect(ui.text()).toContain("Pet: miso");
   expect(ui.text()).toContain("Name: Miso");
   expect(ui.closed()).toBe(0);
  } finally { ui.component.dispose?.(); ui.engine.dispose(); }
 });
 test("random pet reaches the last eligible builtin", () => {
  const ui = menu({ random: () => 1 - Number.EPSILON });
  try {
   ui.select("Random pet"); ui.key("enter");
   expect(ui.text()).toContain("Pet: nori");
   expect(ui.text()).toContain("Name: Nori");
   expect(ui.closed()).toBe(0);
  } finally { ui.component.dispose?.(); ui.engine.dispose(); }
 });
 test("random colors use first and last curated choices and never change the pet", () => {
  const ui = menu({ random: () => 0 });
  const last = menu({ random: () => 1 - Number.EPSILON });
  try {
   ui.select("Random color"); ui.key("enter");
   expect(ui.text()).toContain("Color: amber");
   expect(ui.text()).toContain("Pet: miso");
   expect(ui.text()).toContain("Name: Miso");
   ui.key("enter");
   expect(ui.text()).toContain("Color: mint");
   expect(ui.closed()).toBe(0);
   last.select("Random color"); last.key("enter");
   expect(last.text()).toContain("Color: lavender");
   expect(last.text()).toContain("Pet: miso");
  } finally {
   ui.component.dispose?.(); ui.engine.dispose();
   last.component.dispose?.(); last.engine.dispose();
  }
 });
 test("Surprise me changes both choices and repeated Enter stays live", () => {
  const ui = menu({ random: () => 0 });
  try {
   ui.select("Surprise me"); ui.key("enter");
   expect(ui.text()).toContain("Pet: toast");
   expect(ui.text()).toContain("Color: amber");
   expect(ui.closed()).toBe(0);
   ui.key("enter");
   expect(ui.text()).toContain("Pet: miso");
   expect(ui.text()).toContain("Color: mint");
   expect(ui.closed()).toBe(0);
  } finally { ui.component.dispose?.(); ui.engine.dispose(); }
 });
 test("r uses the host key matcher outside editing but remains ordinary name and path text inside editing", () => {
  const ui = menu({ random: () => 0, key: (data, key) => key === "r" ? data === "host-r" : data === keys[key] });
  try {
   ui.component.handleInput("host-r");
   expect(ui.text()).toContain("Pet: toast");
   expect(ui.text()).toContain("Color: amber");
   ui.select("Name"); ui.key("enter");
   for (const _ of "Toast") ui.key("backspace");
   ui.component.handleInput("r");
   expect(ui.text()).toContain("Name: r_");
   expect(ui.text()).toContain("Pet: toast");
   ui.key("enter");
   expect(ui.text()).toContain("Name: r");
   ui.select("Custom sprite file"); ui.key("enter");
   ui.component.handleInput("r");
   expect(ui.text()).toContain("Custom sprite file: r_");
   ui.key("enter");
   expect(ui.text()).toContain("Custom sprite file: r");
   expect(ui.text()).toContain("Pet: toast");
   expect(ui.text()).toContain("Color: amber");
   expect(ui.closed()).toBe(0);
  } finally { ui.component.dispose?.(); ui.engine.dispose(); }
 });
 test("Save persists the exact rolled choices and preserves a custom name and unrelated settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "fireside-menu-random-"));
  let writes = 0;
  const settings: PetSettings = {
   ...DEFAULT_PET_SETTINGS, name: "Biscuit", nameFollowsPet: false, size: "compact", speed: "fast",
   personality: "sleepy", placement: "both", motion: "static", customFile: "/kept-local-path.json",
  };
  const ui = menu({ settings, random: () => 0, commit: value => { writes++; savePetSettings(dir, value); } });
  try {
   ui.select("Surprise me"); ui.key("enter");
   expect(ui.text()).toContain("Name: Biscuit");
   expect(writes).toBe(0);
   ui.select("Save preferences"); ui.key("enter");
   expect(writes).toBe(1);
   expect(loadPetSettings(dir).settings).toEqual({ ...settings, pet: "toast", palette: "amber" });
   expect(ui.closed()).toBe(1);
   const savedRows = ui.engine.render(70);
   ui.component.dispose?.();
   expect(ui.engine.render(70)).toEqual(savedRows);
  } finally { ui.component.dispose?.(); ui.engine.dispose(); rmSync(dir, { recursive: true, force: true }); }
 });
 test("Escape and external dispose discard rolled choices without writing", () => {
  for (const cancel of ["escape", "dispose"]) {
   let writes = 0;
   const ui = menu({ random: () => 0, commit: () => { writes++; } });
   try {
    const original = ui.engine.render(70);
    ui.select("Surprise me"); ui.key("enter");
    expect(ui.engine.render(70)).not.toEqual(original);
    if (cancel === "escape") ui.key("escape");
    else ui.component.dispose?.();
    expect(ui.engine.render(70)).toEqual(original);
    expect(writes).toBe(0);
    expect(ui.closed()).toBe(cancel === "escape" ? 1 : 0);
   } finally { ui.component.dispose?.(); ui.engine.dispose(); }
  }
 });
 test("Escape restores the exact custom sprite rows and position after a larger builtin preview", () => {
  const dir = mkdtempSync(join(tmpdir(), "fireside-menu-rollback-"));
  const clock = fakeClock();
  const settings: PetSettings = {
   ...DEFAULT_PET_SETTINGS, pet: "custom", customFile: writeNarrowSprite(dir),
   name: "Nub", nameFollowsPet: false, size: "compact", speed: "fast",
  };
  const resolved = resolvePetSprite(settings);
  const engine = new PetEngine(settings, resolved.sprite, clock);
  const off = engine.subscribe(() => { });
  try {
   expect(resolved.error).toBeUndefined();
   engine.render(60);
   for (let i = 0; i < 100 && padding(engine.render(60)) < 54; i++) {
    clock.advance(250); clock.fire();
   }
   expect(padding(engine.render(60))).toBeGreaterThanOrEqual(54);
   const original = engine.render(60);
   const ui = menu({ settings, engine, random: () => 0 });
   try {
    ui.key("enter");
    expect(engine.render(60)).not.toEqual(original);
    ui.key("escape");
    expect(engine.render(60)).toEqual(original);
   } finally { ui.component.dispose?.(); }
  } finally { off(); engine.dispose(); rmSync(dir, { recursive: true, force: true }); }
 });
 test("short terminal reaches every action and Save while clipping all rows", () => {
  const ui = menu({ rows: 8, random: () => 0 });
  try {
   for (const label of fieldLabels) {
    ui.select(label);
    const lines = ui.component.render(30);
    expect(lines.length).toBeLessThanOrEqual(8);
    expect(lines.every(line => line.length <= 30)).toBe(true);
    expect(lines.some(line => line === `> ${label}` || line.startsWith(`> ${label}: `))).toBe(true);
   }
   ui.key("enter");
   expect(ui.closed()).toBe(1);
  } finally { ui.component.dispose?.(); ui.engine.dispose(); }
 });
 test("random pet recovers an invalid custom selection with a builtin and permits Save", () => {
  let saved: PetSettings | undefined;
  const ui = menu({ settings: { pet: "custom", name: "Local name", nameFollowsPet: false, customFile: "" }, random: () => 0, commit: value => { saved = { ...value }; } });
  try {
   ui.select("Random pet"); ui.key("enter");
   expect(ui.text()).toContain("Pet: miso");
   expect(ui.text()).toContain("Name: Local name");
   ui.select("Save preferences"); ui.key("enter");
   expect(saved?.pet).toBe("miso");
   expect(saved?.name).toBe("Local name");
   expect(ui.closed()).toBe(1);
  } finally { ui.component.dispose?.(); ui.engine.dispose(); }
 });
});

describe("explicit naming intent", () => {
 test("editing a collision name remains custom across selections and Save/reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "fireside-name-intent-"));
  const ui = menu({ random: () => 0, commit: value => savePetSettings(dir, value) });
  try {
   ui.select("Name"); ui.key("enter");
   for (const _ of "Miso") ui.key("backspace");
   ui.component.handleInput("Toast"); ui.key("enter");
   ui.select("Pet"); ui.key("right"); ui.key("right");
   expect(ui.text()).toContain("Pet: mochi");
   expect(ui.text()).toContain("Name: Toast");
   ui.select("Save preferences"); ui.key("enter");
   const saved = loadPetSettings(dir).settings;
   const reopened = menu({ settings: saved, random: () => 0 });
   try {
    reopened.select("Random pet"); reopened.key("enter");
    expect(reopened.text()).toContain("Name: Toast");
    expect(saved.nameFollowsPet).toBe(false);
   } finally { reopened.component.dispose?.(); reopened.engine.dispose(); }
  } finally { ui.component.dispose?.(); ui.engine.dispose(); rmSync(dir, { recursive: true, force: true }); }
 });

 test("accepting an unchanged species-label name is still an explicit custom-name edit", () => {
  const ui = menu();
  try {
   ui.select("Name"); ui.key("enter"); ui.key("enter");
   ui.select("Pet"); ui.key("right");
   expect(ui.text()).toContain("Pet: toast");
   expect(ui.text()).toContain("Name: Miso");
  } finally { ui.component.dispose?.(); ui.engine.dispose(); }
 });

 test("Escape cancels name editing and whole-menu edits without changing default-follow intent", () => {
  const dir = mkdtempSync(join(tmpdir(), "fireside-name-cancel-"));
  savePetSettings(dir, { ...DEFAULT_PET_SETTINGS, motion: "static" });
  const ui = menu({ commit: value => savePetSettings(dir, value) });
  try {
   ui.select("Name"); ui.key("enter");
   ui.component.handleInput("custom"); ui.key("escape");
   ui.select("Pet"); ui.key("right");
   expect(ui.text()).toContain("Name: Toast");
   ui.select("Name"); ui.key("enter"); ui.key("enter");
   ui.key("escape");
   const saved = loadPetSettings(dir).settings;
   expect(saved.nameFollowsPet).toBe(true);
   const reopened = menu({ settings: saved });
   try {
    reopened.select("Pet"); reopened.key("right");
    expect(reopened.text()).toContain("Name: Toast");
   } finally { reopened.component.dispose?.(); reopened.engine.dispose(); }
  } finally { ui.component.dispose?.(); ui.engine.dispose(); rmSync(dir, { recursive: true, force: true }); }
 });
});
