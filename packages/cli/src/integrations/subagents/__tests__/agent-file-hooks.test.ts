import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLLMProvider } from '@namzu/sdk'
import { expect, it } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { createCliPluginRuntime } from '../../plugins/runtime.js'
import { subagentParentFixture } from '../__fixtures__/parent.js'
import { createAgentHooksHost } from '../agent-hooks.js'
import type { AgentFileDefinition } from '../definitions.js'
import { createSubagentRuntime } from '../runtime.js'

/**
 * An agent file's hooks reach a real child run through the real CLI runtime:
 * attached when the run starts, the end-of-agent entry fired where
 * `subagent_stop` fires, two runs at once each with its own, taken off when a
 * run ends however it ends, and an agent whose guard cannot be loaded never
 * started. Real shell I/O is awaited directly; no wall-clock race decides an
 * assertion.
 */

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`

function agentFile(name: string, hooksSource: string): AgentFileDefinition {
	return {
		name,
		description: `The ${name} agent.`,
		prompt: `You are ${name}.`,
		readOnly: false,
		path: `/p/.namzu/agents/${name}.md`,
		source: 'user',
		hooksSource,
	}
}

function recorder(dir: string, name: string): { script: string; record: string } {
	const record = join(dir, `${name}.jsonl`)
	const script = join(dir, `${name}.cjs`)
	writeFileSync(
		script,
		`let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>require('node:fs').appendFileSync(${JSON.stringify(record)},s+'\\n'))`,
	)
	return { script, record }
}

const stopHooks = (script: string, spellings: readonly string[]) =>
	[
		'hooks:',
		...spellings.flatMap((event) => [
			`  ${event}:`,
			'    - hooks:',
			'        - type: command',
			`          command: ${JSON.stringify(`${quote(process.execPath)} ${quote(script)}`)}`,
		]),
	].join('\n')

async function fixture(
	definitions: readonly AgentFileDefinition[],
	turns: NonNullable<ConstructorParameters<typeof MockLLMProvider>[0]>['turns'],
	options: { withHost?: boolean } = {},
) {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-agent-hooks-'))
	const parent = await subagentParentFixture(cwd)
	// Deliberately built with nothing configured: an agent file's hooks alone make the runtime.
	const plugins = await createCliPluginRuntime(undefined, cwd, undefined, undefined, {
		keepForSkills: true,
	})
	const agentHooks = createAgentHooksHost({
		manager: () => plugins?.manager,
		hookOptions: () => plugins?.hookOptions,
		hooksSwitch: () => undefined,
		projectTrusted: () => true,
	})
	const runtime = await createSubagentRuntime({
		cwd,
		model: 'mock',
		resolveParent: parent.resolveParent,
		resolvePluginManager: () => plugins?.manager,
		buildTools: () => [],
		buildProvider: () => new MockLLMProvider({ turns }),
		definitions,
		...(options.withHost === false ? {} : { agentHooks }),
	})
	const context = {
		sessionId: parent.scope.sessionId,
		turnId: parent.scope.turnId,
		workingDirectory: cwd,
		abortSignal: new AbortController().signal,
		env: {},
		log() {},
	}
	const run = (subagent_type: string) =>
		runtime.agentTool.execute(
			{ description: 'Check', prompt: 'Answer once', subagent_type, run_in_background: false },
			context,
		)
	return {
		cwd,
		runtime,
		agentHooks,
		plugins,
		run,
		close: async () => {
			await runtime.close()
			await plugins?.close()
			removeTempDir(cwd)
		},
	}
}

const records = (path: string): Record<string, unknown>[] =>
	readFileSync(path, 'utf8')
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line))

it('fires the end-of-agent entry once, on subagent_stop, with the last message, and takes it off after', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-agent-hooks-rec-'))
	const { script, record } = recorder(dir, 'stop')
	const f = await fixture(
		// Written under both spellings: it runs once.
		[agentFile('closer', stopHooks(script, ['Stop', 'SubagentStop']))],
		[{ text: 'the closing words' }],
	)
	try {
		const result = await f.run('closer')
		expect(result.success, result.error).toBe(true)
		const seen = records(record)
		expect(seen).toHaveLength(1)
		expect(seen[0]).toMatchObject({
			hook_event_name: 'SubagentStop',
			agent_type: 'closer',
			last_assistant_message: 'the closing words',
		})
		expect(f.agentHooks.attached()).toEqual([])
		expect(f.plugins?.manager.listHooks()).toEqual([])
	} finally {
		await f.close()
		removeTempDir(dir)
	}
})

it('keeps two agents running at once apart: each fires only its own', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-agent-hooks-rec-'))
	const a = recorder(dir, 'a')
	const b = recorder(dir, 'b')
	const f = await fixture(
		[
			agentFile('alpha', stopHooks(a.script, ['SubagentStop'])),
			agentFile('beta', stopHooks(b.script, ['SubagentStop'])),
		],
		[{ text: 'one' }, { text: 'two' }],
	)
	try {
		const [first, second] = await Promise.all([f.run('alpha'), f.run('beta')])
		expect(first.success, first.error).toBe(true)
		expect(second.success, second.error).toBe(true)
		const fromA = records(a.record)
		const fromB = records(b.record)
		expect(fromA).toHaveLength(1)
		expect(fromB).toHaveLength(1)
		expect(fromA[0]?.agent_type).toBe('alpha')
		expect(fromB[0]?.agent_type).toBe('beta')
		expect(fromA[0]?.session_id).not.toBe(fromB[0]?.session_id)
	} finally {
		await f.close()
		removeTempDir(dir)
	}
})

it('takes a run’s hooks off when the run fails', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-agent-hooks-rec-'))
	const { script } = recorder(dir, 'stop')
	// No scripted answer: the child's model call fails.
	const f = await fixture([agentFile('doomed', stopHooks(script, ['SubagentStop']))], [])
	try {
		await f.run('doomed').catch(() => undefined)
		expect(f.agentHooks.attached()).toEqual([])
		expect(f.plugins?.manager.listHooks()).toEqual([])
	} finally {
		await f.close()
		removeTempDir(dir)
	}
})

it('does not start an agent that carries hooks when its host cannot attach them', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-agent-hooks-rec-'))
	const { script, record } = recorder(dir, 'stop')
	const f = await fixture(
		[agentFile('closer', stopHooks(script, ['SubagentStop']))],
		[{ text: 'never said' }],
		{ withHost: false },
	)
	try {
		const result = await f.run('closer').catch((error: Error) => ({
			success: false,
			error: error.message,
		}))
		expect(result.success).toBe(false)
		expect(JSON.stringify(result)).toContain('does not attach them')
		expect(() => readFileSync(record, 'utf8')).toThrow()
	} finally {
		await f.close()
		removeTempDir(dir)
	}
})

it('answers a launch of an agent that is not offered with the file’s own line', async () => {
	const f = await fixture([], [{ text: 'never said' }])
	const refused = await createSubagentRuntime({
		cwd: f.cwd,
		model: 'mock',
		resolveParent: (await subagentParentFixture(f.cwd)).resolveParent,
		buildTools: () => [],
		buildProvider: () => new MockLLMProvider({ turns: [] }),
		refusedDefinitions: [
			{
				name: 'broken',
				path: '/p/.namzu/agents/broken.md',
				line: 'Agent "broken" is not offered: /p/.namzu/agents/broken.md, hooks: PreToolUse group 1, hook 1 cannot be read.',
			},
		],
	})
	try {
		const parent = await subagentParentFixture(f.cwd)
		const outcome = await refused.agentTool
			.execute(
				{ description: 'Check', prompt: 'x', subagent_type: 'broken', run_in_background: false },
				{
					sessionId: parent.scope.sessionId,
					turnId: parent.scope.turnId,
					workingDirectory: f.cwd,
					abortSignal: new AbortController().signal,
					env: {},
					log() {},
				},
			)
			.catch((error: Error) => ({ success: false, error: error.message }))
		expect(outcome.success).toBe(false)
		expect(JSON.stringify(outcome)).toContain('is not offered: /p/.namzu/agents/broken.md')
	} finally {
		await refused.close()
		await f.close()
	}
})

it('gives an agent file’s command the project folder for a variable written for another tool', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-agent-hooks-rec-'))
	const out = join(dir, 'project.txt')
	const f = await fixture(
		[
			agentFile(
				'mover',
				[
					'hooks:',
					'  SubagentStop:',
					'    - hooks:',
					'        - type: command',
					`          command: ${JSON.stringify(`printf %s "$ACME_PROJECT_DIR" > ${quote(out)}`)}`,
				].join('\n'),
			),
		],
		[{ text: 'done' }],
	)
	try {
		const result = await f.run('mover')
		expect(result.success, result.error).toBe(true)
		expect(readFileSync(out, 'utf8')).toBe(f.cwd)
	} finally {
		await f.close()
		removeTempDir(dir)
	}
})
