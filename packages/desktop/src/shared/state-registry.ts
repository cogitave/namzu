/**
 * The interface-state registry: every key the window may keep across a close, declared once.
 *
 * A key the registry does not know is refused on write and dropped on load, so nothing lands in
 * the store by accident, and each key says how large it may grow and what a restart does with it.
 * Key names are the strings the renderer already used in `localStorage`, so the migration is a
 * copy and a stored layout is never reshaped on its way in.
 *
 * Never stored, by design: secrets and tokens, the contents of a page or an extension view, the
 * clipboard, a live shell, and transient dialogs and menus. Those have no entry here, so they
 * cannot be written.
 */

/** Whose state a key is. A conversation or a project that no longer exists takes its keys with it. */
export type StateScope = 'app' | 'window' | 'project' | 'conversation'

/**
 * What a restart does with a key.
 * - `always`: restored after a quit, an update, a reboot and a crash (from the last checkpoint).
 * - `soft`: restored after a quit, an update and a reboot; after a crash it resets to its default,
 *   because a selection made just before a crash may be what crashed.
 */
export type StateRestore = 'always' | 'soft'

export interface StateKeyDef {
	/** Stable name, for logs and docs. */
	readonly id: string
	readonly scope: StateScope
	/** The key's exact name, or the start of a family of names. */
	readonly match: { readonly exact: string } | { readonly prefix: string }
	/** The most bytes one value may take. A larger value is refused, never cut. */
	readonly maxBytes: number
	readonly restore: StateRestore
	/**
	 * For a family of keys: the most entries kept. Past it the entry written longest ago goes, so a
	 * family that grows with use (one key per file or conversation) cannot grow without end.
	 */
	readonly maxEntries?: number
	/** For a `conversation` key: the id its name carries, so it can be pruned with the conversation. */
	readonly ownerOf?: (key: string) => string | undefined
}

const after = (prefix: string) => (key: string) => key.slice(prefix.length) || undefined

const KIB = 1024

export const STATE_KEYS: readonly StateKeyDef[] = [
	{
		id: 'ui.sidebar.collapsed',
		scope: 'app',
		match: { exact: 'namzu.sidebar-collapsed' },
		maxBytes: 16,
		restore: 'always',
	},
	{
		id: 'ui.surface',
		scope: 'app',
		match: { exact: 'namzu.surface' },
		maxBytes: 16,
		restore: 'always',
	},
	{
		id: 'ui.showConversationTabs',
		scope: 'app',
		match: { exact: 'namzu.show-conversation-tabs' },
		maxBytes: 16,
		restore: 'always',
	},
	{
		id: 'ui.conversationTabs',
		scope: 'window',
		match: { exact: 'namzu.conversation-tabs' },
		maxBytes: 64 * KIB,
		restore: 'always',
	},
	{
		id: 'ui.appearance',
		scope: 'app',
		match: { exact: 'namzu.appearance' },
		maxBytes: 32,
		restore: 'always',
	},
	{
		id: 'ui.appearancePrefs',
		scope: 'app',
		match: { exact: 'namzu.appearance-prefs' },
		maxBytes: 4 * KIB,
		restore: 'always',
	},
	{
		id: 'ui.interfaceFont',
		scope: 'app',
		match: { exact: 'namzu.interface-font' },
		maxBytes: 64,
		restore: 'always',
	},
	{
		id: 'usage.limitBudgets',
		scope: 'app',
		match: { exact: 'namzu.limit-budgets' },
		maxBytes: 4 * KIB,
		restore: 'always',
	},
	{
		id: 'usage.lastLimits',
		scope: 'app',
		match: { exact: 'namzu.last-limits' },
		maxBytes: 16 * KIB,
		restore: 'always',
	},
	{
		id: 'ui.sessionPanel.open',
		scope: 'app',
		match: { exact: 'namzu.session-panel-open' },
		maxBytes: 16,
		restore: 'always',
	},
	{
		id: 'ui.panes',
		scope: 'window',
		match: { prefix: 'namzu.panes.1.' },
		maxBytes: 8 * KIB,
		maxEntries: 50,
		restore: 'always',
	},
	{
		id: 'changes.display',
		scope: 'app',
		match: { exact: 'namzu.changes.display' },
		maxBytes: KIB,
		restore: 'always',
	},
	{
		// The files a person marked as viewed in a review; which file is selected is not kept.
		id: 'changes.viewed',
		scope: 'app',
		match: { prefix: 'namzu.changes.viewed.' },
		maxBytes: 64 * KIB,
		maxEntries: 300,
		restore: 'always',
	},
	{
		id: 'conv.presentation',
		scope: 'conversation',
		match: { prefix: 'namzu.workspace.presentation:' },
		maxBytes: 4 * KIB,
		maxEntries: 500,
		restore: 'soft',
		ownerOf: after('namzu.workspace.presentation:'),
	},
	{
		id: 'conv.panelTabs',
		scope: 'conversation',
		match: { prefix: 'namzu.workspace.files:' },
		maxBytes: 16 * KIB,
		maxEntries: 500,
		restore: 'always',
		ownerOf: after('namzu.workspace.files:'),
	},
	{
		id: 'ui.panelWidth',
		scope: 'window',
		match: { prefix: 'namzu.workspace.panel-width:' },
		maxBytes: 32,
		maxEntries: 50,
		restore: 'always',
	},
	{
		// Maximized and full-screen flags of a window, written by the main process only.
		id: 'window.mode',
		scope: 'window',
		match: { prefix: 'window.mode:' },
		maxBytes: 64,
		maxEntries: 50,
		restore: 'always',
	},
]

/** The definition that covers a key, or `undefined` when the key may not be stored. */
export function defineOf(key: string): StateKeyDef | undefined {
	if (typeof key !== 'string' || key.length === 0 || key.length > 300) return undefined
	return STATE_KEYS.find((def) =>
		'exact' in def.match ? def.match.exact === key : key.startsWith(def.match.prefix),
	)
}
