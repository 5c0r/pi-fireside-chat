import type { PaneComponent, SidechatCommandContext, SidechatContext, ThemeLike } from "./api";
import { DEFAULT_PET_SETTINGS, PET_COLORS, formatPetError, loadPetSettings, parsePetSettings, resolvePetSprite, savePetSettings, type PetSettings } from "./pet-data";
import { PetEngine, type PetClock } from "./pet-engine";
import type { FeedSource } from "./pet-food";
import { createPetMenu } from "./pet-menu";

const WIDGET_KEY = "fireside-pet";
export function colorPet(theme: ThemeLike, palette: PetSettings["palette"], text: string): string {
 return palette === "theme" ? theme.fg("accent", text) : `\x1b[38;2;${PET_COLORS[palette]}m${text}\x1b[39m`;
}

/** Owns host resources; the engine owns only animation state and its one timer. */
export class PetController {
 settings: PetSettings = { ...DEFAULT_PET_SETTINGS };
 private engine?: PetEngine;
 private ctx?: SidechatContext;
 private directory?: string;
 private removeWidget?: () => void;
 private menuAbort?: AbortController;
 private closeMenu?: () => void;
 private widgetGeneration = 0;
 private readonly surfaceSubscriptions = new Map<() => void, (() => void) | undefined>();

 constructor(private readonly agentDir: () => string, private readonly clock?: PetClock) { }

 ensure(ctx: SidechatContext): void {
  // RPC exposes hasUI but never mounts component factories.
  if (ctx.mode !== "tui" || !ctx.hasUI || typeof ctx.ui.setWidget !== "function") return;
  if (this.engine) {
   if (!this.removeWidget && this.settings.placement !== "fireside" && this.settings.motion !== "hidden") this.mountMain();
   return;
  }
  this.ctx = ctx;
  try {
   this.directory = this.agentDir();
   const loaded = loadPetSettings(this.directory);
   this.settings = loaded.settings;
   if (loaded.error) ctx.ui.notify(loaded.error, "warning");
   const resolved = resolvePetSprite(this.settings);
   if (resolved.error) ctx.ui.notify(resolved.error, "warning");
   this.engine = new PetEngine(this.settings, resolved.sprite, this.clock);
   for (const redraw of this.surfaceSubscriptions.keys()) {
    this.surfaceSubscriptions.set(redraw, this.engine.subscribe(redraw, "fireside"));
   }
   this.mountMain();
  } catch (cause) {
   ctx.ui.notify(`Fireside pet: ${formatPetError(cause)}`, "error");
  }
 }

 reset(ctx: SidechatContext): void {
  this.shutdown();
  this.ensure(ctx);
 }

 shutdown(): void {
  this.widgetGeneration++;
  this.closeMenu?.();
  this.closeMenu = undefined;
  this.menuAbort?.abort();
  this.menuAbort = undefined;
  this.removeWidget?.();
  this.removeWidget = undefined;
  this.ctx?.ui.setWidget?.(WIDGET_KEY, undefined);
  for (const redraw of this.surfaceSubscriptions.keys()) {
   this.surfaceSubscriptions.get(redraw)?.();
   this.surfaceSubscriptions.set(redraw, undefined);
  }
  this.engine?.dispose();
  this.engine = undefined;
  this.ctx = undefined;
  this.directory = undefined;
 }

 /** Replacing a widget is a settings change, never an animation frame. */
 private mountMain(): void {
  const ctx = this.ctx;
  const engine = this.engine;
  if (!ctx || !engine) return;
  const generation = ++this.widgetGeneration;
  this.removeWidget?.();
  this.removeWidget = undefined;
  if (this.settings.placement === "fireside" || this.settings.motion === "hidden") {
   ctx.ui.setWidget?.(WIDGET_KEY, undefined);
   return;
  }
  ctx.ui.setWidget?.(WIDGET_KEY, (tui, theme) => {
   let disposed = false;
   const unsubscribe = engine.subscribe(() => { if (!disposed) tui.requestRender(); });
   const unobserve = ctx.ui.onTerminalInput?.(data => {
    // This observes terminal input activity, not editor identity or text changes.
    // Never return consume/data or retain the raw input.
    if (!disposed && (/^[^\x00-\x1f\x7f-\x9f]+$/u.test(data) || data === "\x7f" || data.startsWith("\x1b[200~"))) {
     engine.activity("typing");
    }
    return undefined;
   });
   const dispose = () => {
    if (disposed) return;
    disposed = true;
    unobserve?.();
    unsubscribe();
    if (this.widgetGeneration === generation) this.removeWidget = undefined;
    // The host can clear widgets before an earlier extension cancels switching.
    // One guarded microtask restores the still-owned widget, never a timer loop.
    queueMicrotask(() => {
     if (this.widgetGeneration === generation && this.engine === engine) this.mountMain();
    });
   };
   this.removeWidget = dispose;
   return {
    render: (width: number) => engine.render(width, (tui.terminal?.rows ?? process.stdout.rows ?? 24) < 14 ? 1 : 3)
     .map(line => colorPet(theme, this.settings.palette, line)),
    invalidate() { },
    dispose,
   };
  }, { placement: "aboveEditor" });
 }

 apply(settings: PetSettings): void {
  if (!this.engine || !this.directory) throw new Error("Pet UI is unavailable outside an interactive TUI.");
  const valid = parsePetSettings(settings);
  const resolved = resolvePetSprite(valid);
  if (resolved.error) throw new Error(resolved.error);
  savePetSettings(this.directory, valid);
  this.settings = valid;
  this.engine.update(valid, resolved.sprite);
  this.mountMain();
 }

 activity(kind: "typing" | "reply"): void { this.engine?.activity(kind); }

 /** One visible assistant delta from either producer; engine owns sampling bounds. */
 feedDelta(text: string, source: FeedSource = "main"): number { return this.engine?.feedDelta(text, source) ?? 0; }

 resetFeed(source: FeedSource): void { this.engine?.resetFeed(source); }

 subscribe(redraw: () => void): () => void {
  const subscription = () => redraw();
  this.surfaceSubscriptions.set(subscription, this.engine?.subscribe(subscription, "fireside"));
  return () => {
   this.surfaceSubscriptions.get(subscription)?.();
   this.surfaceSubscriptions.delete(subscription);
  };
 }

 renderFireside(width: number, maxRows: number, theme: ThemeLike): string[] {
  if (!this.engine) return [];
  const rows = this.settings.placement === "main" ? 0 : maxRows;
  return this.engine.render(width, rows, "fireside").map(line => colorPet(theme, this.settings.palette, line));
 }

 async configure(ctx: SidechatCommandContext, key: (data: string, key: string) => boolean,
  clip: (text: string, width: number) => string): Promise<void> {
  this.ensure(ctx);
  const engine = this.engine;
  if (!engine) { ctx.ui.notify("Fireside pets need an interactive TUI.", "warning"); return; }
  if (this.menuAbort) { ctx.ui.notify("Fireside pet settings are already open.", "info"); return; }
  const abort = new AbortController();
  this.menuAbort = abort;
  let closeMenu: (() => void) | undefined;
  try {
   await ctx.ui.custom<void>((tui, theme, _keys, done) => {
    const menu = createPetMenu({
     settings: this.settings, engine,
     rows: () => tui.terminal?.rows ?? process.stdout.rows ?? 24,
     key, clip,
     color: (palette, text) => colorPet(theme, palette, text),
     redraw: () => tui.requestRender(),
     commit: settings => {
      if (this.engine !== engine || abort.signal.aborted) throw new Error("Session changed; reopen pet settings.");
      this.apply(settings);
     },
     done: () => closeMenu?.(),
    }) satisfies PaneComponent;
    let closed = false;
    closeMenu = () => {
     if (closed) return;
     closed = true;
     menu.dispose();
     done();
    };
    this.closeMenu = closeMenu;
    if (abort.signal.aborted) closeMenu();
    return menu;
   }, {
    overlay: true,
    overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 },
    signal: abort.signal,
   });
  } finally {
   if (this.menuAbort === abort) this.menuAbort = undefined;
   if (this.closeMenu === closeMenu) this.closeMenu = undefined;
  }
 }
}
