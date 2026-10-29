import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DiskSessionLog, MockLLMProvider, type SessionEvent } from '@namzu/sdk'
import { expect, it, vi } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { createCliPluginRuntime } from '../../plugins/runtime.js'
import { subagentParentFixture } from '../__fixtures__/parent.js'
import { createSubagentRuntime } from '../runtime.js'

// Real shell I/O is awaited directly; no wall-clock race decides the assertion.
it('runs the configured start hook once through the real CLI child with its own scope', async () => {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-child-hooks-'))
	const parent = await subagentParentFixture(cwd)
	const record = join(cwd, 'events.jsonl')
	const script = join(cwd, 'record.cjs')
	writeFileSync(
		script,
		`let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>require('node:fs').appendFileSync(${JSON.stringify(record)},s+'\\n'))`,
	)
	const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`
	let plugins: Awaited<ReturnType<typeof createCliPluginRuntime>>
	const events: SessionEvent[] = []
	const runtime = await createSubagentRuntime({
		cwd,
		model: 'mock',
		resolveParent: parent.resolveParent,
		resolvePluginManager: () => plugins?.manager,
		buildTools: () => [],
		buildProvider: () => new MockLLMProvider({ turns: [{ text: 'child done' }] }),
		// A void callback may return push's length; it is not an async listener.
		onEvent: (event) => events.push(event),
	})
	try {
		// Deliberately initialize after delegation, like the TUI entry point.
		plugins = await createCliPluginRuntime(undefined, cwd, {
			subagent_start: [{ command: `${quote(process.execPath)} ${quote(script)}` }],
		})
		const result = await runtime.agentTool.execute(
			{ description: 'Check', prompt: 'Answer once', run_in_background: false },
			{
				sessionId: parent.scope.sessionId,
				turnId: parent.scope.turnId,
				workingDirectory: cwd,
				abortSignal: new AbortController().signal,
				env: {},
				log() {},
			},
		)
		expect(result.success, result.error).toBe(true)
		const recorded = readFileSync(record, 'utf8')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line))
		expect(recorded).toHaveLength(1)
		const started = events.find((event) => event.type === 'turn_started')
		expect(started).toBeDefined()
		expect(recorded[0]).toMatchObject({
			hook_event_name: 'SubagentStart',
			parent_session_id: parent.scope.sessionId,
			parent_turn_id: parent.scope.turnId,
			agent_type: 'namzu-cli',
			session_id: started?.sessionId,
			turn_id: started?.turnId,
		})
		expect(recorded[0].session_id).not.toBe(parent.scope.sessionId)
	} finally {
		await runtime.close()
		await plugins?.close()
		removeTempDir(cwd)
	}
})

it('runs ephemeral children without opening a disk transcript, including a continuation', async () => {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-child-transient-'))
	const parent = await subagentParentFixture(cwd)
	const disk = vi.spyOn(DiskSessionLog, 'at')
	const runtime = await createSubagentRuntime({
		cwd,
		ephemeral: true,
		model: 'mock',
		resolveParent: parent.resolveParent,
		buildTools: () => [],
		buildProvider: () => new MockLLMProvider({ turns: [{ text: 'child done' }] }),
	})
	const context = {
		sessionId: parent.scope.sessionId,
		turnId: parent.scope.turnId,
		workingDirectory: cwd,
		abortSignal: new AbortController().signal,
		env: {},
		log() {},
	}
	try {
		const result = await runtime.agentTool.execute(
			{ name: 'worker', description: 'Check', prompt: 'Answer', run_in_background: false },
			context,
		)
		expect(result.success, result.error).toBe(true)
		const continued = await runtime.sendMessageTool.execute(
			{ task_id: 'worker', message: 'Again' },
			context,
		)
		expect(continued.success, continued.error).toBe(true)
		const done = await runtime.waitForTaskTool.execute({ task_id: 'worker' }, context)
		expect(done.success, done.error).toBe(true)
		expect(disk).not.toHaveBeenCalled()
	} finally {
		await runtime.close()
		disk.mockRestore()
		removeTempDir(cwd)
	}
})
