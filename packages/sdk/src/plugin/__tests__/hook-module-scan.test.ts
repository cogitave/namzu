/**
 * What is read from a hooks module before anything runs it: where the hooks
 * file says it is, what it hooks and calls, and what refuses it.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { COMMON_MODULE_TYPES_SPECIFIER } from '../common-layout-names.js'
import { readCommonLayout } from '../common-layout/read.js'
import {
	hookModuleConsentEntry,
	hookModuleConsentLines,
	summarizeHookModule,
} from '../hook-module/consent.js'
import { resolvePattern } from '../hook-module/events.js'
import { type HookModuleScan, locateHookModule, scanHookModule } from '../hook-module/scan.js'

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function plugin(files: Record<string, string>): string {
	const root = join(mkdtempSync(join(tmpdir(), 'namzu-hscan-')), 'plug')
	roots.push(dirname(root))
	mkdirSync(root, { recursive: true })
	for (const [path, text] of Object.entries(files)) {
		const full = join(root, path)
		mkdirSync(dirname(full), { recursive: true })
		writeFileSync(full, text)
	}
	return root
}

const hooksJson = (modules: unknown) => JSON.stringify({ modules })

function scan(source: string, extra: Record<string, string> = {}): HookModuleScan {
	const root = plugin({ 'hooks/mod.js': source, ...extra })
	return scanHookModule(root, 'hooks/mod.js')
}

const refused = (result: HookModuleScan): string[] => result.refusals.map((item) => item.message)

describe('where the hooks file says the module is', () => {
	it('takes one path, relative to the hooks file', () => {
		const root = plugin({ 'hooks/hooks.json': hooksJson(['./mod.js']), 'hooks/mod.js': '' })
		expect(locateHookModule(root)).toMatchObject({ kind: 'found', entry: 'hooks/mod.js' })
		const upward = plugin({ 'hooks/hooks.json': hooksJson(['../lib/mod.js']) })
		expect(locateHookModule(upward)).toMatchObject({ kind: 'found', entry: 'lib/mod.js' })
	})

	it('knows no module when there is none, or the file is missing', () => {
		expect(locateHookModule(plugin({}))).toEqual({ kind: 'none' })
		expect(locateHookModule(plugin({ 'hooks/hooks.json': '{"hooks":{}}' }))).toEqual({
			kind: 'none',
		})
		expect(locateHookModule(plugin({ 'hooks/hooks.json': hooksJson([]) }))).toEqual({
			kind: 'none',
		})
	})

	it('refuses two modules, a path that leaves the plugin, an absolute path and a non-path', () => {
		const message = (modules: unknown) => {
			const found = locateHookModule(plugin({ 'hooks/hooks.json': hooksJson(modules) }))
			return found.kind === 'refused' ? found.message : found.kind
		}
		expect(message(['./a.js', './b.js'])).toContain(
			'names one hooks module per plugin; a second entry is refused',
		)
		expect(message(['../../outside.js'])).toContain('leaves the plugin folder')
		expect(message(['/etc/x.js'])).toContain('absolute path')
		expect(message([3])).toContain('must name a file')
		expect(message('./a.js')).toContain('must be a list')
	})

	it('does not follow a link for the hooks file, and reads no more than a mebibyte of it', () => {
		const root = plugin({ 'real.json': hooksJson(['./mod.js']) })
		mkdirSync(join(root, 'hooks'))
		symlinkSync(join(root, 'real.json'), join(root, 'hooks/hooks.json'))
		expect(locateHookModule(root)).toEqual({ kind: 'none' })
		const large = plugin({
			'hooks/hooks.json': `{"modules":["./a.js"],"pad":"${'x'.repeat(1024 * 1024)}"}`,
		})
		expect(locateHookModule(large)).toEqual({ kind: 'none' })
	})
})

describe('what a module hooks and calls', () => {
	it('lists the patterns, their matchers and catches, and the calls on $', () => {
		const result = scan(`
export function register(on) {
	on('classic.PreToolUse', { tool: 'Bash' }, async ($, e) => {
		await $.process.run(['git', 'status'])
		return {}
	}).catch(() => ({ deny: 'x' }))
	on('classic.UserPromptSubmit', ($, e) => ({ additionalContext: [$.plugin.name, $.plugin.root] }))
	on('classic.Stop', async ($) => ({ additionalContext: [String(await $.env.get('NAMZU_HOME_NAME')), await $.fs.read('x'), (await $.http.fetch('https://example.com')).text, await $.store.get('k')] }))
}
`)
		expect(result.refusals).toEqual([])
		expect(
			result.hooks.map((hook) => [hook.pattern, hook.matcher, hook.catches, hook.runs]),
		).toEqual([
			['classic.PreToolUse', true, true, ['pre_tool_use']],
			['classic.UserPromptSubmit', false, false, ['user_prompt_submit']],
			['classic.Stop', false, false, ['turn_end']],
		])
		expect(result.calls.map((call) => call.call)).toEqual([
			'$.process.run',
			'$.env.get',
			'$.fs.read',
			'$.http.fetch',
			'$.store.get',
		])
		expect(result.envNames).toEqual(['NAMZU_HOME_NAME'])
		const summary = summarizeHookModule(result)
		expect(summary).toMatchObject({
			runsCommands: true,
			readsFiles: true,
			usesNetwork: true,
			keepsData: true,
			readsEnvironment: ['NAMZU_HOME_NAME'],
			events: ['PreToolUse', 'Stop', 'UserPromptSubmit'],
		})
		expect(hookModuleConsentLines(summary)).toEqual([
			'hooks PreToolUse, Stop, UserPromptSubmit',
			'runs commands',
			'reads files in the plugin and the project',
			'uses the network',
			"keeps data in the plugin's data folder",
			'reads environment variables NAMZU_HOME_NAME',
		])
		expect(hookModuleConsentEntry('plug', result)).toMatchObject({
			plugin: 'plug',
			module: 'hooks/mod.js',
		})
	})

	it('lists what Namzu has no place for as not used, and still loads the rest', () => {
		const result = scan(`
export function register(on) {
	on('tool.call', ($, e, next) => next(e))
	on('ui.*', () => ({}))
	on('classic.Setup', () => ({}))
	on('classic.Stop', async ($) => { await $.session.root(); return {} })
}
`)
		expect(result.refusals).toEqual([])
		const summary = summarizeHookModule(result)
		expect(summary.notUsed).toEqual([
			'Namzu runs classic.* hooks from modules; tool.call is not available.',
			'Namzu runs classic.* hooks from modules; ui.* is not available.',
			'Namzu runs classic.* hooks from modules; classic.Setup is not available.',
			'$.session.root is not available in Namzu; calling it throws.',
		])
		expect(summary.events).toEqual(['Stop'])
		expect(result.program).toBeDefined()
	})

	it('resolves patterns: names, globs and negations', () => {
		expect(resolvePattern('classic.PreToolUse')).toEqual({ ok: true, runs: ['pre_tool_use'] })
		expect(resolvePattern('classic.Stop')).toEqual({ ok: true, runs: ['turn_end'] })
		expect(resolvePattern('*')).toMatchObject({ ok: true })
		expect((resolvePattern('classic.*') as unknown as { runs: string[] }).runs).toContain(
			'session_start',
		)
		const negated = resolvePattern('!classic.PreToolUse') as unknown as { runs: string[] }
		expect(negated.runs).not.toContain('pre_tool_use')
		expect(negated.runs).toContain('post_tool_use')
		expect(resolvePattern('!tool.*')).toMatchObject({ ok: true })
		expect(resolvePattern('classic.Nope')).toEqual({
			ok: false,
			message: '"classic.Nope" is not an event',
		})
		expect(resolvePattern('nothing.*')).toEqual({
			ok: false,
			message: '"nothing.*" is not a pattern: it selects no event',
		})
		expect(resolvePattern('turn_end')).toMatchObject({ ok: false })
	})
})

describe('a module in TypeScript', () => {
	it('has its types erased without the runtime printing a warning about it', async () => {
		const warnings: string[] = []
		const listener = (warning: Error): void => {
			warnings.push(warning.message)
		}
		process.on('warning', listener)
		try {
			const root = plugin({
				'hooks/mod.ts': `export function register(on: (p: string, h: () => object) => void): void { on('classic.Stop', (): object => ({})) }`,
			})
			const result = scanHookModule(root, 'hooks/mod.ts')
			expect(result.refusals).toEqual([])
			expect(result.program?.files['hooks/mod.ts']).not.toContain(': object')
			await new Promise((resolve) => setImmediate(resolve))
		} finally {
			process.off('warning', listener)
		}
		expect(warnings.filter((text) => /stripTypeScriptTypes|type stripping/i.test(text))).toEqual([])
	})

	it('refuses syntax that is not only types, such as an enum', () => {
		const root = plugin({
			'hooks/mod.ts': `enum Mode { A }\nexport function register(on) { on('classic.Stop', () => ({})) }`,
		})
		expect(refused(scanHookModule(root, 'hooks/mod.ts'))[0]).toContain(
			'does not parse as TypeScript',
		)
	})
})

describe('what refuses a module', () => {
	it('refuses a dynamic import and a top-level await, with the file and line', () => {
		const dynamic = scan(
			`export function register(on) {\n\ton('classic.Stop', async () => { await import('node:fs'); return {} })\n}`,
		)
		expect(dynamic.refusals[0]).toMatchObject({ file: 'hooks/mod.js', line: 2 })
		expect(refused(dynamic)[0]).toContain(
			'a dynamic import(); a hooks module imports its own files with an import declaration',
		)
		const top = scan(
			`await Promise.resolve()\nexport function register(on) { on('classic.Stop', () => ({})) }`,
		)
		expect(refused(top)[0]).toContain('a top-level await')
		expect(top.refusals[0]?.line).toBe(1)
		const inside = scan(
			`export function register(on) { on('classic.Stop', async () => { await 1; return {} }) }`,
		)
		expect(inside.refusals).toEqual([])
	})

	it('refuses the names a script climbs to a constructor with, written out', () => {
		for (const written of [
			'console.log.constructor',
			"e['constructor']",
			'e.__proto__',
			'Object.getPrototypeOf(e)',
			'Reflect.setPrototypeOf(e, null)',
		]) {
			const result = scan(
				`export function register(on) { on('classic.PreToolUse', ($, e) => ({ x: ${written} })) }`,
			)
			expect(refused(result).join(' ')).toContain('reaches the functions behind')
		}
	})

	it('refuses an import of anything but its own files', () => {
		const result = scan(
			`import { readFileSync } from 'node:fs'\nexport function register(on) { on('classic.Stop', () => ({})) }`,
		)
		expect(refused(result)[0]).toContain(
			`cannot import "node:fs" (from hooks/mod.js): a hooks module imports its own files by relative path and "${COMMON_MODULE_TYPES_SPECIFIER}", nothing else`,
		)
		const bare = scan(
			`import x from 'left-pad'\nexport function register(on) { on('classic.Stop', () => ({})) }`,
		)
		expect(refused(bare)[0]).toContain('cannot import "left-pad"')
		const value = scan(
			`import { x } from '${COMMON_MODULE_TYPES_SPECIFIER}'\nexport function register(on) { on('classic.Stop', () => ({})) }`,
		)
		expect(refused(value)[0]).toContain('as a value')
		const missing = scan(
			`import { x } from './nowhere.js'\nexport function register(on) { on('classic.Stop', () => ({})) }`,
		)
		expect(refused(missing)[0]).toContain('no such file in the plugin')
	})

	it('refuses a registration that is not a function or whose event name is not a literal', () => {
		const notFunction = scan(`export function register(on) { on('classic.Stop', 'x') }`)
		expect(refused(notFunction)[0]).toContain('is not a function declared at the top of this file')
		const computed = scan(
			`export function register(on) { const name = 'classic.Stop'; on(name, () => ({})) }`,
		)
		expect(refused(computed)[0]).toContain('the event name passed to on() is not a string literal')
		const wrongCount = scan(`export function register(on) { on('classic.Stop') }`)
		expect(refused(wrongCount)[0]).toContain(
			'on() takes (pattern, hook) or (pattern, matcher, hook)',
		)
		const named = scan(
			`function guard() { return {} }\nexport function register(on) { on('classic.Stop', guard) }`,
		)
		expect(named.refusals).toEqual([])
		const bound = scan(
			`const guard = 3\nexport function register(on) { on('classic.Stop', guard) }`,
		)
		expect(refused(bound)[0]).toContain('is not a function declared at the top of this file')
	})

	it('refuses an unknown name, a glob that selects nothing, and a repeat without a matcher', () => {
		const unknown = scan(`export function register(on) { on('classic.Nope', () => ({})) }`)
		expect(refused(unknown)[0]).toContain('"classic.Nope" is not an event')
		const empty = scan(`export function register(on) { on('mystery.*', () => ({})) }`)
		expect(refused(empty)[0]).toContain('"mystery.*" is not a pattern: it selects no event')
		const repeat = scan(
			`export function register(on) {\n\ton('classic.Stop', () => ({}))\n\ton('classic.Stop', () => ({}))\n}`,
		)
		expect(refused(repeat)[0]).toContain(
			'registered twice without a matcher; the first is at hooks/mod.js:2',
		)
		const matched = scan(
			`export function register(on) { on('classic.Stop', () => ({})); on('classic.Stop', { reason: 'x' }, () => ({})) }`,
		)
		expect(matched.refusals).toEqual([])
	})

	it('refuses $ and on used other than as $.noun.event(...) and on("<event>", hook)', () => {
		const spelled = '$ is always spelled $.noun.event(...) at the call site'
		const variants = [
			'const q = $.fs',
			`$['fs'].read('x')`,
			`$.fs.read.call(null, 'x')`,
			'const t = $',
			'foo($)',
			'$.fs',
		]
		for (const body of variants) {
			const result = scan(
				`export function register(on) { on('classic.Stop', async ($) => { ${body}; return {} }) }`,
			)
			expect(refused(result).join('\n'), body).toContain(spelled)
		}
		const bound = scan(
			`export function register(on) { const t = on; t('classic.Stop', () => ({})) }`,
		)
		expect(refused(bound)[0]).toContain('on is always on("<event>", hook)')
		const passed = scan('export function register(on) { helper(on) }')
		expect(refused(passed)[0]).toContain('on is always on("<event>", hook)')
	})

	it('refuses a module that does not parse, that has no register, or is JSX', () => {
		const syntax = scan(`export function register(on) { on('classic.Stop', ( => {}) }`)
		expect(refused(syntax)[0]).toContain('hooks/mod.js does not parse:')
		expect(syntax.refusals[0]?.line).toBe(1)
		const none = scan('export const x = 1')
		expect(refused(none)[0]).toContain('does not export a function named register')
		const jsx = scanHookModule(plugin({ 'hooks/mod.jsx': '' }), 'hooks/mod.jsx')
		expect(refused(jsx)[0]).toContain('JSX is not supported')
	})

	it('refuses a link, an oversized file and a file outside the plugin', () => {
		const root = plugin({
			'hooks/real.js': `export function register(on) { on('classic.Stop', () => ({})) }`,
		})
		symlinkSync(join(root, 'hooks/real.js'), join(root, 'hooks/mod.js'))
		expect(refused(scanHookModule(root, 'hooks/mod.js'))[0]).toContain(
			'is a link, and links are not followed',
		)
		const large = plugin({
			'hooks/mod.js': `export function register(on) { on('classic.Stop', () => ({})) }\n// ${'x'.repeat(1024 * 1024)}`,
		})
		expect(refused(scanHookModule(large, 'hooks/mod.js'))[0]).toContain('is larger than 1024 KiB')
		const escaping = scan(
			`import { x } from '../../outside.js'\nexport function register(on) { on('classic.Stop', () => ({})) }`,
		)
		expect(refused(escaping)[0]).toContain('no such file in the plugin')
	})

	it('refuses both of two modules, each for its own reason, and scans neither as a program', () => {
		const first = scan(
			`import 'node:fs'\nexport function register(on) { on('classic.Stop', () => ({})) }`,
		)
		const second = scan(`export function register(on) { on('classic.Nope', () => ({})) }`)
		expect(first.program).toBeUndefined()
		expect(second.program).toBeUndefined()
		expect(refused(first)[0]).toContain('node:fs')
		expect(refused(second)[0]).toContain('classic.Nope')
	})

	it('follows the files a module imports, and refuses what is in them', () => {
		const result = scan(
			`import { helper } from './helper.js'\nexport function register(on) { on('classic.Stop', () => helper()) }`,
			{ 'hooks/helper.js': `export async function helper() { return import('node:os') }` },
		)
		expect(result.files).toEqual(['hooks/mod.js', 'hooks/helper.js'])
		expect(result.refusals[0]).toMatchObject({ file: 'hooks/helper.js' })
	})
})

describe('a hooks module in the common layout, read with the plugin', () => {
	const MANIFEST = '.claude-plugin/plugin.json'
	const ok = `export function register(on) { on('classic.PreToolUse', () => ({})); on('tool.call', ($, e, next) => next(e)) }`

	it('lifts the refusal for a module in hooks/hooks.json, and reports it and what is not used', async () => {
		const root = plugin({
			[MANIFEST]: JSON.stringify({ name: 'plug' }),
			'hooks/hooks.json': JSON.stringify({ modules: ['./mod.js'] }),
			'hooks/mod.js': ok,
		})
		const read = await readCommonLayout(root)
		expect(read.refusal).toBeUndefined()
		expect(read.findings.find((f) => f.code === 'hooks-modules-refused')).toBeUndefined()
		expect(read.findings.find((f) => f.code === 'hooks-module-used')).toMatchObject({
			level: 'used',
			path: 'hooks/mod.js',
		})
		expect(read.findings.find((f) => f.code === 'hooks-module-not-used')).toMatchObject({
			level: 'notUsed',
			message: 'Namzu runs classic.* hooks from modules; tool.call is not available.',
		})
	})

	it('refuses a module the scan refuses and keeps the plain entries of the same file', async () => {
		const root = plugin({
			[MANIFEST]: JSON.stringify({ name: 'plug' }),
			'hooks/hooks.json': JSON.stringify({
				modules: ['./mod.js'],
				hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'true' }] }] },
			}),
			'hooks/mod.js': `import 'node:fs'\nexport function register(on) {}`,
		})
		const read = await readCommonLayout(root)
		expect(read.refusal).toBeUndefined()
		expect(read.findings.find((f) => f.code === 'hooks-module-scan-refused')).toMatchObject({
			level: 'refused',
			path: 'hooks/mod.js',
		})
		expect(
			Object.keys(read.manifest?.hookEntries ?? {}).length + (read.manifest?.hooks?.length ?? 0),
		).toBeGreaterThan(0)
		expect(read.findings.find((f) => f.code === 'hooks-used')).toBeDefined()
	})

	it('still refuses a .js path given directly in the manifest, and a modules list in another hooks file', async () => {
		const root = plugin({
			[MANIFEST]: JSON.stringify({ name: 'plug', hooks: ['./hooks/direct.js', './other.json'] }),
			'hooks/direct.js': ok,
			'other.json': JSON.stringify({ modules: ['./m.js'] }),
		})
		const read = await readCommonLayout(root)
		expect(read.findings.find((f) => f.code === 'hooks-module-refused')).toMatchObject({
			level: 'refused',
			path: 'hooks/direct.js',
		})
		expect(read.findings.find((f) => f.code === 'hooks-modules-refused')).toMatchObject({
			level: 'refused',
			path: 'other.json',
		})
	})

	it('refuses a second module entry as the reference does', async () => {
		const root = plugin({
			[MANIFEST]: JSON.stringify({ name: 'plug' }),
			'hooks/hooks.json': JSON.stringify({ modules: ['./a.js', './b.js'] }),
		})
		const read = await readCommonLayout(root)
		expect(read.findings.find((f) => f.code === 'hooks-modules-refused')?.message).toContain(
			'names one hooks module per plugin; a second entry is refused',
		)
	})
})
