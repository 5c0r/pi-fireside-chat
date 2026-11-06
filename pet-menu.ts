import { PET_IDS, PET_PALETTES, formatPetError, parsePetSettings, randomizePetSettings, resolvePetSprite, selectPet, type PetSettings } from "./pet-data";
import type { PetEngine } from "./pet-engine";

interface PetMenuOptions {
 settings: PetSettings;
 engine: PetEngine;
 random?: () => number;
 rows(): number;
 key(data: string, key: string): boolean;
 clip(text: string, width: number): string;
 color(palette: PetSettings["palette"], text: string): string;
 redraw(): void;
 commit(settings: PetSettings): void;
 done(): void;
}

const controls = ["randomPet", "randomColor", "surprise", "pet", "name", "palette", "size", "speed", "personality", "placement", "motion", "foodRain", "customFile", "save"] as const;
const actions = { randomPet: "pet", randomColor: "color", surprise: "both" } as const;
const choices = {
 pet: PET_IDS,
 palette: PET_PALETTES,
 size: ["compact", "full"], speed: ["slow", "normal", "fast"],
 personality: ["calm", "playful", "sleepy"], placement: ["main", "fireside", "both"],
 motion: ["animated", "static", "hidden"],
 foodRain: ["off", "on"],
} as const;
const labels: Record<typeof controls[number], string> = {
 randomPet: "Random pet", randomColor: "Random color", surprise: "Surprise me",
 pet: "Pet", name: "Name", palette: "Color", size: "Size", speed: "Speed",
 personality: "Personality", placement: "Placement", motion: "Motion",
 customFile: "Custom sprite file", save: "Save preferences",
 foodRain: "Food rain",
};

/** A local-only settings surface. Nothing is persisted until Save succeeds. */
export function createPetMenu(options: PetMenuOptions) {
 const rollback = options.engine.beginPreview();
 let draft = { ...options.settings };
 let selected = 0;
 let editing = false;
 let buffer = "";
 let error = "";
 let disposed = false;
 let committed = false;
 let closed = false;
 const unsubscribe = options.engine.subscribe(() => { if (!disposed) options.redraw(); }, "preview");

 function preview() {
  try {
   const valid = parsePetSettings(draft);
   const resolved = resolvePetSprite(valid);
   if (resolved.error) { error = resolved.error; return; }
   error = "";
   options.engine.update(valid, resolved.sprite);
  } catch (cause) { error = formatPetError(cause); }
 }
 function finish() {
  if (closed) return;
  closed = true;
  dispose();
  options.done();
 }
 function dispose() {
  if (disposed) return;
  disposed = true;
  unsubscribe();
  if (!committed) rollback();
 }
 function cycle(direction: number) {
  const field = controls[selected];
  if (field === "foodRain") draft.foodRain = !draft.foodRain;
  else if (field in choices) {
   const values = choices[field as keyof typeof choices] as readonly string[];
   const current = draft[field as keyof typeof choices] as string;
   const next = values[(values.indexOf(current) + direction + values.length) % values.length];
   if (field === "pet") draft = selectPet(draft, next as PetSettings["pet"]);
   else Object.assign(draft, { [field]: next });
  }
  preview();
 }
 function randomize(action: "pet" | "color" | "both") {
  draft = randomizePetSettings(draft, action, options.random ?? Math.random);
  preview();
 }
 function save() {
  try {
   const valid = parsePetSettings(draft);
   const resolved = resolvePetSprite(valid);
   if (resolved.error) throw new Error(resolved.error);
   options.commit(valid);
   committed = true;
   finish();
  } catch (cause) { error = formatPetError(cause); }
 }

 return {
  render(width: number): string[] {
   const columns = Math.max(0, Math.floor(width));
   const rows = Math.max(1, Math.floor(options.rows()));
   const previewRows = rows >= 17 ? 3 : rows >= 7 ? 1 : 0;
   const lines = ["Fireside Pet", editing ? "Enter accept · Esc cancel edit" : "↑/↓ select · ←/→ change · Enter act/edit/save · r surprise · Esc discard"];
   const picture = options.engine.render(columns, previewRows, "preview");
   if (previewRows) {
    lines.push(...(picture.length ? picture.map(line => options.color(draft.palette, line)) : ["Preview hidden (Motion: hidden)"]));
   }
   const footer = error ? `Error: ${error}` : editing ? "Type a name or absolute local JSON path." : "Local preferences · no model calls";
   const available = Math.max(1, rows - lines.length - 1);
   const start = Math.max(0, Math.min(selected - available + 1, controls.length - available));
   for (let i = start; i < Math.min(controls.length, start + available); i++) {
    const field = controls[i];
    const setting = field in draft;
    const value = field === "customFile" ? draft.customFile || "(none)" : field === "foodRain" ? (draft.foodRain ? "on" : "off") : setting ? draft[field as keyof PetSettings] : "";
    const activeValue = editing && selected === i ? `${buffer}_` : value;
    lines.push(`${i === selected ? ">" : " "} ${labels[field]}${setting ? `: ${activeValue}` : ""}`);
   }
   lines.push(footer);
   // Clip before coloring ordinary rows; the engine's preview is already column-safe.
   return lines.slice(0, rows).map(line => options.clip(line, columns));
  },
  handleInput(data: string) {
   if (disposed) return;
   if (editing) {
    if (options.key(data, "escape")) { editing = false; buffer = ""; error = ""; }
    else if (options.key(data, "enter")) {
     const field = controls[selected] as "name" | "customFile";
     const candidate = { ...draft, [field]: buffer };
     if (field === "name") candidate.nameFollowsPet = false;
     try {
      draft = parsePetSettings(candidate);
      editing = false;
      preview();
     } catch (cause) { error = formatPetError(cause); }
    } else if (options.key(data, "backspace")) buffer = Array.from(buffer).slice(0, -1).join("");
    else {
     // Bracketed paste is data, never terminal commands. Remove its delimiters only.
     const text = data.replace(/^\x1b\[200~/, "").replace(/\x1b\[201~$/, "");
     if (/^[^\x00-\x1f\x7f-\x9f]+$/u.test(text)) buffer = (buffer + text).slice(0, 4096);
    }
   } else if (options.key(data, "escape")) finish();
   else if (options.key(data, "r")) randomize("both");
   else if (options.key(data, "up")) selected = Math.max(0, selected - 1);
   else if (options.key(data, "down")) selected = Math.min(controls.length - 1, selected + 1);
   else if (options.key(data, "left")) cycle(-1);
   else if (options.key(data, "right")) cycle(1);
   else if (options.key(data, "enter")) {
    const field = controls[selected];
    if (field in actions) randomize(actions[field as keyof typeof actions]);
    else if (field === "save") save();
    else if (field === "name" || field === "customFile") { editing = true; buffer = draft[field]; error = ""; }
    else cycle(1);
   }
   options.redraw();
  },
  invalidate() { options.redraw(); },
  dispose,
 };
}
