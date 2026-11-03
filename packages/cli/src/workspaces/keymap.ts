import type { NavKey } from './input.js'

/** Everything the key after the prefix can ask for. */
export type ActionId =
	| 'help'
	| 'menu'
	| 'quit'
	| 'goto'
	| 'new-workspace'
	| 'open-folder'
	| 'rename-workspace'
	| 'close-workspace'
	| 'workspace-mode'
	| 'sidebar'
	| 'new-tab'
	| 'rename-tab'
	| 'close-tab'
	| 'prev-tab'
	| 'next-tab'
	| 'tab-number'
	| 'split-side'
	| 'split-stack'
	| 'focus-left'
	| 'focus-down'
	| 'focus-up'
	| 'focus-right'
	| 'swap-left'
	| 'swap-down'
	| 'swap-up'
	| 'swap-right'
	| 'next-pane'
	| 'prev-pane'
	| 'close-pane'
	| 'zoom'
	| 'resize-mode'
	| 'rename-pane'

export type BindingGroup = 'General' | 'Workspaces' | 'Tabs' | 'Panes'

/** One entry of the key map: the keys after the prefix, what they do, and the words for the help. */
export interface Binding {
	/** Characters, or `tab` / `backtab`, that trigger it. */
	readonly keys: readonly string[]
	readonly action: ActionId
	readonly group: BindingGroup
	readonly label: string
}

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9']

/**
 * The one place the keys after the prefix are written down. The host runs
 * whatever this says and the help overlay prints it, so the two cannot differ.
 */
export const BINDINGS: readonly Binding[] = [
	{ keys: ['?'], action: 'help', group: 'General', label: 'keybinds' },
	{ keys: ['g'], action: 'goto', group: 'General', label: 'go to a workspace, tab or pane' },
	{ keys: ['s'], action: 'menu', group: 'General', label: 'menu' },
	{ keys: ['q'], action: 'quit', group: 'General', label: 'quit' },
	{ keys: ['N'], action: 'new-workspace', group: 'Workspaces', label: 'new workspace' },
	{
		keys: ['O'],
		action: 'open-folder',
		group: 'Workspaces',
		label: 'open a folder as a workspace',
	},
	{ keys: ['W'], action: 'rename-workspace', group: 'Workspaces', label: 'rename workspace' },
	{ keys: ['D'], action: 'close-workspace', group: 'Workspaces', label: 'close workspace' },
	{
		keys: ['w'],
		action: 'workspace-mode',
		group: 'Workspaces',
		label: 'move through the workspaces',
	},
	{ keys: ['b'], action: 'sidebar', group: 'Workspaces', label: 'toggle sidebar' },
	{ keys: ['c'], action: 'new-tab', group: 'Tabs', label: 'new tab' },
	{ keys: ['T'], action: 'rename-tab', group: 'Tabs', label: 'rename tab' },
	{ keys: ['X'], action: 'close-tab', group: 'Tabs', label: 'close tab' },
	{ keys: ['p'], action: 'prev-tab', group: 'Tabs', label: 'previous tab' },
	{ keys: ['n'], action: 'next-tab', group: 'Tabs', label: 'next tab' },
	{ keys: DIGITS, action: 'tab-number', group: 'Tabs', label: 'tab by number' },
	{ keys: ['v'], action: 'split-side', group: 'Panes', label: 'split side by side' },
	{ keys: ['-'], action: 'split-stack', group: 'Panes', label: 'split top over bottom' },
	{ keys: ['h'], action: 'focus-left', group: 'Panes', label: 'focus left' },
	{ keys: ['j'], action: 'focus-down', group: 'Panes', label: 'focus down' },
	{ keys: ['k'], action: 'focus-up', group: 'Panes', label: 'focus up' },
	{ keys: ['l'], action: 'focus-right', group: 'Panes', label: 'focus right' },
	{ keys: ['H'], action: 'swap-left', group: 'Panes', label: 'swap pane left' },
	{ keys: ['J'], action: 'swap-down', group: 'Panes', label: 'swap pane down' },
	{ keys: ['K'], action: 'swap-up', group: 'Panes', label: 'swap pane up' },
	{ keys: ['L'], action: 'swap-right', group: 'Panes', label: 'swap pane right' },
	{ keys: ['tab'], action: 'next-pane', group: 'Panes', label: 'next pane' },
	{ keys: ['backtab'], action: 'prev-pane', group: 'Panes', label: 'previous pane' },
	{ keys: ['x'], action: 'close-pane', group: 'Panes', label: 'close pane' },
	{ keys: ['z'], action: 'zoom', group: 'Panes', label: 'zoom pane' },
	{ keys: ['r'], action: 'resize-mode', group: 'Panes', label: 'resize mode' },
	{ keys: ['P'], action: 'rename-pane', group: 'Panes', label: 'rename pane' },
]

/** The name of a key as the help shows it: `shift+n`, `shift+tab`, `-`. */
export function keyName(key: string): string {
	if (key === 'backtab') return 'shift+tab'
	if (/^[A-Z]$/u.test(key)) return `shift+${key.toLowerCase()}`
	return key
}

function keysText(binding: Binding): string {
	if (binding.keys === DIGITS) return '1-9'
	return binding.keys.map(keyName).join(' ')
}

/** The binding a key after the prefix runs, if any. */
export function bindingFor(key: NavKey): Binding | undefined {
	const name = key.kind === 'tab' ? 'tab' : key.kind === 'backtab' ? 'backtab' : undefined
	const wanted = name ?? (key.kind === 'char' ? key.char : undefined)
	if (wanted === undefined) return undefined
	return BINDINGS.find((b) => b.keys.includes(wanted))
}

export interface HelpRow {
	/** A group heading, or a key and what it does. */
	readonly heading?: string
	readonly keys?: string
	readonly label?: string
}

/** The help overlay's rows: the prefix first, then every binding under its group. */
export function helpRows(prefixName: string): HelpRow[] {
	const rows: HelpRow[] = [{ heading: `${prefixName} then a key; twice sends it to the pane` }]
	for (const group of ['General', 'Workspaces', 'Tabs', 'Panes'] as const) {
		rows.push({ heading: group })
		for (const b of BINDINGS)
			if (b.group === group) rows.push({ keys: keysText(b), label: b.label })
	}
	return rows
}
