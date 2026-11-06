/**
 * Ambient declarations for host-resolved modules.
 *
 * Entry imports the "@earendil-works/*" scope: earendil-works/pi resolves it
 * natively; oh-my-pi (omp) remaps it to its bundled in-process copies
 * (legacy-pi-compat PI_SCOPE_ALIASES includes "earendil-works" — verified
 * live). This dir intentionally carries no node_modules, so tsc needs these
 * minimal shapes. Sources:
 *   - earendil-works/pi packages/ai (streamSimple), packages/tui (Box,
 *     Markdown, matchesKey), packages/coding-agent barrel (buildSessionContext,
 *     convertToLlm, getMarkdownTheme)
 *   - omp v18.1.3 equivalents (same positional contracts)
 */

declare module "@earendil-works/pi-ai" {
 export interface SimpleStreamEvent {
  type: "text_delta" | "done" | "error";
  delta?: string;
  error?: { errorMessage?: string };
  message?: { content?: unknown };
 }
 export interface SimpleStreamOptions {
  apiKey?: unknown;
  signal?: AbortSignal;
  maxTokens?: number;
  [key: string]: unknown;
 }
 export function streamSimple(
  model: unknown,
  context: { systemPrompt?: string | string[]; messages: unknown[]; tools?: unknown[] },
  options?: SimpleStreamOptions,
 ): Promise<AsyncIterable<SimpleStreamEvent>>;
}

declare module "@earendil-works/pi-tui" {
 export function matchesKey(data: string, key: string): boolean;
 export function wrapTextWithAnsi(text: string, width: number): string[];
 export function truncateToWidth(text: string, width: number, ellipsis?: string, pad?: boolean): string;
 export class Box {
  constructor(
   paddingX?: number,
   paddingY?: number,
   bgFn?: (text: string) => string,
  );
  addChild(component: { render(width: number): readonly string[] }): void;
  render(width: number): readonly string[];
 }
 export class Markdown {
  constructor(
   text: string,
   paddingX: number,
   paddingY: number,
   theme: {
    heading: (text: string) => string;
    link: (text: string) => string;
    linkUrl: (text: string) => string;
    codeSpan: (text: string) => string;
   },
   defaultTextStyle?: {
    color?: (text: string) => string;
    bgColor?: (text: string) => string;
   },
  );
  setText(text: string): boolean;
  invalidate(): void;
  render(width: number): string[];
 }
}

declare module "@earendil-works/pi-coding-agent" {
 export function getAgentDir(): string;
 export function buildSessionContext(
  entries: unknown[],
  leafId?: string | null,
 ): { messages: unknown[] };
 export function convertToLlm(messages: unknown[]): unknown[];
 /** MarkdownTheme structural subset — host-produced pass-through. */
 export function getMarkdownTheme(): {
  heading: (text: string) => string;
  link: (text: string) => string;
  linkUrl: (text: string) => string;
  codeSpan: (text: string) => string;
 };
}

/** Narrow Node filesystem surface shared by both host runtimes. */
declare module "node:fs" {
 export const constants: { O_RDONLY: number; O_NONBLOCK: number };
 export function openSync(path: string, flags: number): number;
 export function closeSync(fd: number): void;
 export function fstatSync(fd: number): { size: number; isFile(): boolean };
 export function readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number;
 export function readFileSync(path: string, encoding: "utf8"): string;
 export function mkdirSync(path: string, options: { recursive: true; mode?: number }): string | undefined;
 export function mkdtempSync(prefix: string): string;
 export function writeFileSync(path: string, data: string, options: { encoding: "utf8"; mode?: number }): void;
 export function renameSync(from: string, to: string): void;
 export function rmSync(path: string, options: { recursive?: boolean; force?: boolean }): void;
}
declare module "node:path" {
 export function join(...paths: string[]): string;
}

declare var process: { stdout: { rows?: number; columns?: number } };
