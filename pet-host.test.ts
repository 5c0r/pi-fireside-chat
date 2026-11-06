import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PetController } from "./pet-host";
import type { PaneComponent, SidechatContext } from "./api";
import type { PetClock } from "./pet-engine";

function harness(clock?: PetClock) {
 const directory = mkdtempSync(join(tmpdir(), "fireside-host-"));
 let widget: PaneComponent | undefined;
 let input: ((data: string) => unknown) | undefined;
 let released = 0;
 const theme = { fg: (_: string, value: string) => value, bg: (_: string, value: string) => value };
 const ctx = {
  hasUI: true,
  mode: "tui",
  ui: {
   notify: () => { },
   onTerminalInput: (fn: typeof input) => { input = fn; return () => { input = undefined; released++; }; },
   setWidget: (_: string, factory: ((tui: unknown, theme: unknown) => PaneComponent) | undefined) => {
    widget?.dispose?.();
    widget = factory?.({ requestRender() { } }, theme);
   },
  },
 } as unknown as SidechatContext;
 const controller = new PetController(() => directory, clock);
 return {
  directory, ctx, controller, theme, widget: () => widget, input: () => input, released: () => released,
  close() { controller.shutdown(); rmSync(directory, { recursive: true, force: true }); }
 };
}

test("main widget preserves input and removes listener on replacement and shutdown", () => {
 const ui = harness();
 try {
  ui.controller.ensure(ui.ctx);
  const first = ui.widget();
  expect(first?.render(40).join("\n")).toMatch(/Miso/);
  expect(ui.input()?.("draft")).toBeUndefined();
  ui.controller.reset(ui.ctx);
  expect(ui.released()).toBe(1);
  expect(ui.widget()).not.toBe(first);
  // Stale widget disposal cannot tear down the replacement's input observer.
  first?.dispose?.();
  expect(ui.input()).toBeDefined();
  ui.controller.shutdown();
  expect(ui.widget()).toBeUndefined();
  expect(ui.input()).toBeUndefined();
  expect(ui.released()).toBe(2);
 } finally { ui.close(); }
});

test("hidden mode tears down main widget while Fireside placement renders above its editor", () => {
 const ui = harness();
 try {
  ui.controller.ensure(ui.ctx);
  ui.controller.apply({ ...ui.controller.settings, placement: "fireside", motion: "static" });
  expect(ui.widget()).toBeUndefined();
  expect(ui.controller.renderFireside(40, 3, ui.theme).join("\n")).toContain("Miso");
  ui.controller.apply({ ...ui.controller.settings, motion: "hidden" });
  expect(ui.controller.renderFireside(40, 3, ui.theme)).toEqual([]);
  expect(ui.input()).toBeUndefined();
 } finally { ui.close(); }
});

test("settings survive a controller restart without entering conversation history", () => {
 const ui = harness();
 try {
  ui.controller.ensure(ui.ctx);
  ui.controller.apply({ ...ui.controller.settings, pet: "toast", name: "Biscuit", nameFollowsPet: false, motion: "static" });
  ui.controller.shutdown();
  const restarted = new PetController(() => ui.directory);
  try {
   restarted.ensure(ui.ctx);
   expect(restarted.settings.pet).toBe("toast");
   expect(ui.widget()?.render(50).join("\n")).toContain("Biscuit");
  } finally { restarted.shutdown(); }
 } finally { ui.close(); }
});

test("headless hosts and legacy fake UI do not initialize pet IO or timers", () => {
 let resolved = 0;
 const controller = new PetController(() => { resolved++; throw new Error("must stay lazy"); });
 controller.ensure({ hasUI: false, ui: {} } as SidechatContext);
 controller.ensure({ hasUI: true, ui: {} } as SidechatContext);
 controller.ensure({ ...harnessContextForRpc(), mode: "rpc" } as SidechatContext);
 expect(resolved).toBe(0);
 controller.shutdown();
});

function harnessContextForRpc() {
 return { hasUI: true, ui: { setWidget() { throw new Error("RPC must never mount widgets"); } } };
}

test("an open Fireside surface rebinds animation across a session reset", () => {
 let now = 0;
 let next = 0;
 const callbacks = new Map<number, () => void>();
 const clock: PetClock = {
  now: () => now,
  setInterval: fn => { callbacks.set(++next, fn); return next; },
  clearInterval: id => { callbacks.delete(id as number); },
 };
 const ui = harness(clock);
 try {
  ui.controller.ensure(ui.ctx);
  ui.controller.apply({ ...ui.controller.settings, placement: "fireside", speed: "fast" });
  ui.controller.renderFireside(40, 3, ui.theme);
  let paints = 0;
  const unsubscribe = ui.controller.subscribe(() => { paints++; });
  ui.controller.reset(ui.ctx);
  ui.controller.renderFireside(40, 3, ui.theme);
  const before = paints;
  now += 1000;
  for (const callback of callbacks.values()) callback();
  expect(paints).toBeGreaterThan(before);
  unsubscribe();
  expect(callbacks.size).toBe(0);
 } finally { ui.close(); }
 expect(callbacks.size).toBe(0);
});

test("host-cleared widgets restore once even when another extension cancels session switching", async () => {
 const ui = harness();
 try {
  ui.controller.ensure(ui.ctx);
  const first = ui.widget();
  ui.ctx.ui.setWidget!("fireside-pet", undefined);
  expect(ui.input()).toBeUndefined();
  await Promise.resolve();
  expect(ui.widget()).toBeDefined();
  expect(ui.widget()).not.toBe(first);
  expect(ui.input()).toBeDefined();
  ui.controller.shutdown();
  await Promise.resolve();
  expect(ui.widget()).toBeUndefined();
  expect(ui.input()).toBeUndefined();
 } finally { ui.close(); }
});

test("session reset explicitly closes a menu when the host ignores custom UI abort signals", async () => {
 const ui = harness();
 let closed = 0;
 let menu: PaneComponent | undefined;
 let release: (() => void) | undefined;
 ui.ctx.ui.custom = async factory => {
  const pending = Promise.withResolvers<never>();
  release = () => { closed++; pending.resolve(undefined as never); };
  const component = factory({ requestRender() { } }, ui.theme, undefined, () => release?.());
  menu = component as PaneComponent;
  return pending.promise;
 };
 try {
  const configured = ui.controller.configure(ui.ctx, () => false, (line, width) => line.slice(0, width));
  expect(menu).toBeDefined();
  ui.controller.reset(ui.ctx);
  expect(closed).toBe(1);
  await configured;
  expect(ui.widget()).toBeDefined();
 } finally { release?.(); ui.close(); }
});

test("host initialization errors escape terminal controls before notification", () => {
 const ui = harness();
 const messages: string[] = [];
 ui.ctx.ui.notify = message => { messages.push(message); };
 const controller = new PetController(() => { throw new Error("agent directory: \u001b[2J\u009b0m\u202e"); });
 try {
  controller.ensure(ui.ctx);
  const message = messages[0] ?? "";
  const unsafeCodes = Array.from(message).filter(char => /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(char)).map(char => char.codePointAt(0));
  expect(unsafeCodes).toEqual([]);
  expect(message.includes("agent directory:")).toBe(true);
  expect(message.includes("\\u001b")).toBe(true);
 } finally { controller.shutdown(); ui.close(); }
});
