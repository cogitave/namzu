/**
 * A hooks module of a common-layout plugin, run in its own worker and driven
 * through the real hook dispatch: what its answers do, how it fails, what it
 * cannot reach, and that one bad module leaves another plugin alone.
 *
 * Nothing here waits on the clock. A budget is tested with a clock the test
 * moves by hand and a stand-in worker the test scripts; every other test awaits
 * the real worker's answer.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PluginId, SessionId } from '../../types/ids/index.js'
import type { PluginHookResult } from '../../types/plugin/index.js'
import { NOOP_LOGGER } from '../../utils/log/create-logger.js'
import { COMMON_MODULE_TYPES_SPECIFIER } from '../common-layout-names.js'
import {
	type HookModuleClock,
	type HookModuleHandle,
	startHookModule,
} from '../hook-module/host.js'
import type { HookModuleTransport } from '../hook-module/host.js'
import { PluginLifecycleManager } from '../lifecycle.js'
import { type ShellHookOptions, shellHookVerdict } from '../shell-hook.js'

const SESSION = '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as SessionId
const roots: string[] = []
const handles: HookModuleHandle[] = []

afterEach(async () => {
	for (const handle of handles.splice(0)) await handle.dispose()
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-hmod-'))
	roots.push(dir)
	return dir
}

/** A plugin folder holding `files`, and a project folder beside it. */
function plugin(files: Record<string, string>): { root: string; project: string; data: string } {
	const parent = scratch()
	const root = join(parent, 'plug')
	const project = join(parent, 'project')
	const data = join(parent, 'data')
	mkdirSync(root, { recursive: true })
	mkdirSync(project, { recursive: true })
	for (const [path, text] of Object.entries(files)) {
		const full = join(root, path)
		mkdirSync(dirname(full), { recursive: true })
		writeFileSync(full, text)
	}
	return { root, project, data }
}

function shellOptions(cwd: string): ShellHookOptions {
	return { cwd, projectDir: cwd }
}

async function start(
	files: Record<string, string>,
	extra: Partial<Parameters<typeof startHookModule>[0]> = {},
	entry = 'hooks/mod.js',
) {
	const folders = plugin({ [entry]: '', ...files })
	const handle = await startHookModule({
		plugin: { name: 'plug', root: folders.root, dataDir: folders.data },
		entry,
		projectDir: folders.project,
		shell: shellOptions(folders.project),
		log: NOOP_LOGGER,
		...extra,
	})
	handles.push(handle)
	return { handle, ...folders }
}

function managerFor(handle: HookModuleHandle, id = 'p_one'): PluginLifecycleManager {
	const manager = new PluginLifecycleManager({
		pluginRegistry: {} as never,
		scopeRoots: { project: process.cwd(), user: process.cwd() },
		log: NOOP_LOGGER,
	})
	for (const hook of handle.hooks) manager.registerHook(id as PluginId, hook)
	return manager
}

const one = (results: PluginHookResult[]): PluginHookResult => results[0] as PluginHookResult

const GUARD = `
export function register(on) {
	on('classic.PreToolUse', { tool: 'Bash' }, ($, e) => {
		if (e.command === 'rm -rf x') return { deny: 'no rm' }
		if (e.command === 'ls') return { allow: true }
		if (e.command === 'ask') return { ask: 'sure?' }
		if (e.command === 'rewrite') return { updatedInput: { command: 'ls -la' } }
		if (e.command === 'ctx') return { additionalContext: ['one', 'two'] }
		return {}
	})
	on('classic.PostToolUse', ($, e) => ({ additionalContext: ['saw ' + e.tool_name] }))
	on('classic.UserPromptSubmit', ($, e) => ({ additionalContext: ['asked: ' + e.prompt] }))
	on('classic.SessionStart', () => ({ additionalContext: ['started'] }))
}
`

describe('the answers of classic hooks, through the real dispatch', () => {
	/** What a shell hook that printed `json` would have answered for the same event. */
	const asShell = (
		event: Parameters<typeof shellHookVerdict>[0],
		json: object,
		call: Parameters<typeof shellHookVerdict>[4] = {},
	): PluginHookResult =>
		shellHookVerdict(
			event,
			{ type: 'command', command: 'module plug/hooks/mod.js' },
			{ exitCode: 0, timedOut: false, stdout: JSON.stringify(json), stderr: '' },
			NOOP_LOGGER,
			call,
		)

	it('refuses, allows, asks, rewrites and adds context on a tool call as a command hook would', async () => {
		const { handle } = await start({ 'hooks/mod.js': GUARD })
		expect(handle.status).toBe('running')
		const manager = managerFor(handle)
		const run = async (command: string) =>
			one(
				await manager.executeHooks('pre_tool_use', {
					sessionId: SESSION,
					toolName: 'bash',
					toolInput: { command },
				}),
			)
		const call = (command: string) => ({ toolName: 'bash', toolInput: { command } })
		const specific = (fields: object) => ({
			hookSpecificOutput: { hookEventName: 'PreToolUse', ...fields },
		})
		expect(await run('rm -rf x')).toEqual(
			asShell(
				'pre_tool_use',
				specific({ permissionDecision: 'deny', permissionDecisionReason: 'no rm' }),
				call('rm -rf x'),
			),
		)
		expect(await run('ls')).toEqual(
			asShell('pre_tool_use', specific({ permissionDecision: 'allow' }), call('ls')),
		)
		expect(await run('ask')).toEqual(
			asShell(
				'pre_tool_use',
				specific({ permissionDecision: 'ask', permissionDecisionReason: 'sure?' }),
				call('ask'),
			),
		)
		expect(await run('rewrite')).toEqual(
			asShell('pre_tool_use', specific({ updatedInput: { command: 'ls -la' } }), call('rewrite')),
		)
		expect(await run('ctx')).toEqual(
			asShell('pre_tool_use', specific({ additionalContext: 'one\ntwo' }), call('ctx')),
		)
		expect(await run('echo hi')).toEqual({ action: 'continue' })
		// The shapes themselves, so the equality above cannot pass by both being empty.
		expect(await run('rm -rf x')).toMatchObject({ action: 'skip', reason: 'no rm' })
		expect(await run('rewrite')).toMatchObject({ action: 'modify', input: { command: 'ls -la' } })
		expect(await run('ctx')).toMatchObject({ action: 'continue', context: 'one\ntwo' })
	})

	it('answers post-tool, prompt and session events', async () => {
		const { handle } = await start({ 'hooks/mod.js': GUARD })
		const manager = managerFor(handle)
		expect(
			one(
				await manager.executeHooks('post_tool_use', {
					sessionId: SESSION,
					toolName: 'bash',
					toolInput: { command: 'ls' },
					toolResult: { success: true, output: 'a' },
				}),
			),
		).toEqual(
			asShell(
				'post_tool_use',
				{ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'saw Bash' } },
				{ toolName: 'bash' },
			),
		)
		expect(
			one(
				await manager.executeHooks('user_prompt_submit', { sessionId: SESSION, prompt: 'hello' }),
			),
		).toEqual({ action: 'annotate', text: 'asked: hello' })
		expect(one(await manager.executeHooks('session_start', { sessionId: SESSION }))).toEqual({
			action: 'annotate',
			text: 'started',
		})
	})

	it('shows a module the same fields a command hook reads, and a tool call as tool plus its arguments', async () => {
		const { handle, project } = await start({
			'hooks/mod.js': `
export function register(on) {
	on('classic.UserPromptSubmit', ($, e) => ({ additionalContext: [JSON.stringify(e)] }))
	on('classic.PreToolUse', ($, e) => ({ additionalContext: [JSON.stringify(e)] }))
}
`,
		})
		const manager = managerFor(handle)
		const prompt = one(
			await manager.executeHooks('user_prompt_submit', { sessionId: SESSION, prompt: 'p' }),
		)
		const seen = JSON.parse((prompt as { text: string }).text)
		expect(seen).toMatchObject({
			hook_event_name: 'UserPromptSubmit',
			session_id: SESSION,
			prompt: 'p',
			cwd: project,
		})
		const tool = one(
			await manager.executeHooks('pre_tool_use', {
				sessionId: SESSION,
				toolName: 'bash',
				toolCallId: 'call-1',
				toolInput: { command: 'ls', tool: 'spoof' },
			}),
		) as { context: string }
		// The engine's own fields stand over an argument of the same name.
		expect(JSON.parse(tool.context)).toEqual({ command: 'ls', tool: 'Bash', tool_use_id: 'call-1' })
	})

	it('nests registrations in order, and a hook calls next to reach the one beneath', async () => {
		const { handle } = await start({
			'hooks/mod.js': `
export function register(on) {
	on('classic.PostToolUse', async ($, e, next) => {
		const beneath = await next(e)
		return { additionalContext: ['outer', ...(beneath.additionalContext ?? [])] }
	})
	on('classic.PostToolUse', { tool_name: /./ }, ($) => ({ additionalContext: ['inner'] }))
}
`,
		})
		const manager = managerFor(handle)
		const result = one(
			await manager.executeHooks('post_tool_use', {
				sessionId: SESSION,
				toolName: 'bash',
				toolInput: {},
				toolResult: { success: true, output: '' },
			}),
		)
		expect(result).toMatchObject({ action: 'continue', context: 'outer\ninner' })
	})

	it('matches the tool by name, by pattern and by list', async () => {
		const { handle } = await start({
			'hooks/mod.js': `
export function register(on) {
	on('classic.PreToolUse', { tool: /^Re/ }, () => ({ deny: 'read-ish' }))
	on('classic.PreToolUse', { tool: ['Write', 'Edit'] }, () => ({ deny: 'writes' }))
}
`,
		})
		const manager = managerFor(handle)
		const ask = async (toolName: string) =>
			one(
				await manager.executeHooks('pre_tool_use', { sessionId: SESSION, toolName, toolInput: {} }),
			)
		expect(await ask('read')).toMatchObject({ action: 'skip', reason: 'read-ish' })
		expect(await ask('write')).toMatchObject({ action: 'skip', reason: 'writes' })
		expect(await ask('bash')).toEqual({ action: 'continue' })
	})

	it('hears every classic event through classic.* and *, and not the ones a negation takes out', async () => {
		const { handle } = await start({
			'hooks/mod.js': `
export function register(on) {
	on('classic.*', ($, e, next) => next(e))
	on('!classic.PreToolUse', () => ({ additionalContext: ['not tool'] }))
}
`,
		})
		const events = new Set(handle.hooks.map((hook) => hook.event))
		expect(events.has('pre_tool_use')).toBe(true)
		expect(events.has('turn_end')).toBe(true)
		const manager = managerFor(handle)
		expect(
			one(await manager.executeHooks('user_prompt_submit', { sessionId: SESSION, prompt: 'x' })),
		).toEqual({ action: 'annotate', text: 'not tool' })
		// The glob alone answers `{}` for a tool call: nothing decided.
		expect(
			one(
				await manager.executeHooks('pre_tool_use', {
					sessionId: SESSION,
					toolName: 'bash',
					toolInput: {},
				}),
			),
		).toEqual({ action: 'continue' })
	})
})

describe('a module that also uses what Namzu has no place for', () => {
	it('loads, runs its classic hooks, and never runs the others', async () => {
		const { handle } = await start({
			'hooks/mod.js': `
export function register(on) {
	on('tool.call', ($, e, next) => ({ deny: 'never' }))
	on('ui.render', () => ({}))
	on('classic.UserPromptSubmit', async ($, e) => ({ additionalContext: ['classic ran'] }))
}
`,
		})
		expect(handle.status).toBe('running')
		expect(handle.scan.hooks.map((hook) => [hook.pattern, hook.runs.length > 0])).toEqual([
			['tool.call', false],
			['ui.render', false],
			['classic.UserPromptSubmit', true],
		])
		expect(handle.scan.hooks[0]?.notUsed).toBe(
			'Namzu runs classic.* hooks from modules; tool.call is not available.',
		)
		expect(
			one(
				await managerFor(handle).executeHooks('user_prompt_submit', {
					sessionId: SESSION,
					prompt: 'x',
				}),
			),
		).toEqual({ action: 'annotate', text: 'classic ran' })
	})

	it('does not start a worker for a module whose hooks all belong to the other engine', async () => {
		const made = vi.fn()
		const { handle } = await start(
			{
				'hooks/mod.js': `export function register(on) { on('tool.call', ($, e, next) => next(e)) }`,
			},
			{
				transport: () => {
					made()
					throw new Error('no worker')
				},
			},
		)
		expect(made).not.toHaveBeenCalled()
		expect(handle.status).toBe('unloaded')
		expect(handle.message).toContain('Namzu has no event for')
	})
})

describe('a hook that fails', () => {
	const FAILING = `
export function register(on) {
	on('classic.PreToolUse', { tool: 'Bash' }, ($, e) => { throw new Error('boom') })
	on('classic.PreToolUse', { tool: 'Read' }, () => undefined)
	on('classic.PreToolUse', { tool: 'Glob' }, () => ({ allow: 'yes' }))
	on('classic.PostToolUse', () => { throw new Error('late') })
	on('classic.PreSkillShellCommand', () => { throw new Error('skill') })
}
`
	const fail = async (toolName: string) => {
		const { handle } = await start({ 'hooks/mod.js': FAILING })
		const manager = managerFor(handle)
		return one(
			await manager.executeHooks('pre_tool_use', { sessionId: SESSION, toolName, toolInput: {} }),
		)
	}

	it('refuses the tool call it guards, saying why, when it throws', async () => {
		expect(await fail('bash')).toMatchObject({ action: 'error' })
		expect(((await fail('bash')) as { message: string }).message).toContain('boom')
	})

	it('counts a hook that returns nothing as a failure', async () => {
		const result = await fail('read')
		expect(result).toMatchObject({ action: 'error' })
		expect((result as { message: string }).message).toContain('returned nothing')
	})

	it('counts an answer of the wrong shape as a failure', async () => {
		const result = await fail('glob')
		expect(result).toMatchObject({ action: 'error' })
		expect((result as { message: string }).message).toContain('an allow that is not true')
	})

	it('lets a failed post-tool hook through with a notice, and refuses a skill command', async () => {
		const { handle } = await start({ 'hooks/mod.js': FAILING })
		const manager = managerFor(handle)
		const post = one(
			await manager.executeHooks('post_tool_use', {
				sessionId: SESSION,
				toolName: 'bash',
				toolInput: {},
				toolResult: { success: true, output: '' },
			}),
		)
		expect(post).toMatchObject({ action: 'continue' })
		expect((post as { notice: string }).notice).toContain('late')
		expect(
			one(await manager.executeHooks('pre_skill_shell_command', { sessionId: SESSION })),
		).toMatchObject({ action: 'skip' })
	})

	it('answers in the place of a hook that failed when its .catch answers', async () => {
		const { handle } = await start({
			'hooks/mod.js': `
export function register(on) {
	on('classic.PreToolUse', () => { throw new Error('nope') })
		.catch(($, e, next) => ({ deny: 'guard failed: ' + next.error }))
}
`,
		})
		const manager = managerFor(handle)
		const result = one(
			await manager.executeHooks('pre_tool_use', {
				sessionId: SESSION,
				toolName: 'bash',
				toolInput: {},
			}),
		)
		expect(result).toMatchObject({ action: 'skip' })
		expect((result as { reason: string }).reason).toContain('guard failed: nope')
	})
})

describe('the budget of a dispatch', () => {
	/** A clock the test moves, and a worker the test scripts. */
	function fakes() {
		let now = 0
		let nextHandle = 1
		const timers = new Map<number, { at: number; run: () => void }>()
		const clock: HookModuleClock = {
			now: () => now,
			setTimeout: (run, ms) => {
				const handle = nextHandle++
				timers.set(handle, { at: now + ms, run })
				return handle
			},
			clearTimeout: (handle) => {
				timers.delete(handle as number)
			},
		}
		const advance = (ms: number): void => {
			now += ms
			for (const [handle, timer] of [...timers]) {
				if (timer.at <= now) {
					timers.delete(handle)
					timer.run()
				}
			}
		}
		const sent: any[] = []
		let listener: (message: any) => void = () => undefined
		let terminated = 0
		const transport: HookModuleTransport = {
			post: (message) => {
				sent.push(message)
				if ((message as { t: string }).t === 'load') {
					queueMicrotask(() =>
						listener({
							t: 'loaded',
							registrations: [{ pattern: 'classic.PreToolUse', hasMatcher: false }],
						}),
					)
				}
			},
			onMessage: (next) => {
				listener = next
			},
			onExit: () => undefined,
			terminate: async () => {
				terminated += 1
			},
		}
		return {
			clock,
			advance,
			sent,
			transport: () => transport,
			reply: (message: object) => listener(message),
			terminated: () => terminated,
		}
	}

	it('overruns at ten seconds, asks the hook to stop, gives its .catch a second, then fails the call', async () => {
		const world = fakes()
		const { handle } = await start(
			{ 'hooks/mod.js': `export function register(on) { on('classic.PreToolUse', () => ({})) }` },
			{ clock: world.clock, transport: world.transport },
		)
		const manager = managerFor(handle)
		const dispatched = manager.executeHooks('pre_tool_use', {
			sessionId: SESSION,
			toolName: 'bash',
			toolInput: {},
		})
		await vi.waitFor(() => expect(world.sent.some((m) => m.t === 'dispatch')).toBe(true))
		world.advance(9_999)
		expect(world.sent.some((m) => m.t === 'overrun')).toBe(false)
		world.advance(1)
		expect(world.sent.some((m) => m.t === 'overrun')).toBe(true)
		expect(world.sent.some((m) => m.t === 'grace-over')).toBe(false)
		world.advance(1_000)
		expect(world.sent.some((m) => m.t === 'grace-over')).toBe(true)
		const result = one(await dispatched) as { action: string; message: string }
		expect(result.action).toBe('error')
		expect(result.message).toContain('exceeded 10000ms budget')
		// A worker that did not answer within the grace is ended.
		expect(world.terminated()).toBe(1)
	})

	it('does not count the time a hook spends waiting on a call on $', async () => {
		const world = fakes()
		const { handle } = await start(
			{ 'hooks/mod.js': `export function register(on) { on('classic.PreToolUse', () => ({})) }` },
			{ clock: world.clock, transport: world.transport },
		)
		const manager = managerFor(handle)
		const dispatched = manager.executeHooks('pre_tool_use', {
			sessionId: SESSION,
			toolName: 'bash',
			toolInput: {},
		})
		await vi.waitFor(() => expect(world.sent.some((m) => m.t === 'dispatch')).toBe(true))
		const dispatchId = world.sent.find((m) => m.t === 'dispatch').id
		world.advance(6_000)
		world.reply({ t: 'call', cid: 1, noun: 'env', method: 'get', args: ['X'] })
		// The call is refused (no variable was named in the source), and it was outstanding while time passed.
		world.advance(60_000)
		await vi.waitFor(() => expect(world.sent.some((m) => m.t === 'call-result')).toBe(true))
		expect(world.sent.some((m) => m.t === 'overrun')).toBe(false)
		world.advance(3_999)
		expect(world.sent.some((m) => m.t === 'overrun')).toBe(false)
		world.reply({ t: 'result', id: dispatchId, ok: true, value: {}, failures: [] })
		expect(one(await dispatched)).toEqual({ action: 'continue' })
	})

	it('stops waiting for a hook when the turn is cancelled', async () => {
		const world = fakes()
		const { handle } = await start(
			{ 'hooks/mod.js': `export function register(on) { on('classic.PreToolUse', () => ({})) }` },
			{ clock: world.clock, transport: world.transport },
		)
		const controller = new AbortController()
		const hook = handle.hooks[0]
		const pending = hook?.handler({
			pluginId: 'p' as PluginId,
			event: 'pre_tool_use',
			sessionId: SESSION,
			toolName: 'bash',
			toolInput: {},
			signal: controller.signal,
		})
		await vi.waitFor(() => expect(world.sent.some((m) => m.t === 'dispatch')).toBe(true))
		controller.abort()
		expect(world.sent.some((m) => m.t === 'abort')).toBe(true)
		expect(await pending).toMatchObject({ action: 'error' })
	})
})

describe('what a module cannot reach', () => {
	const probe = async (body: string, files: Record<string, string> = {}) => {
		const folders = await start({
			'hooks/mod.js': `
export function register(on) {
	on('classic.UserPromptSubmit', async ($, e) => {
		const out = []
		try { ${body} } catch (error) { out.push('threw: ' + error.message) }
		return { additionalContext: [out.join('|')] }
	})
}
`,
			...files,
		})
		const manager = managerFor(folders.handle)
		const result = one(
			await manager.executeHooks('user_prompt_submit', { sessionId: SESSION, prompt: 'x' }),
		)
		return {
			...folders,
			text: (result as { text?: string }).text ?? JSON.stringify([result, folders.handle.message]),
		}
	}

	it('has no require, no process, no timers and no network globals', async () => {
		const { text } = await probe(`
			out.push(typeof require, typeof process, typeof setTimeout, typeof fetch, typeof module, typeof Buffer, typeof WebSocket)
		`)
		expect(text.split('|')).toEqual(Array(7).fill('undefined'))
	})

	it('cannot be changed through its globals or its intrinsics', async () => {
		const { text } = await probe(`
			try { console = {}; out.push('set') } catch (error) { out.push('global frozen') }
			try { Array.prototype.push = () => 0; out.push('patched') } catch (error) { out.push('array frozen') }
			try { $.plugin.root = 'x'; out.push('replaced') } catch (error) { out.push('$ frozen') }
		`)
		expect(text).toBe('global frozen|array frozen|$ frozen')
	})

	it('refuses an import() and a computed $ call before it loads, and a hook that tries them at run time throws', async () => {
		const { handle } = await start({
			'hooks/mod.js': `export function register(on) { on('classic.Stop', async () => { await import('node:fs'); return {} }) }`,
		})
		expect(handle.status).toBe('unloaded')
		expect(handle.message).toContain('a dynamic import()')
	})

	it('answers a call on $ that Namzu has no place for by throwing where it is called', async () => {
		const { text } = await probe(`
			try { await $.tool.call({}) } catch (error) { out.push(error.message) }
			try { await $.fs.write('a', 'b') } catch (error) { out.push(error.message) }
		`)
		expect(text).toBe('$.tool.call is not available in Namzu|$.fs.write is not available in Namzu')
	})

	it('reads files inside the plugin and the project, and refuses the rest, links included', async () => {
		const folders = plugin({ 'hooks/mod.js': '', 'data.txt': 'inside plugin' })
		writeFileSync(join(folders.project, 'p.txt'), 'inside project')
		const outside = join(dirname(folders.root), 'secret.txt')
		writeFileSync(outside, 'secret')
		symlinkSync(outside, join(folders.project, 'link.txt'))
		symlinkSync(dirname(folders.root), join(folders.root, 'up'))
		writeFileSync(
			join(folders.root, 'hooks/mod.js'),
			`
export function register(on) {
	on('classic.UserPromptSubmit', async ($) => {
		const out = []
		const tries = [
			() => $.fs.read($.plugin.root + '/data.txt'),
			() => $.fs.read('p.txt'),
			() => $.fs.read('${outside}'),
			() => $.fs.read('link.txt'),
			() => $.fs.read($.plugin.root + '/up/secret.txt'),
			() => $.fs.read('../secret.txt'),
			() => $.fs.exists('missing.txt'),
		]
		for (const attempt of tries) {
			try { out.push(String(await attempt())) } catch (error) { out.push('refused') }
		}
		return { additionalContext: [out.join('|')] }
	})
}
`,
		)
		const handle = await startHookModule({
			plugin: { name: 'plug', root: folders.root },
			entry: 'hooks/mod.js',
			projectDir: folders.project,
			shell: shellOptions(folders.project),
			log: NOOP_LOGGER,
		})
		handles.push(handle)
		const result = one(
			await managerFor(handle).executeHooks('user_prompt_submit', {
				sessionId: SESSION,
				prompt: 'x',
			}),
		)
		expect((result as { text: string }).text).toBe(
			'inside plugin|inside project|refused|refused|refused|refused|false',
		)
	})

	it('reads no more than 4 MiB at once', async () => {
		const { text } = await probe(
			`
			try { await $.fs.read($.plugin.root + '/big.bin'); out.push('read') } catch (error) { out.push('too big') }
			out.push((await $.fs.read($.plugin.root + '/big.bin', { offset: 4194300 })).length)
		`,
			{ 'big.bin': 'x'.repeat(4 * 1024 * 1024 + 10) },
		)
		expect(text).toBe('too big|14')
	})

	it('runs a program from an argument list and never through a shell', async () => {
		const { text } = await probe(`
			const ran = await $.process.run([${JSON.stringify(process.execPath)}, '-e', 'console.log(process.argv[1]); process.exit(3)', 'a b; echo hi'])
			out.push(ran.exitCode, ran.stdout.trim(), ran.isStdoutTruncated)
			try { await $.process.run('echo hi') } catch (error) { out.push('needs a list') }
			try { await $.process.run(['echo hi; true']) } catch (error) { out.push('no such program') }
		`)
		expect(text).toBe('3|a b; echo hi|false|needs a list|no such program')
	})

	it('answers $.env.get only for a name written out as a literal', async () => {
		const folders = await start(
			{
				'hooks/mod.js': `
export function register(on) {
	on('classic.UserPromptSubmit', async ($) => ({ additionalContext: [String(await $.env.get('NAMZU_TEST_VARIABLE'))] }))
}
`,
			},
			{ environment: { NAMZU_TEST_VARIABLE: 'seen', OTHER: 'hidden' } },
		)
		const result = one(
			await managerFor(folders.handle).executeHooks('user_prompt_submit', {
				sessionId: SESSION,
				prompt: 'x',
			}),
		)
		expect((result as { text: string }).text).toBe('seen')
		const computed = await start({
			'hooks/mod.js': `
export function register(on) {
	on('classic.UserPromptSubmit', async ($) => ({ additionalContext: [await $.env.get('NAMZU_' + 'TEST_VARIABLE')] }))
}
`,
		})
		expect(computed.handle.status).toBe('unloaded')
		expect(computed.handle.message).toContain('$.env.get takes a string literal')
	})

	it('keeps a store in the data folder, with a size cap', async () => {
		const { text, data } = await probe(`
			await $.store.set('count', 2)
			out.push(await $.store.get('count'), (await $.store.keys()).join(','))
			try { await $.store.set('big', 'x'.repeat(1100000)) } catch (error) { out.push('capped') }
		`)
		expect(text).toBe('2|count|capped')
		expect(JSON.parse(readFileSync(join(data, 'hook-module-store.json'), 'utf8'))).toEqual({
			count: 2,
		})
	})

	it('sends console output to the debug log and $.ui.log to the log', async () => {
		const debug = vi.fn()
		const info = vi.fn()
		const log = {
			...NOOP_LOGGER,
			debug,
			info,
			warn: vi.fn(),
			error: vi.fn(),
			child: () => log,
		} as never
		const { handle } = await start(
			{
				'hooks/mod.js': `
export function register(on) {
	on('classic.UserPromptSubmit', async ($) => { console.warn('from console', 1); await $.ui.log('from ui'); return {} })
}
`,
			},
			{ log },
		)
		await managerFor(handle).executeHooks('user_prompt_submit', { sessionId: SESSION, prompt: 'x' })
		expect(
			debug.mock.calls.some((call) =>
				String(call[0]).includes('plug console.warn: from console 1'),
			),
		).toBe(true)
		expect(info.mock.calls.some((call) => call[1]?.['namzu.hook_module.text'] === 'from ui')).toBe(
			true,
		)
	})
})

describe('a module that does not load', () => {
	it('is unloaded when it throws as it registers', async () => {
		const { handle } = await start({
			'hooks/mod.js': `export function register(on) { on('classic.Stop', () => ({})); throw new Error('bad start') }`,
		})
		const manager = managerFor(handle)
		expect(one(await manager.executeHooks('turn_end', { sessionId: SESSION }))).toMatchObject({
			action: 'continue',
			notice: expect.stringContaining('bad start'),
		})
		expect(handle.status).toBe('unloaded')
		expect(handle.message).toContain('failed to load')
		// Unloaded, it stays quiet.
		expect(one(await manager.executeHooks('turn_end', { sessionId: SESSION }))).toEqual({
			action: 'continue',
		})
	})

	it('is unloaded when it registers nothing', async () => {
		const { handle } = await start({ 'hooks/mod.js': 'export function register(on) {}' })
		expect(handle.status).toBe('unloaded')
		expect(handle.hooks).toEqual([])
	})

	it('is unloaded when register is not a function, or a pattern repeats without a matcher', async () => {
		const missing = await start({ 'hooks/mod.js': 'export const value = 1' })
		expect(missing.handle.status).toBe('unloaded')
		const repeated = await start({
			'hooks/mod.js': `export function register(on) { on('classic.Stop', () => ({})); on('classic.Stop', () => ({})) }`,
		})
		expect(repeated.handle.message).toContain('registered twice without a matcher')
	})

	it('leaves another plugin running when one module is bad', async () => {
		const bad = await start({
			'hooks/mod.js': `export function register(on) { throw new Error('x') }`,
		})
		const good = await start({ 'hooks/mod.js': GUARD })
		const manager = new PluginLifecycleManager({
			pluginRegistry: {} as never,
			scopeRoots: { project: process.cwd(), user: process.cwd() },
			log: NOOP_LOGGER,
		})
		for (const hook of [...bad.handle.hooks, ...good.handle.hooks]) {
			manager.registerHook('p_pair' as PluginId, hook)
		}
		expect(
			one(await manager.executeHooks('user_prompt_submit', { sessionId: SESSION, prompt: 'hi' })),
		).toEqual({ action: 'annotate', text: 'asked: hi' })
		expect(bad.handle.status).toBe('unloaded')
		expect(good.handle.status).toBe('running')
	})

	it('ends its worker when it is disposed, and runs nothing afterwards', async () => {
		const { handle } = await start({ 'hooks/mod.js': GUARD })
		const manager = managerFor(handle)
		await manager.executeHooks('user_prompt_submit', { sessionId: SESSION, prompt: 'hi' })
		await handle.dispose()
		expect(
			one(await manager.executeHooks('user_prompt_submit', { sessionId: SESSION, prompt: 'hi' })),
		).toEqual({
			action: 'continue',
		})
	})
})

describe('a module in TypeScript and a module of several files', () => {
	it('runs a .ts module with its types stripped, and imports its own files', async () => {
		const { handle } = await start(
			{
				'hooks/mod.ts': `
import type { Register } from '${COMMON_MODULE_TYPES_SPECIFIER}'
import { greeting } from './greeting.js'
export const register: Register = (on) => {
	on('classic.UserPromptSubmit', ($, e: { prompt: string }) => ({ additionalContext: [greeting(e.prompt)] }))
}
`,
				'hooks/greeting.ts': `export function greeting(who: string): string { return 'hello ' + who }`,
			},
			{},
			'hooks/mod.ts',
		)
		expect(handle.message).toBeUndefined()
		expect(handle.status).toBe('running')
		expect(
			one(
				await managerFor(handle).executeHooks('user_prompt_submit', {
					sessionId: SESSION,
					prompt: 'there',
				}),
			),
		).toEqual({ action: 'annotate', text: 'hello there' })
	})
})
