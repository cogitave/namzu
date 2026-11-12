import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
	AGENT_OK,
	COMMAND_OK,
	FIXTURE_CASES,
	type FixtureSet,
	SKILL_OK,
	createFixtureSet,
	goodPlugin,
	manifest,
} from '../../__fixtures__/plugin-folders.js'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { validatePluginFolder } from './validate.js'

let set: FixtureSet

beforeAll(() => {
	set = createFixtureSet()
})
afterAll(() => removeTempDir(set.base))
afterEach(() => vi.restoreAllMocks())

const codes = (report: Awaited<ReturnType<typeof validatePluginFolder>>, level: string) =>
	report.problems
		.filter((p) => p.level === level)
		.map((p) => p.code)
		.sort()

describe('a good plugin', () => {
	it('has every kind of part and no problem', async () => {
		const report = await validatePluginFolder(goodPlugin(set))
		expect(report.problems).toEqual([])
		expect(report.status).toBe('clean')
		expect(report.plugin).toEqual({ name: 'ledger', version: '1.0.0' })
		const kinds = new Set(report.parts.map((p) => p.kind))
		expect([...kinds].sort()).toEqual(
			['agent', 'command', 'hook', 'manifest', 'mcp-server', 'skill', 'tool'].sort(),
		)
		expect(report.parts.every((p) => p.status === 'ok')).toBe(true)
	})
})

describe('each mistake', () => {
	for (const fixture of FIXTURE_CASES) {
		it(`${fixture.name}: errors ${JSON.stringify(fixture.errors)}`, async () => {
			const dir = set.plugin(`case-${fixture.name}`, fixture.files(set))
			const report = await validatePluginFolder(dir)
			expect(codes(report, 'error')).toEqual([...fixture.errors].sort())
			for (const code of fixture.warnings) expect(codes(report, 'warning')).toContain(code)
			if (fixture.errors.length === 0 && fixture.warnings.length === 0) {
				expect(report.status).toBe('clean')
			} else {
				expect(report.status).toBe(fixture.errors.length > 0 ? 'errors' : 'warnings')
			}
			// Every problem says what the loader does about it, in a sentence.
			for (const problem of report.problems) {
				expect(problem.message.length).toBeGreaterThan(10)
				expect(problem.consequence.length).toBeGreaterThan(10)
			}
		})
	}
})

describe('where in the file', () => {
	it('gives the line of a JSON syntax error', async () => {
		const dir = set.plugin('line-json', { 'plugin.json': '{\n  "name": "x",\n  oops\n}' })
		const report = await validatePluginFolder(dir)
		const [problem] = report.problems
		expect(problem?.file).toBe('plugin.json')
		expect(problem?.line).toBe(3)
	})

	it('gives the line of the manifest key a schema problem is about', async () => {
		const dir = set.plugin('line-schema', {
			'plugin.json': '{\n  "name": "Bad Name",\n  "version": "1.0.0",\n  "description": "d"\n}',
		})
		const report = await validatePluginFolder(dir)
		expect(report.problems[0]).toMatchObject({ code: 'manifest-schema', line: 2 })
	})

	it('gives the line of an unknown manifest key and of an array element', async () => {
		const dir = set.plugin('line-unknown', {
			'plugin.json':
				'{\n  "name": "x",\n  "version": "1.0.0",\n  "description": "d",\n  "instructions": "i",\n  "skils": []\n}',
		})
		const report = await validatePluginFolder(dir)
		expect(report.problems[0]).toMatchObject({ code: 'manifest-unknown-key', line: 6 })
		const strict = set.plugin('line-strict', {
			'plugin.json':
				'{\n  "name": "x",\n  "version": "1.0.0",\n  "description": "d",\n  "mcpServers": [\n    {\n      "name": "a",\n      "command": "node",\n      "url": "u"\n    }\n  ]\n}',
		})
		const second = await validatePluginFolder(strict)
		expect(second.problems[0]).toMatchObject({ code: 'manifest-schema', line: 9 })
	})

	it('gives the line of the frontmatter key a skill or agent problem is about', async () => {
		const skill = set.plugin('line-skill', {
			'plugin.json': manifest({ skills: ['skills/reconcile'] }),
			'skills/reconcile/SKILL.md':
				'---\nname: reconcile\ndescription: d\ninvocation: sometimes\n---\nbody\n',
		})
		expect((await validatePluginFolder(skill)).problems[0]).toMatchObject({
			file: 'skills/reconcile/SKILL.md',
			line: 4,
		})
		const agent = set.plugin('line-agent', {
			'plugin.json': manifest({ agents: ['agents'] }),
			'agents/x.md': '---\nname: x\ndescription: d\nmaxTurns: lots\n---\nbody\n',
		})
		expect((await validatePluginFolder(agent)).problems[0]).toMatchObject({
			file: 'agents/x.md',
			line: 4,
			code: 'agent-invalid',
		})
	})
})

describe('a refused manifest', () => {
	it('still names the plugin when its name and version are plain text', async () => {
		const dir = set.plugin('identity', { 'plugin.json': '{"name":"ledger","version":"2.0.0"}' })
		const report = await validatePluginFolder(dir)
		expect(report.plugin).toEqual({ name: 'ledger', version: '2.0.0' })
		expect(report.problems[0]?.message).toMatch(/^"description": /)
	})

	it('writes a path into an array as [n]', async () => {
		const dir = set.plugin('path-words', {
			'plugin.json': manifest({ mcpServers: [{ name: 'db', command: 'node', url: 'u' }] }),
		})
		const report = await validatePluginFolder(dir)
		expect(report.problems[0]?.message).toContain('"mcpServers[0]" has a field')
	})
})

describe('a folder it cannot read', () => {
	it('reports a missing folder and a file as unreadable', async () => {
		const missing = await validatePluginFolder(join(set.base, 'nowhere'))
		expect(missing.status).toBe('unreadable')
		expect(missing.readError).toMatch(/does not exist/)
		const file = await validatePluginFolder(join(set.outsideDir, 'secret.md'))
		expect(file.status).toBe('unreadable')
		expect(file.readError).toMatch(/not a folder/)
	})
})

describe('the JSON shape', () => {
	it('is the documented one', async () => {
		const dir = set.plugin('shape', {
			'plugin.json': manifest({ skills: ['skills/reconcile'], commands: ['commands'] }),
			'skills/reconcile/SKILL.md': SKILL_OK.replace(
				'---\nCompare',
				'allowed_tools: x\n---\nCompare',
			),
			'commands/audit.md': COMMAND_OK,
		})
		const report = await validatePluginFolder(dir)
		expect(Object.keys(report).sort()).toEqual(
			['folder', 'parts', 'plugin', 'problems', 'status', 'summary', 'version'].sort(),
		)
		expect(report.version).toBe(1)
		expect(report.plugin).toEqual({ name: 'ledger', version: '1.0.0' })
		expect(report.summary).toEqual({ errors: 0, warnings: 1 })
		expect(report.parts.map((p) => `${p.kind}:${p.name}:${p.status}`)).toEqual([
			'manifest:plugin.json:ok',
			'skill:skills/reconcile:warning',
			'command:ledger__audit:ok',
		])
		const [problem] = report.problems
		expect(Object.keys(problem ?? {}).sort()).toEqual(
			['code', 'consequence', 'file', 'level', 'line', 'message', 'part'].sort(),
		)
		// It survives a round trip through JSON unchanged.
		expect(JSON.parse(JSON.stringify(report))).toEqual(report)
	})
})

describe('it runs nothing from the plugin', () => {
	it('starts no process, imports no module and writes no marker', async () => {
		const marker = join(set.base, 'marker')
		const write = `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'ran')\n`
		const cp = (await import('node:child_process')).default
		const spies = (
			['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const
		).map((name) => vi.spyOn(cp, name))
		const dir = set.plugin('runs-nothing', {
			'plugin.json': manifest({
				tools: ['tools/index.js'],
				hooks: ['hooks/index.js'],
				skills: ['skills/reconcile'],
				mcpServers: [{ name: 'db', command: 'node', args: ['server.js', '--marker', marker] }],
				commands: ['commands'],
				agents: ['agents'],
			}),
			'tools/index.js': `${write}export const tools = []\n`,
			'hooks/index.js': `${write}export const hooks = []\n`,
			'server.js': write,
			'skills/reconcile/SKILL.md': `${SKILL_OK}\nRun scripts/go.js\n`,
			'skills/reconcile/scripts/go.js': write,
			'commands/audit.md': `${COMMAND_OK}\n!\`node -e "require('fs').writeFileSync('${marker}','ran')"\`\n`,
			'agents/reviewer.md': AGENT_OK,
		})
		const report = await validatePluginFolder(dir)
		expect(report.summary.errors).toBe(0)
		expect(existsSync(marker)).toBe(false)
		for (const spy of spies) expect(spy).not.toHaveBeenCalled()
		// Nor is a child process hanging off this one (Linux only).
		const tasks = existsSync('/proc/self/task') ? readdirSync('/proc/self/task') : []
		for (const task of tasks) {
			const path = `/proc/self/task/${task}/children`
			if (existsSync(path)) expect(readFileSync(path, 'utf8').trim()).toBe('')
		}
	})

	it('makes no network request', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch')
		const net = await import('node:net')
		const connect = vi.spyOn(net.default, 'connect')
		await validatePluginFolder(goodPlugin(set, 'no-network'))
		expect(fetchSpy).not.toHaveBeenCalled()
		expect(connect).not.toHaveBeenCalled()
	})

	it('leaves the plugin folder byte for byte as it was', async () => {
		const dir = goodPlugin(set, 'untouched')
		const snapshot = (): string =>
			readdirSync(dir, { recursive: true, withFileTypes: true })
				.map((e) => `${e.parentPath}/${e.name}`)
				.sort()
				.join('\n')
		const before = snapshot()
		await validatePluginFolder(dir)
		expect(snapshot()).toBe(before)
	})
})

describe('a reference that leaves the folder', () => {
	it('is reported and the target is never read', async () => {
		// The target holds a marker string; if it were read into a message it would show.
		writeFileSync(join(set.outsideDir, 'leak.md'), 'LEAK-MARKER-9f2c\n')
		const dir = set.plugin('leave', {
			'plugin.json': manifest({ skills: ['skills/reconcile'], tools: ['/etc/hostname'] }),
			'skills/reconcile/SKILL.md': { link: join(set.outsideDir, 'leak.md') },
		})
		const report = await validatePluginFolder(dir)
		expect(report.problems.map((p) => p.code).sort()).toEqual(['path-outside', 'path-outside'])
		expect(JSON.stringify(report)).not.toContain('LEAK-MARKER-9f2c')
	})
})
