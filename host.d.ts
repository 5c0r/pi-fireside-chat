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

declare var process: { stdout: { rows?: number; columns?: number } };
