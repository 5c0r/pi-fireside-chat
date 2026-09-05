/**
 * Minimal structural types for the host extension API surface pi-fireside-chat
 * consumes. The real contracts live in each host's coding-agent package
 * (oh-my-pi v18.1.3 extensibility/extensions/types.ts; earendil-works/pi
 * docs/extensions.md); this dir carries no node_modules, so these are the
 * compile-time shadows. Runtime host differences are shimmed in index.ts.
 */

/** Opaque host Model object (provider/id/...); passed through to host calls only. */
export type OpaqueModel = Record<string, unknown>;

export interface SidechatSessionManager {
	getEntries(): unknown[];
	getBranch(): unknown[];
	getLeafId(): string | null;
	getSessionId?(): string;
}

export interface SidechatModelQuery {
	current(): OpaqueModel | undefined;
}

export interface SidechatModelRegistry {
	resolver?(model: OpaqueModel, sessionId?: string): unknown;
	getProviderAuth?(provider: string): Promise<unknown>;
}

/** Structural subset of TUI. */
export interface TuiLike {
	requestRender(): void;
}

/** Structural subset of Theme: colorized text/background helpers (chat bubbles). */
export interface ThemeLike {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
}

/** Host markdown theme (MarkdownTheme structural subset, host-produced pass-through). */
export interface MarkdownThemeLike {
	heading: (text: string) => string;
	link: (text: string) => string;
	linkUrl: (text: string) => string;
	codeSpan: (text: string) => string;
	emphasis: (text: string) => string;
	strong: (text: string) => string;
}

/** Structural component contract returned to ui.custom(). */
export interface PaneComponent {
	render(width: number): readonly string[];
	handleInput(data: string): void;
	invalidate(): void;
	dispose?(): void;
}

export interface SidechatUI {
	notify(message: string, type?: "info" | "warning" | "error"): void;
	/**
	 * Focused custom component (overlay page over the transcript when
	 * `overlay: true`) — resolves when the component calls done().
	 */
	custom<T>(
		factory: (
			tui: TuiLike,
			theme: ThemeLike,
			keybindings: unknown,
			done: (result: T) => void,
		) => PaneComponent | Promise<PaneComponent>,
		options?: {
			overlay?: boolean;
			overlayOptions?: {
				width?: number | `${number}%`;
				maxHeight?: number | `${number}%`;
				margin?: number;
				fullscreen?: boolean;
				mouseTracking?: boolean;
			};
			signal?: AbortSignal;
		},
	): Promise<T>;
}

export interface SidechatContext {
	ui: SidechatUI;
	hasUI: boolean;
	model: OpaqueModel | undefined;
	models: SidechatModelQuery;
	modelRegistry: SidechatModelRegistry;
	sessionManager: SidechatSessionManager;
	/** Current effective main-session system prompt (omp: string[]; pi: string). */
	getSystemPrompt(): string[] | string;
}

export type SidechatCommandContext = SidechatContext;

export interface SidechatExtensionAPI {
	on(event: string, handler: (event: unknown, ctx: SidechatContext) => void | Promise<void>): void;
	registerCommand(
		name: string,
		options: {
			description?: string;
			handler: (args: string, ctx: SidechatCommandContext) => Promise<void>;
		},
	): void;
	appendEntry(customType: string, data?: unknown): void;
}
