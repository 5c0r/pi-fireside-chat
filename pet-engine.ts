import type { PetSettings, PetSprite, SpriteFrames } from "./pet-data";
import { Feeder, type FeedSource, type FoodPiece } from "./pet-food";

export interface PetClock {
 now(): number;
 setInterval(fn: () => void, ms: number): unknown;
 clearInterval(handle: unknown): void;
}

const SYSTEM_CLOCK: PetClock = {
 now: () => Date.now(),
 setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
 clearInterval: (handle) =>
  globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>),
};

const TICK_MS = 250;
const MAX_STEP_MS = 5_000;
const TYPING_PAUSE_MS = 1_500;
const REPLY_WAKE_MS = 10_000;
const SPEED = { slow: 3, normal: 7, fast: 14 } as const;
const RUN_SPEED = 26;
const MUNCH_GLYPHS = ["*", "~", "*"];
const WALK_FRAME_MS = { slow: 400, normal: 250, fast: 150 } as const;
const IDLE_FRAME_MS = { calm: 600, playful: 250, sleepy: 900 } as const;
const SLEEP_AFTER_MS = { calm: 20_000, playful: 45_000, sleepy: 8_000 } as const;
const MIRRORS: Readonly<Record<string, string>> = {
 "(": ")", ")": "(", "[": "]", "]": "[", "{": "}", "}": "{",
 "<": ">", ">": "<", "/": "\\", "\\": "/",
};
const NOOP = () => { };
type Pose = keyof SpriteFrames;
type PetSurface = "main" | "fireside" | "preview";
type Subscription = { redraw: () => void; surface: PetSurface };
type Viewport = { columns: number; rows: number };
type RenderCache = {
 width: number;
 position: number;
 frame: string[];
 name: string;
 rows: string[];
};

function dimensions(frames: SpriteFrames): number {
 let width = 0;
 for (const pose of [frames.walking, frames.idle, frames.sleep]) {
  for (const frame of pose) {
   for (const row of frame) width = Math.max(width, row.length);
  }
 }
 return width;
}

function mirrorWalking(frames: string[][]): string[][] {
 return frames.map((frame) => frame.map((row) => {
  let mirrored = "";
  for (let i = row.length - 1; i >= 0; i--) {
   mirrored += MIRRORS[row[i]] ?? row[i];
  }
  return mirrored;
 }));
}

/**
 * One animation shared by all placements. Owned drawable surfaces determine
 * canonical geometry; rendering projects that world without changing physics.
 * A disposed engine is permanently inert; create a new instance per session.
 */
export class PetEngine {
 private settings: PetSettings;
 private sprite: PetSprite;
 private readonly clock: PetClock;
 private readonly subscribers = new Set<Subscription>();
 private viewports = new Map<PetSurface, Viewport>();
 private disposed = false;
 private timerRunning = false;
 private timerHandle: unknown;
 private timerEpoch = 0;
 private lastTick: number;
 private activityAt: number;
 private typingUntil = -Infinity;
 private replyUntil = -Infinity;
 private pose: Pose;
 private frameMs = 0;
 private position = 0;
 private direction: 1 | -1 = 1;
 private viewportWidth = 80;
 private compactWidth: number;
 private fullWidth: number;
 private viewportFull: boolean;
 private compactLeft: string[][];
 private fullLeft: string[][];
 private name: string;
 private cache: RenderCache | undefined;
 private readonly feeder: Feeder;
 private foodCache: { base: string[]; key: string; rows: string[] } | undefined;
 private chaseTargetId: number | null = null;

 constructor(
  settings: PetSettings,
  sprite: PetSprite,
  clock: PetClock = SYSTEM_CLOCK,
  feeder: Feeder = new Feeder(clock),
 ) {
  this.settings = { ...settings };
  this.sprite = sprite;
  this.clock = clock;
  this.feeder = feeder;
  this.activityAt = this.lastTick = clock.now();
  this.pose = settings.motion === "animated" ? "walking" : "idle";
  this.viewportFull = settings.size === "full";
  this.compactWidth = dimensions(sprite.compact);
  this.fullWidth = dimensions(sprite.full);
  this.compactLeft = mirrorWalking(sprite.compact.walking);
  this.fullLeft = mirrorWalking(sprite.full.walking);
  this.name = this.safeName(settings.name);
 }

 update(settings: PetSettings, sprite: PetSprite): void {
  if (this.disposed) return;
  const motionChanged = this.settings.motion !== settings.motion;
  const foodDisabled = settings.motion !== "animated" || !settings.foodRain;
  if (foodDisabled) {
   this.feeder.clear();
   this.chaseTargetId = null;
  }
  if (sprite !== this.sprite) {
   this.compactWidth = dimensions(sprite.compact);
   this.fullWidth = dimensions(sprite.full);
   this.compactLeft = mirrorWalking(sprite.compact.walking);
   this.fullLeft = mirrorWalking(sprite.full.walking);
  }
  this.settings = { ...settings };
  this.sprite = sprite;
  this.name = this.safeName(settings.name);
  this.syncViewport();
  if (motionChanged) {
   this.pose = settings.motion === "animated" ? "walking" : "idle";
   this.frameMs = 0;
   this.activityAt = this.lastTick = this.clock.now();
   this.typingUntil = this.replyUntil = -Infinity;
  }
  this.clampPosition();
  this.cache = undefined;
  this.foodCache = undefined;
  this.syncTimer();
  this.notify();
 }

 /** Capture the actual preview baseline, including animation state that update() may clamp or replace. */
 beginPreview(): () => void {
  if (this.disposed) return NOOP;
  const capturedAt = this.clock.now();
  const rollbackFeeder = this.feeder.beginPreview();
  const state = {
   settings: this.settings, sprite: this.sprite,
   compactWidth: this.compactWidth, fullWidth: this.fullWidth,
   compactLeft: this.compactLeft, fullLeft: this.fullLeft, name: this.name,
   pose: this.pose, frameMs: this.frameMs, position: this.position, direction: this.direction,
   viewportWidth: this.viewportWidth, viewportFull: this.viewportFull, cache: this.cache,
   lastTick: this.lastTick, activityAt: this.activityAt,
   typingUntil: this.typingUntil, replyUntil: this.replyUntil,
   chaseTargetId: this.chaseTargetId, foodCache: this.foodCache,
   viewports: new Map([...this.viewports].map(([surface, viewport]) => [surface, { ...viewport }])),
  };
  let restored = false;
  return () => {
   if (restored || this.disposed) return;
   restored = true;
   const elapsed = Math.max(0, this.clock.now() - capturedAt);
   rollbackFeeder();
   Object.assign(this, state, {
    lastTick: state.lastTick + elapsed,
    activityAt: state.activityAt + elapsed,
    typingUntil: state.typingUntil + elapsed,
    replyUntil: state.replyUntil + elapsed,
   });
   this.syncViewport();
   this.syncTimer();
   this.notify();
  };
 }


 subscribe(redraw: () => void, surface: PetSurface = "main"): () => void {
  if (this.disposed) return NOOP;
  const subscription = { redraw, surface };
  this.subscribers.add(subscription);
  this.syncViewport();
  this.syncTimer();
  let active = true;
  return () => {
   if (!active) return;
   active = false;
   this.subscribers.delete(subscription);
   if (![...this.subscribers].some(item => item.surface === surface)) this.viewports.delete(surface);
   this.syncViewport();
   this.syncTimer();
  };
 }

 /** One visible assistant delta becomes at most one bounded piece of food. */
 feedDelta(text: string, source: FeedSource = "main"): number {
  if (this.disposed) return 0;
  const now = this.clock.now();
  const admitted = this.viewportWidth > 0 && this.subscribers.size > 0
   && this.settings.motion === "animated" && this.settings.foodRain && now >= this.typingUntil;
  const spawned = this.feeder.ingestDelta(text, now, source, admitted);
  if (spawned > 0) {
   this.foodCache = undefined;
   this.notify();
  }
  return spawned;
 }

 resetFeed(source: FeedSource): void {
  this.feeder.resetSource(source);
 }

 activity(kind: "typing" | "reply"): void {
  if (this.disposed || this.settings.motion !== "animated") return;
  const now = this.clock.now();
  const phase = this.settings.foodRain ? this.feeder.phase() : "idle";
  const nextPose = phase === "digesting" ? "sleep"
   : phase === "satisfied" || phase === "munching" || kind === "typing" || now < this.typingUntil
    ? "idle" : "walking";
  const changed = this.pose !== nextPose;
  this.activityAt = now;
  if (kind === "typing") {
   this.typingUntil = now + TYPING_PAUSE_MS;
   this.lastTick = now;
  } else {
   this.replyUntil = now + REPLY_WAKE_MS;
  }
  this.pose = nextPose;
  if (changed) {
   this.frameMs = 0;
   this.foodCache = undefined;
   this.notify();
  }
 }

 render(width: number, maxRows = 3, surface: PetSurface = "main"): string[] {
  width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  maxRows = Number.isFinite(maxRows) ? Math.max(0, Math.floor(maxRows)) : 0;
  const full = this.settings.size === "full" && maxRows >= 3;
  this.viewports.set(surface, { columns: width, rows: maxRows === 0 ? 0 : full ? 3 : 1 });
  this.syncViewport();
  if (this.settings.motion === "hidden" || width === 0 || maxRows === 0) return [];
  const spriteWidth = full ? this.fullWidth : this.compactWidth;
  const position = Math.round(Math.min(this.position, Math.max(0, width - spriteWidth)));
  const frames = full ? this.sprite.full : this.sprite.compact;
  const index = this.frameIndex(full);
  const frame = this.pose === "walking" && this.direction === -1
   ? (full ? this.fullLeft : this.compactLeft)[index]
   : frames[this.pose][index];
  const name = this.name && position + spriteWidth + 1 + this.name.length <= width ? this.name : "";
  let base: string[];
  if (this.cache?.width === width && this.cache.position === position
   && this.cache.frame === frame && this.cache.name === name) {
   base = this.cache.rows;
  } else {
   const prefix = " ".repeat(position);
   const available = width - position;
   base = frame.map((row, i) => {
    let body = row.slice(0, available).trimEnd();
    if (name && i === frame.length - 1) body = body.padEnd(spriteWidth) + " " + name;
    return prefix + body;
   });
   this.cache = { width, position, frame, name, rows: base };
  }
  const feeding = this.settings.foodRain && this.settings.motion === "animated";
  const food = feeding ? this.feeder.pieces(width, full ? 3 : 1) : [];
  const munchGlyph = feeding && this.feeder.phase() === "munching" && this.chaseTargetId !== null
   ? MUNCH_GLYPHS[Math.floor(this.frameMs / WALK_FRAME_MS.fast) % MUNCH_GLYPHS.length] : "";
  if (food.length === 0 && !munchGlyph) return base;
  const key = this.foodState(food);
  if (this.foodCache?.base === base && this.foodCache.key === key) return this.foodCache.rows;
  const cells = base.map(row => row.padEnd(width, " ").split(""));
  if (munchGlyph) {
   const row = cells[full ? 0 : cells.length - 1];
   const right = position + spriteWidth + 1 + (!full && name ? name.length + 1 : 0);
   const place = (text: string): boolean => {
    for (let candidate = 0; candidate < 3; candidate++) {
     const start = candidate === 0 ? right : candidate === 1 ? position - text.length - 1
      : full ? position + Math.floor((spriteWidth - text.length) / 2) : -1;
     if (start < 0 || start + text.length > width) continue;
     let clear = true;
     for (let i = 0; i < text.length; i++) {
      if (row[start + i] !== " ") { clear = false; break; }
     }
     if (!clear) continue;
     for (let i = 0; i < text.length; i++) row[start + i] = text[i];
     return true;
    }
    return false;
   };
   if (!place(munchGlyph + " nom")) place(munchGlyph);
  }
  const labelStart = position + spriteWidth;
  const labelEnd = labelStart + 1 + name.length;
  for (const piece of food) {
   const row = cells[piece.row];
   if (!row) continue;
   const start = Math.min(piece.column, Math.max(0, width - piece.glyph.length));
   for (let i = 0; i < piece.glyph.length && start + i < width; i++) {
    const column = start + i;
    // Keep the label separator and spaces inside a pet name intact.
    if (name && piece.row === cells.length - 1 && column >= labelStart && column < labelEnd) continue;
    if (row[column] === " ") row[column] = piece.glyph[i];
   }
  }
  const rows = cells.map(row => row.join("").trimEnd());
  this.foodCache = { base, key, rows };
  return rows;
 }
 dispose(): void {
  if (this.disposed) return;
  this.disposed = true;
  this.subscribers.clear();
  this.viewports.clear();
  this.feeder.clear();
  this.feeder.resetSource("main");
  this.feeder.resetSource("fireside");
  this.chaseTargetId = null;
  this.foodCache = undefined;
  this.stopTimer();
 }

 private safeName(name: string): string {
  const printable = name.replace(/[\x00-\x1f\x7f]/g, "");
  // No terminal-width guess for combining marks, wide glyphs, or emoji.
  return /[^\x20-\x7e]/.test(printable) ? "" : printable;
 }

 /** A subscribed but zero-row surface cannot admit or consume invisible meals. */
 private syncViewport(): void {
  let columns = 0;
  let rows = 0;
  if (this.settings.motion !== "hidden") {
   for (const subscription of this.subscribers) {
    const view = this.viewports.get(subscription.surface);
    if (!view || view.columns === 0 || view.rows === 0) continue;
    columns = Math.max(columns, view.columns);
    rows = Math.max(rows, this.settings.size === "full" && view.rows >= 3 ? 3 : 1);
   }
  }
  this.viewportWidth = columns;
  this.viewportFull = rows === 3;
  this.feeder.setViewport(columns, rows);
  if (columns === 0 || rows === 0) {
   this.feeder.clear();
   this.chaseTargetId = null;
   this.foodCache = undefined;
  }
  this.clampPosition();
 }

 private clampPosition(): void {
  const spriteWidth = this.viewportFull ? this.fullWidth : this.compactWidth;
  this.position = Math.min(Math.max(0, this.viewportWidth - spriteWidth), Math.max(0, this.position));
 }

 private frameIndex(full: boolean): number {
  if (this.settings.motion !== "animated") return 0;
  const walkPeriod = this.settings.foodRain && this.feeder.phase() === "chasing"
   ? WALK_FRAME_MS.fast : WALK_FRAME_MS[this.settings.speed];
  const period = this.pose === "walking" ? walkPeriod
   : this.pose === "idle" ? IDLE_FRAME_MS[this.settings.personality] : 1_500;
  const frames = (full ? this.sprite.full : this.sprite.compact)[this.pose];
  return Math.floor(this.frameMs / period) % frames.length;
 }

 private syncTimer(): void {
  const wanted = !this.disposed && this.settings.motion === "animated" && this.subscribers.size > 0;
  if (!wanted) {
   this.stopTimer();
  } else if (!this.timerRunning) {
   this.timerRunning = true;
   this.lastTick = this.clock.now();
   const epoch = ++this.timerEpoch;
   this.timerHandle = this.clock.setInterval(() => {
    if (this.disposed || !this.timerRunning || epoch !== this.timerEpoch) return;
    this.tick();
   }, TICK_MS);
  }
 }

 private stopTimer(): void {
  if (!this.timerRunning) return;
  this.timerRunning = false;
  this.timerEpoch++;
  this.clock.clearInterval(this.timerHandle);
  this.timerHandle = undefined;
 }

 private tick(): void {
  const beforePosition = Math.round(this.position);
  const beforeDirection = this.direction;
  const beforePose = this.pose;
  const beforeCompact = this.frameIndex(false);
  const beforeFull = this.frameIndex(true);
  const foodRows = this.viewportFull ? 3 : 1;
  const beforeFood = this.foodState(this.feeder.pieces(this.viewportWidth, foodRows));
  const now = this.clock.now();
  const previousTick = this.lastTick;
  const elapsed = Math.min(MAX_STEP_MS, Math.max(0, now - previousTick));
  this.lastTick = now;

  this.feeder.step(now, {
   position: this.position, width: this.viewportFull ? this.fullWidth : this.compactWidth,
  });
  const feeding = this.settings.motion === "animated" && this.settings.foodRain;
  const phase = feeding ? this.feeder.phase() : "idle" as const;
  const food = this.feeder.pieces(this.viewportWidth, foodRows);
  const targetPiece = phase === "chasing" || phase === "munching"
   ? food.find(piece => piece.id === this.feeder.targetId()) : undefined;

  if (phase === "digesting") {
   this.chaseTargetId = null;
   this.pose = "sleep";
  } else if (phase === "satisfied") {
   this.chaseTargetId = null;
   this.pose = "idle";
  } else if (phase === "munching" && targetPiece) {
   this.pose = "idle";
   this.chaseTargetId = targetPiece.id;
  } else if (phase === "chasing" && targetPiece) {
   this.chaseTargetId = targetPiece.id;
   this.pose = now < this.typingUntil ? "idle" : "walking";
   const spriteWidth = this.viewportFull ? this.fullWidth : this.compactWidth;
   const targetCenter = targetPiece.column + targetPiece.glyph.length / 2;
   const destination = Math.max(0, Math.min(this.viewportWidth - spriteWidth, targetCenter - spriteWidth / 2));
   const distance = Math.abs(destination - this.position);
   if (destination !== this.position) this.direction = destination > this.position ? 1 : -1;
   // Typing pauses the chase, never the falling food.
   if (now >= this.typingUntil) {
    const movingMs = Math.min(elapsed, Math.max(0, now - Math.max(previousTick, this.typingUntil)));
    const advance = Math.min(distance, RUN_SPEED * movingMs / 1_000);
    this.position += Math.sign(destination - this.position) * advance;
    if (distance - advance <= 0.5) {
     this.feeder.beginMunch(targetPiece.id, now);
     this.pose = "idle";
    }
   }
  } else {
   this.chaseTargetId = null;
   this.pose = now < this.typingUntil ? "idle"
    : now - this.activityAt >= SLEEP_AFTER_MS[this.settings.personality] && now >= this.replyUntil
     ? "sleep" : "walking";
  }
  this.frameMs = this.pose === beforePose ? this.frameMs + elapsed : 0;
  if (this.pose === "walking" && phase !== "chasing") {
   // A typing hold that expires between ticks contributes no catchup motion.
   const movingMs = Math.min(elapsed, Math.max(0, now - Math.max(previousTick, this.typingUntil)));
   const spriteWidth = this.viewportFull ? this.fullWidth : this.compactWidth;
   const edge = Math.max(0, this.viewportWidth - spriteWidth);
   const next = this.position + this.direction * SPEED[this.settings.speed] * movingMs / 1_000;
   if (edge === 0) {
    this.position = 0;
   } else if (next >= edge) {
    this.position = edge;
    this.direction = -1;
   } else if (next <= 0) {
    this.position = 0;
    this.direction = 1;
   } else {
    this.position = next;
   }
  }
  const foodChanged = beforeFood !== this.foodState(food);
  if (foodChanged) this.foodCache = undefined;
  if (beforePosition !== Math.round(this.position) || beforeDirection !== this.direction
   || beforePose !== this.pose || beforeCompact !== this.frameIndex(false)
   || beforeFull !== this.frameIndex(true) || foodChanged) this.notify();
 }

 private foodState(food: FoodPiece[]): string {
  if (!this.settings.foodRain || this.settings.motion !== "animated") return "";
  const munch = this.feeder.phase() === "munching"
   ? Math.floor(this.frameMs / WALK_FRAME_MS.fast) % MUNCH_GLYPHS.length : "";
  return `${this.feeder.phase()}:${this.chaseTargetId}:${munch}|`
   + food.map(piece => `${piece.id}:${piece.column}:${piece.row}:${piece.glyph}`).join("|");
 }

 private notify(): void {
  // Snapshot permits removal/dispose during redraw without reviving callbacks.
  for (const subscription of [...this.subscribers]) {
   if (this.disposed) break;
   if (this.subscribers.has(subscription)) subscription.redraw();
  }
 }
}
