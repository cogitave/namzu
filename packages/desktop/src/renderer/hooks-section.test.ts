import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { ConfigSettingsView } from '../shared/config-settings-protocol.js'
import { type HooksReport, readHooksReport } from '../shared/hooks-report.js'
import { HooksRows } from './hooks-section.js'
import {
	EMPTY_HOOKS,
	OLD_ENGINE_HOOKS,
	disableHooksValue,
	hooksListView,
	runHooksState,
} from './hooks-view-model.js'
import type { ConfigSettingsControls } from './use-config-settings.js'
import type { HooksControls } from './use-hooks-view.js'

const origin = (over: Record<string, unknown> = {}) => ({
	kind: 'config',
	label: '/work/app/namzu.config.json',
	path: '/work/app/namzu.config.json',
	scope: 'project',
	...over,
})
const row = (over: Record<string, unknown> = {}) => ({
	id: 'r1',
	event: 'pre_tool_use',
	eventWritten: 'PreToolUse',
	matcher: 'Bash',
	type: 'command',
	runs: './guard.sh --strict',
	origin: origin(),
	state: 'runs',
	...over,
})
const answer = (over: Record<string, unknown> = {}): HooksReport =>
	readHooksReport({
		version: 1,
		folder: { path: '/work/app', trusted: true },
		switches: {
			disableHooks: { on: false },
			hooksManagedOnly: { on: false },
			plugins: { on: true },
		},
		hooks: [],
		modules: [],
		problems: [],
		counts: { runs: 0, off: 0, attachesWhenUsed: 0, notLoaded: 0, waitingForTrust: 0, problems: 0 },
		...over,
	}) as HooksReport

const full = (): HooksReport =>
	answer({
		hooks: [
			row(),
			row({
				id: 'r2',
				event: 'session_start',
				eventWritten: 'SessionStart',
				matcher: undefined,
				runs: 'node ~/hooks/start.mjs',
				origin: origin({
					label: '~/.namzu/config.yaml',
					path: '~/.namzu/config.yaml',
					scope: 'user',
				}),
				once: true,
				timeoutMs: 5000,
			}),
			row({
				id: 'r3',
				event: 'post_tool_use',
				runs: 'POST https://hooks.example/ingest',
				type: 'http',
				matcher: undefined,
				origin: {
					kind: 'plugin',
					label: 'plugin review-bot',
					name: 'review-bot',
					path: '~/.namzu/plugins/review-bot',
					scope: 'user',
				},
				state: 'off',
				why: { code: 'plugin-disabled', text: 'plugin review-bot is switched off.' },
			}),
			row({
				id: 'r4',
				event: 'user_prompt_submit',
				type: 'prompt',
				runs: 'Check the prompt for secrets',
				matcher: undefined,
				origin: {
					kind: 'skill',
					label: 'skill careful',
					name: 'careful',
					path: '/work/app/.namzu/skills/careful',
					scope: 'project',
				},
				state: 'attaches-when-used',
			}),
			row({
				id: 'r5',
				event: 'turn_end',
				origin: {
					kind: 'agent',
					label: 'agent runner',
					name: 'runner',
					path: '/work/app/.namzu/agents/runner.md',
					scope: 'project',
				},
				state: 'not-loaded',
				why: {
					code: 'agent-not-offered',
					text: 'The agent is not offered until the hook entry is fixed.',
				},
				notes: ['The matcher cannot be read, so this hook fires for every call.'],
			}),
			row({ id: 'r6', event: 'future_event', runs: 'x', matcher: undefined }),
		],
		modules: [
			{
				plugin: 'review-bot',
				module: 'dist/hooks.js',
				origin: {
					kind: 'plugin',
					label: 'plugin review-bot',
					path: '~/.namzu/plugins/review-bot',
					scope: 'user',
				},
				state: 'runs',
			},
		],
		problems: [
			{
				severity: 'problem',
				origin: origin(),
				event: 'PreToolUse',
				message: 'An entry has no command, so it was not loaded.',
			},
			{
				severity: 'note',
				origin: { kind: 'skill', label: 'skill odd', name: 'odd', scope: 'user' },
				message: 'The skill cannot be used.',
			},
		],
		counts: { runs: 2, off: 1, attachesWhenUsed: 1, notLoaded: 1, waitingForTrust: 0, problems: 1 },
	})

const configView = (disable?: boolean): ConfigSettingsView => ({
	file: '/home/me/.namzu/config.yaml',
	descriptors: [
		{
			path: 'disableHooks',
			label: 'Turn off hooks',
			description: 'x',
			section: 'tools',
			control: { kind: 'toggle' },
			defaultText: 'off',
		},
	],
	settings: [
		{
			path: 'disableHooks',
			set: disable !== undefined,
			...(disable !== undefined ? { value: disable } : {}),
		},
	],
})
const config = (over: Partial<ConfigSettingsControls> = {}): ConfigSettingsControls => ({
	view: configView(),
	loadError: '',
	errors: {},
	change: vi.fn(async () => true),
	confirmation: undefined,
	confirm: vi.fn(async () => {}),
	dismiss: vi.fn(),
	...over,
})
const controls = (
	report: HooksReport | undefined,
	over: Partial<HooksControls> = {},
	own = false,
): HooksControls => ({
	supported: true,
	reload: vi.fn(),
	read: report
		? { key: 'p1', loading: false, view: { report, own } }
		: { key: 'p1', loading: false },
	...over,
})
const markup = (hooks: HooksControls, cfg = config(), projectName: string | undefined = 'shop') =>
	renderToStaticMarkup(createElement(HooksRows, { hooks, config: cfg, projectName }))

it('groups hooks by when they run and names what each starts, where it comes from and where to change it', () => {
	const view = hooksListView(full())
	expect(view.groups.map((group) => group.when)).toEqual([
		'When a conversation starts',
		'When you send a message',
		'Before a tool runs',
		'After a tool runs',
		'When a reply is about to finish',
		'On future_event',
	])
	const guard = view.groups[2]?.hooks[0]
	expect(guard).toMatchObject({
		runs: './guard.sh --strict',
		stateLabel: 'Runs',
		source: 'This folder’s settings',
		change: 'Change it in /work/app/namzu.config.json.',
	})
	expect(guard?.facts).toEqual(['Matches Bash'])
	expect(view.groups[0]?.hooks[0]?.facts).toEqual(['Once per conversation', 'Stops after 5 s'])
	expect(view.groups[0]?.hooks[0]?.source).toBe('Your own settings')
	const plugin = view.groups[3]?.hooks[0]
	expect(plugin).toMatchObject({
		source: 'Plugin review-bot',
		stateLabel: 'Off',
		why: 'plugin review-bot is switched off.',
	})
	expect(plugin?.change).toContain('~/.namzu/plugins/review-bot')
	expect(view.groups[1]?.hooks[0]).toMatchObject({
		kind: 'Asks the model:',
		stateLabel: 'When used',
		source: 'Skill careful',
	})
	expect(view.groups[4]?.hooks[0]).toMatchObject({
		source: 'Agent file runner',
		stateLabel: 'Not loaded',
		why: 'The agent is not offered until the hook entry is fixed.',
		notes: ['The matcher cannot be read, so this hook fires for every call.'],
	})
})

it('puts a problem with the event it names, and one that names none with its source, never in a log of its own', () => {
	const view = hooksListView(full())
	// "PreToolUse" as the source spelled it finds the pre_tool_use group.
	expect(view.groups[2]?.problems).toEqual([
		{
			severity: 'problem',
			source: 'This folder’s settings',
			text: 'An entry has no command, so it was not loaded.',
			inactive: false,
		},
	])
	expect(view.unplaced.map((problem) => problem.source)).toEqual(['Skill odd'])
	const html = markup(controls(full()))
	expect(html).toContain('Not loaded</span> This folder’s settings: An entry has no command')
	expect(html).toContain('Skill odd: The skill cannot be used.')
})

it('lists every entry read-only with its state, the engine’s reason and the plugin code, and no controls but the switch', () => {
	const html = markup(controls(full()))
	for (const text of [
		'When a conversation starts',
		'./guard.sh --strict',
		'Matches Bash',
		'Asks the model:',
		'POST https://hooks.example/ingest',
		'plugin review-bot is switched off.',
		'Code a plugin runs',
		'dist/hooks.js',
		'2 running · 1 when used · 1 off · 1 not loaded',
		'What runs by itself in “shop”.',
		'This list is read-only',
	])
		expect(html).toContain(text)
	expect(html.match(/<input/g)?.length).toBe(1)
	expect(html).not.toContain('<textarea')
})

it('says there are none and where hooks are written when there are none', () => {
	const html = markup(controls(answer()))
	expect(html).toContain(EMPTY_HOOKS)
	expect(EMPTY_HOOKS.split('. ').length).toBe(1)
	expect(EMPTY_HOOKS).toMatch(/config file/)
	expect(EMPTY_HOOKS).toMatch(/plugin/)
	expect(markup(controls(full()))).not.toContain(EMPTY_HOOKS)
})

it('says the engine cannot list hooks, and still offers the switch from the settings it can read', () => {
	const html = markup(
		controls(undefined, { read: { key: 'p1', loading: false, unsupported: true } }),
	)
	expect(html).toContain(OLD_ENGINE_HOOKS)
	expect(html).toContain('Run hooks')
	expect(html).toContain('role="switch"')
	expect(html).not.toContain(EMPTY_HOOKS)
})

it('shows nothing of the list, and no switch, where the window has no way to ask and no setting exists', () => {
	expect(
		markup(controls(undefined, { supported: false, read: undefined }), config({ view: undefined })),
	).toBe('')
})

it('keeps the switch off while the engine has not yet said whether something else decides', () => {
	const html = markup(controls(undefined, { read: { key: 'p1', loading: true } }))
	expect(html).toMatch(/role="switch"[^>]*disabled/)
	expect(html).toContain('Reading the hooks…')
})

it('draws the switch from the engine’s answer and changes only the user-level setting', async () => {
	expect(runHooksState(answer(), undefined)).toEqual({ on: true })
	expect(
		runHooksState(
			answer({
				switches: {
					disableHooks: { on: true, setBy: { kind: 'user-file', path: '~/.namzu/config.yaml' } },
					hooksManagedOnly: { on: false },
					plugins: { on: true },
				},
			}),
			undefined,
		),
	).toEqual({ on: false })
	// Running hooks puts the default back; stopping them sets the key.
	expect(disableHooksValue(true)).toBeUndefined()
	expect(disableHooksValue(false)).toBe(true)
	const change = vi.fn(async () => true)
	const reload = vi.fn()
	const html = markup(controls(answer(), { reload }), config({ change }))
	expect(html).toMatch(/role="switch"[^>]*aria-checked="true"/)
	expect(html).not.toMatch(/role="switch"[^>]*disabled/)
})

for (const [name, switches, words] of [
	[
		'an administrator’s file turns hooks off',
		{
			disableHooks: { on: true, setBy: { kind: 'managed', path: '/etc/namzu/managed.json' } },
			hooksManagedOnly: { on: false },
		},
		'Hooks are switched off by your administrator’s settings (/etc/namzu/managed.json)',
	],
	[
		'the environment turns hooks off',
		{
			disableHooks: { on: true, setBy: { kind: 'env', variable: 'NAMZU_DISABLE_HOOKS' } },
			hooksManagedOnly: { on: false },
		},
		'Hooks are switched off by the environment variable NAMZU_DISABLE_HOOKS',
	],
	[
		'the environment keeps hooks on',
		{
			disableHooks: { on: false, setBy: { kind: 'env', variable: 'NAMZU_DISABLE_HOOKS' } },
			hooksManagedOnly: { on: false },
		},
		'Hooks are kept on by the environment variable NAMZU_DISABLE_HOOKS',
	],
	[
		'an administrator allows only managed hooks',
		{
			disableHooks: { on: false },
			hooksManagedOnly: { on: true, setBy: { kind: 'managed', path: '/etc/namzu/managed.json' } },
		},
		'Only the hooks in the managed file run: your administrator’s settings (/etc/namzu/managed.json) requires it',
	],
] as const) {
	it(`locks the switch and says why when ${name}`, () => {
		const change = vi.fn(async () => true)
		const report = answer({ switches: { ...switches, plugins: { on: true } } })
		const state = runHooksState(report, undefined)
		expect(state.locked).toContain(words)
		const html = markup(controls(report), config({ change }))
		expect(html).toMatch(/role="switch"[^>]*disabled/)
		expect(html).toContain('data-locked')
		expect(html).toContain(words.replace('’', '’'))
		expect(change).not.toHaveBeenCalled()
		// Exactly one line says why.
		expect(html.match(/data-locked/g)?.length).toBe(1)
	})
}

it('shows the untrusted folder in one line and starts nothing for it', () => {
	const report = answer({
		folder: { path: '/work/app', trusted: false },
		hooks: [
			row({
				state: 'not-loaded',
				why: {
					code: 'folder-not-trusted',
					text: 'This folder is not trusted. It starts once the folder is trusted.',
				},
			}),
		],
		counts: { runs: 0, off: 0, attachesWhenUsed: 0, notLoaded: 1, waitingForTrust: 1, problems: 0 },
	})
	const html = markup(controls(report))
	expect(html).toContain('This folder is not trusted yet, so 1 hook in it has not started.')
	expect(html).toContain('Not loaded')
})

it('is about the person’s own hooks when no folder is open', () => {
	const html = markup(controls(answer(), {}, true), config(), undefined)
	expect(html).toContain('The hooks of your own settings, which apply in every folder.')
})

it('never shows a header or an env value, only what the reader kept', () => {
	const report = readHooksReport({
		...JSON.parse(JSON.stringify(full())),
		hooks: [
			{
				...row({
					type: 'http',
					runs: 'POST https://u:pw@h.example/p?k=SECRETQ',
					matcher: undefined,
				}),
				headers: { Authorization: 'Bearer SECRETH' },
				env: { TOKEN: 'SECRETE' },
			},
		],
	}) as HooksReport
	const html = markup(controls(report))
	for (const secret of ['SECRETQ', 'SECRETH', 'SECRETE', 'pw@']) expect(html).not.toContain(secret)
	expect(html).toContain('POST https://h.example/p')
})

it('says when part of the answer could not be read', () => {
	const report = readHooksReport({
		...JSON.parse(JSON.stringify(full())),
		hooks: [row(), { id: 'x' }],
	}) as HooksReport
	expect(markup(controls(report))).toContain('One entry in the engine’s answer could not be read')
})

it('says once, for the list, what a switch is holding back instead of repeating it on every row', () => {
	const why = {
		code: 'disableHooks',
		text: 'disableHooks (or NAMZU_DISABLE_HOOKS) is on: hooks that are not from the managed file are off.',
	}
	const report = answer({
		hooks: [
			row({ id: 'a', state: 'off', why }),
			row({ id: 'b', event: 'turn_end', state: 'off', why }),
		],
	})
	const view = hooksListView(report)
	expect(view.heldBack).toBe(why.text)
	expect(view.groups.flatMap((group) => group.hooks).every((hook) => hook.why === undefined)).toBe(
		true,
	)
	const html = markup(controls(report))
	expect(html.split(why.text).length - 1).toBe(1)
	expect(html.match(/>Off</g)?.length).toBe(2)
})

it('says, right after hooks are switched off, that an open project keeps running them', () => {
	const off = renderToStaticMarkup(
		createElement(HooksRows, {
			hooks: controls(answer()),
			config: config(),
			projectName: 'shop',
			justSaved: false,
		}),
	)
	expect(off).toContain('data-pending-reconnect')
	expect(off).toContain('keeps running its hooks until Namzu connects to it again')
	// Nothing is claimed before a change was saved.
	expect(markup(controls(answer()))).not.toContain('data-pending-reconnect')
})
