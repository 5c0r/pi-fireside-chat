import type { PetClock } from "./pet-engine";

export interface FoodPiece {
 id: number;
 glyph: string;
 column: number;
 row: number;
 landed: boolean;
 eatenAt?: number;
}

export type FeedPhase = "idle" | "chasing" | "munching" | "satisfied" | "digesting";
export type FeedSource = "main" | "fireside";

type FallingPiece = FoodPiece & { spawnedAt: number };

const FALL_MS_PER_ROW = 350;
const SPAWN_MIN_INTERVAL_MS = 500;
const MAX_ACTIVE = 10;
const FULL_AFTER = 5;
const SATISFIED_MS = 1200;
const DIGEST_MS = 6000;
const MUNCH_MS = 700;

type ControlMode = "text" | "escape" | "intermediate" | "csi" | "osc" | "string" | "oscEscape" | "stringEscape";

/** Retain only a parser mode between chunks, never a control payload or reply. */
class VisibleAsciiParser {
 mode: ControlMode = "text";

 consume(text: string, collect: boolean): string {
  let visible = "";
  for (let i = 0; i < text.length; i++) {
   const code = text.charCodeAt(i);
   if (code === 0x18 || code === 0x1a) { this.mode = "text"; continue; }
   if (this.mode === "osc" || this.mode === "string") {
    if (code === 0x9c || (this.mode === "osc" && code === 0x07)) this.mode = "text";
    else if (code === 0x1b) this.mode = this.mode === "osc" ? "oscEscape" : "stringEscape";
    continue;
   }
   if (this.mode === "oscEscape" || this.mode === "stringEscape") {
    if (code === 0x5c || code === 0x9c || (this.mode === "oscEscape" && code === 0x07)) this.mode = "text";
    else if (code !== 0x1b) this.mode = this.mode === "oscEscape" ? "osc" : "string";
    continue;
   }
   if (code === 0x1b) { this.mode = "escape"; continue; }
   if (code === 0x9b) { this.mode = "csi"; continue; }
   if (code === 0x9d) { this.mode = "osc"; continue; }
   if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) { this.mode = "string"; continue; }
   if (this.mode === "csi") {
    if (code >= 0x40 && code <= 0x7e) this.mode = "text";
   } else if (this.mode === "escape") {
    if (code === 0x5b) this.mode = "csi";
    else if (code === 0x5d) this.mode = "osc";
    else if (code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f) this.mode = "string";
    else if (code >= 0x20 && code <= 0x2f) this.mode = "intermediate";
    else if (code >= 0x30 && code <= 0x7e) this.mode = "text";
   } else if (this.mode === "intermediate") {
    if (code >= 0x30 && code <= 0x7e) this.mode = "text";
   } else if (collect && code >= 0x20 && code <= 0x7e) {
    visible += text[i];
   }
  }
  return visible;
 }
}

/** A timer-free world shared by every visible assistant-text producer. */
export class Feeder {
 private food: FallingPiece[] = [];
 private feedPhase: FeedPhase = "idle";
 private eaten = 0;
 private target: number | null = null;
 private nextId = 1;
 private lastSpawnAt = -Infinity;
 private lastStepAt = -Infinity;
 private satisfiedUntil = -Infinity;
 private digestUntil = -Infinity;
 private columns = 0;
 private rows = 0;
 private readonly parsers = { main: new VisibleAsciiParser(), fireside: new VisibleAsciiParser() };

 constructor(
  private readonly clock: PetClock,
  private readonly random: () => number = Math.random,
  viewport: { columns: number; rows: number } = { columns: 80, rows: 3 },
 ) {
  this.setViewport(viewport.columns, viewport.rows);
 }

 /** Consume syntax even for discarded deltas; never queue missed fragments. */
 ingestDelta(text: string, atMs = this.clock.now(), source: FeedSource = "main", canSpawn = true): number {
  const admitted = canSpawn && this.feedPhase !== "satisfied" && this.feedPhase !== "digesting"
   && this.food.length < MAX_ACTIVE && atMs - this.lastSpawnAt >= SPAWN_MIN_INTERVAL_MS
   && this.columns > 0 && this.rows > 0;
  const visible = this.parsers[source].consume(text, admitted);
  if (!admitted) return 0;
  const glyph = this.fragment(visible);
  if (glyph === null) return 0;
  this.food.push({
   id: this.nextId++, glyph, column: this.pick(this.columns),
   row: 0, landed: false, spawnedAt: atMs,
  });
  this.lastSpawnAt = atMs;
  return 1;
 }

 /** Advance state only once per timestamp; the engine owns the tick timer. */
 step(atMs: number, pet: { position: number; width: number } = { position: 0, width: 0 }): void {
  if (atMs <= this.lastStepAt) return;
  this.lastStepAt = atMs;

  for (let i = this.food.length - 1; i >= 0; i--) {
   if (this.food[i].column >= this.columns || this.rows === 0) this.food.splice(i, 1);
  }
  if (this.target !== null && !this.food.some((piece) => piece.id === this.target)) {
   this.target = null;
   if (this.feedPhase === "chasing" || this.feedPhase === "munching") this.feedPhase = "idle";
  }

  const landRow = this.rows - 1;
  for (const piece of this.food) {
   piece.row = piece.landed
    ? landRow
    : Math.min(landRow, Math.max(0, Math.floor((atMs - piece.spawnedAt) / FALL_MS_PER_ROW)));
   if (piece.row >= landRow) piece.landed = true;
  }

  if (this.feedPhase === "satisfied") {
   if (atMs >= this.satisfiedUntil) {
    this.feedPhase = "digesting";
    this.digestUntil = atMs + DIGEST_MS;
   }
   return;
  }
  if (this.feedPhase === "digesting") {
   if (atMs < this.digestUntil) return;
   this.feedPhase = "idle";
   this.eaten = 0;
  }

  if (this.feedPhase === "munching") {
   const index = this.food.findIndex((piece) => piece.id === this.target);
   const piece = this.food[index];
   if (piece?.eatenAt !== undefined && atMs - piece.eatenAt >= MUNCH_MS) {
    this.food.splice(index, 1);
    this.eaten++;
    this.target = null;
    if (this.eaten === FULL_AFTER) {
     this.feedPhase = "satisfied";
     this.satisfiedUntil = atMs + SATISFIED_MS;
     return;
    }
    this.feedPhase = "idle";
   }
  }

  if (this.feedPhase === "idle") {
   let target: FallingPiece | undefined;
   let nearest = Infinity;
   const edge = Math.max(0, this.columns - pet.width);
   for (const piece of this.food) {
    if (!piece.landed) continue;
    const destination = Math.max(0, Math.min(edge, piece.column + piece.glyph.length / 2 - pet.width / 2));
    const distance = Math.abs(destination - pet.position);
    if (distance < nearest) { target = piece; nearest = distance; }
   }
   if (target) {
    this.target = target.id;
    this.feedPhase = "chasing";
   }
  }
 }

 /** The engine coordinates canonical geometry across its owned surfaces. */
 setViewport(columns: number, rows: number): void {
  this.columns = Number.isFinite(columns) ? Math.max(0, Math.floor(columns)) : 0;
  this.rows = Number.isFinite(rows) ? Math.max(0, Math.floor(rows)) : 0;
 }

 resetSource(source: FeedSource): void {
  this.parsers[source].mode = "text";
 }

 /** Independent projection cannot change the world's fall timing or reachability. */
 pieces(columns: number, rows: number): FoodPiece[] {
  columns = Number.isFinite(columns) ? Math.max(0, Math.floor(columns)) : 0;
  rows = Number.isFinite(rows) ? Math.max(0, Math.floor(rows)) : 0;
  if (columns === 0 || rows === 0) return [];
  return this.food.map((piece) => {
   const copy: FoodPiece = {
    id: piece.id, glyph: piece.glyph,
    column: Math.max(0, Math.min(piece.column, columns - 1)),
    row: piece.landed ? rows - 1 : Math.max(0, Math.min(piece.row, rows - 1)),
    landed: piece.landed,
   };
   if (piece.eatenAt !== undefined) copy.eatenAt = piece.eatenAt;
   return copy;
  });
 }

 phase(): FeedPhase {
  return this.feedPhase;
 }

 consumed(): number {
  return this.eaten;
 }

 targetId(): number | null {
  return this.target;
 }

 /** Arrival starts one munch; repeated arrival reports cannot extend it. */
 beginMunch(pieceId: number, atMs: number): void {
  if (this.feedPhase === "munching") return;
  const piece = this.food.find((food) => food.id === pieceId);
  if (!piece || !piece.landed || piece.eatenAt !== undefined) return;
  piece.eatenAt = atMs;
  this.target = piece.id;
  this.feedPhase = "munching";
 }

 /** Restore a deep baseline once, pausing all world deadlines during preview. */
 beginPreview(): () => void {
  const capturedAt = this.clock.now();
  const state = {
   food: this.food.map((piece) => ({ ...piece })),
   feedPhase: this.feedPhase, eaten: this.eaten, target: this.target,
   nextId: this.nextId, lastSpawnAt: this.lastSpawnAt, lastStepAt: this.lastStepAt,
   satisfiedUntil: this.satisfiedUntil, digestUntil: this.digestUntil,
   columns: this.columns, rows: this.rows,
  };
  let restored = false;
  return () => {
   if (restored) return;
   restored = true;
   const elapsed = Math.max(0, this.clock.now() - capturedAt);
   this.food = state.food.map((piece) => {
    const copy = { ...piece, spawnedAt: piece.spawnedAt + elapsed };
    if (piece.eatenAt !== undefined) copy.eatenAt = piece.eatenAt + elapsed;
    return copy;
   });
   this.feedPhase = state.feedPhase;
   this.eaten = state.eaten;
   this.target = state.target;
   this.nextId = state.nextId;
   this.lastSpawnAt = state.lastSpawnAt + elapsed;
   this.lastStepAt = state.lastStepAt + elapsed;
   this.satisfiedUntil = state.satisfiedUntil + elapsed;
   this.digestUntil = state.digestUntil + elapsed;
   this.columns = state.columns;
   this.rows = state.rows;
  };
 }

 clear(): void {
  this.food.length = 0;
  this.feedPhase = "idle";
  this.eaten = 0;
  this.target = null;
  this.nextId = 1;
  this.lastSpawnAt = -Infinity;
  this.lastStepAt = -Infinity;
  this.satisfiedUntil = -Infinity;
  this.digestUntil = -Infinity;
 }

 private pick(count: number): number {
  return Math.max(0, Math.min(count - 1, Math.floor(this.random() * count)));
 }

 private fragment(text: string): string | null {
  const runs = text.match(/[A-Za-z0-9_{}()<>/=+\-*.;:]+/g);
  if (!runs) return null;
  let preferred = 0;
  for (const run of runs) if (run.length >= 2) preferred++;
  let selected = this.pick(preferred || runs.length);
  for (const run of runs) {
   if (preferred && run.length < 2) continue;
   if (selected-- !== 0) continue;
   if (run.length <= 3) return run;
   const offset = this.pick(run.length - 2);
   return run.slice(offset, offset + 3);
  }
  return null;
 }
}
