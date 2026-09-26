import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
	MockLLMProvider,
	SessionPaths,
	type ToolContext,
	asTaskId,
	defineTool,
	getBuiltinTools,
	mcpJsonSchemaToZod,
	toolset,
} from '@namzu/sdk'
import { afterEach, expect, it } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { openManagedWorktrees } from '../../worktrees/managed.js'
import { subagentParentFixture } from '../__fixtures__/parent.js'
import { createSubagentRuntime } from '../runtime.js'
import { DelegatedWorktreeDriver } from '../worktree-driver.js'

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((settle) => {
		resolve = settle
	})
	return { promise, resolve }
}

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

function sourceCheckouts() {
	const root = mkdtempSync(join(tmpdir(), 'namzu-isolated-child-'))
	roots.push(root)
	const main = join(root, 'main')
	const selected = join(root, 'selected')
	const stateRoot = join(root, 'state')
	mkdirSync(main)
	git(main, 'init', '--quiet')
	git(main, 'config', 'user.name', 'Namzu Test')
	git(main, 'config', 'user.email', 'namzu-test@example.invalid')
	writeFileSync(join(main, 'base.txt'), 'base\n')
	git(main, 'add', 'base.txt')
	git(main, 'commit', '--quiet', '-m', 'base')
	git(main, 'worktree', 'add', '--quiet', '-b', 'selected', selected)
	writeFileSync(join(selected, 'selected-only.txt'), 'selected branch\n')
	git(selected, 'add', 'selected-only.txt')
	git(selected, 'commit', '--quiet', '-m', 'selected')
	return { main, selected, stateRoot }
}

function toolContext(parent: Awaited<ReturnType<typeof subagentParentFixture>>): ToolContext {
	return {
		sessionId: parent.scope.sessionId,
		turnId: parent.scope.turnId,
		abortSignal: new AbortController().signal,
	} as ToolContext
}

it('retries checkout discovery after Git is initialized in the same directory', async () => {
	const root = mkdtempSync(join(tmpdir(), 'namzu-isolated-retry-'))
	roots.push(root)
	const source = join(root, 'source')
	const stateRoot = join(root, 'state')
	mkdirSync(source)
	const driver = new DelegatedWorktreeDriver(source, stateRoot)
	await expect(driver.create({ label: 'first' })).rejects.toThrow('Cannot manage worktrees here')

	git(source, 'init', '--quiet')
	git(source, 'config', 'user.name', 'Namzu Test')
	git(source, 'config', 'user.email', 'namzu-test@example.invalid')
	writeFileSync(join(source, 'base.txt'), 'base\n')
	git(source, 'add', 'base.txt')
	git(source, 'commit', '--quiet', '-m', 'base')
	const workspace = await driver.create({ label: 'second' })
	expect(git(workspace.meta.worktreePath, 'rev-parse', 'HEAD')).toBe(
		git(source, 'rev-parse', 'HEAD'),
	)
})

it('keeps an omitted workspace shared for direct scheduler tasks outside Git', async () => {
	const root = mkdtempSync(join(tmpdir(), 'namzu-shared-child-'))
	roots.push(root)
	const source = join(root, 'source')
	const stateRoot = join(root, 'state')
	mkdirSync(source)
	const parent = await subagentParentFixture(source)
	const runtime = await createSubagentRuntime({
		resolveParent: parent.resolveParent,
		cwd: source,
		worktreeStateRoot: stateRoot,
		paths: new SessionPaths({ home: stateRoot, slug: 'shared-child-test' }),
		model: 'mock-model',
		buildProvider: () => new MockLLMProvider({ turns: [{ text: 'done' }] }),
		buildTools: () => [],
	})
	try {
		const gateway = await runtime.gatewayForTurn(parent.scope.turnId)
		const task = await gateway.createTask({
			agentId: 'general-purpose',
			prompt: 'finish',
			workingDirectory: source,
		})
		const completed = await gateway.waitForTask(task.taskId)
		expect(completed.state).toBe('completed')
		expect(completed.workspace).toBeUndefined()
		expect(existsSync(join(source, '.git'))).toBe(false)
	} finally {
		await runtime.close()
	}
})

it('runs a real child write in a retained worktree based on the selected checkout', async () => {
	const { main, selected, stateRoot } = sourceCheckouts()
	const parent = await subagentParentFixture(selected)
	const write = getBuiltinTools().find((tool) => tool.name === 'write')
	if (!write) throw new Error('write tool fixture is missing')
	const runtime = await createSubagentRuntime({
		resolveParent: parent.resolveParent,
		cwd: selected,
		worktreeStateRoot: stateRoot,
		paths: new SessionPaths({ home: stateRoot, slug: 'isolated-child-test' }),
		model: 'mock-model',
		buildProvider: () =>
			new MockLLMProvider({
				turns: [
					{
						toolCalls: [
							{
								id: 'write_isolated',
								name: 'write',
								args: { path: 'child-edit.txt', content: 'kept edit' },
							},
						],
					},
					{ text: 'The edit is ready for review.' },
				],
			}),
		buildTools: () => [toolset('test', [write])],
		resolveResumeHandler: () => async (request) =>
			request.type === 'tool_review' ? { action: 'approve_tools' } : { action: 'continue' },
	})
	try {
		const result = await runtime.agentTool.execute(
			{
				description: 'edit alone',
				prompt: 'write the edit',
				workspace: 'worktree',
			},
			toolContext(parent),
		)
		expect(result.success, result.error ?? result.output).toBe(true)
		const data = result.data as {
			workspace_path: string
			workspace_branch: string
		}
		expect(data.workspace_branch).toMatch(/^namzu\//)
		expect(result.output).toContain(data.workspace_path)
		expect(readFileSync(join(data.workspace_path, 'child-edit.txt'), 'utf8')).toBe('kept edit')
		expect(readFileSync(join(data.workspace_path, 'selected-only.txt'), 'utf8')).toBe(
			'selected branch\n',
		)
		expect(existsSync(join(main, 'selected-only.txt'))).toBe(false)
		expect(existsSync(join(selected, 'child-edit.txt'))).toBe(false)
		expect(git(data.workspace_path, 'rev-parse', 'HEAD')).toBe(git(selected, 'rev-parse', 'HEAD'))
		const managed = await openManagedWorktrees(selected, { stateRoot })
		expect((await managed.inspect(basename(data.workspace_path)))?.dirty).toBe(true)
	} finally {
		await runtime.close()
	}
})

it('retains an edited worktree after cancellation has stopped the child', async () => {
	const { selected, stateRoot } = sourceCheckouts()
	const parent = await subagentParentFixture(selected)
	const started = deferred<string>()
	const unwound = deferred<void>()
	const childIdled = deferred<void>()
	const hold = defineTool({
		name: 'hold_after_edit',
		description: 'Edit once and wait for cancellation.',
		inputSchema: mcpJsonSchemaToZod({ type: 'object', properties: {} }),
		category: 'custom',
		permissions: [],
		readOnly: false,
		destructive: false,
		concurrencySafe: false,
		async execute(_input, context) {
			writeFileSync(join(context.workingDirectory, 'unfinished-edit.txt'), 'keep me')
			started.resolve(context.workingDirectory)
			await new Promise<void>((resolve) => {
				if (context.abortSignal.aborted) resolve()
				else
					context.abortSignal.addEventListener('abort', () => resolve(), {
						once: true,
					})
			})
			unwound.resolve()
			return { success: true, output: 'unwound' }
		},
	})
	const runtime = await createSubagentRuntime({
		resolveParent: parent.resolveParent,
		cwd: selected,
		worktreeStateRoot: stateRoot,
		paths: new SessionPaths({ home: stateRoot, slug: 'isolated-child-test' }),
		model: 'mock-model',
		buildProvider: () =>
			new MockLLMProvider({
				turns: [
					{
						toolCalls: [{ id: 'hold_edit', name: 'hold_after_edit', args: {} }],
					},
					{ text: 'should not complete' },
				],
			}),
		buildTools: () => [toolset('test', [hold])],
		resolveResumeHandler: () => async (request) =>
			request.type === 'tool_review' ? { action: 'approve_tools' } : { action: 'continue' },
		onEvent: (event) => {
			if (event.type === 'child_session_idled') childIdled.resolve()
		},
	})
	try {
		const launch = await runtime.agentTool.execute(
			{
				description: 'cancelled edit',
				prompt: 'make an edit, then wait',
				workspace: 'worktree',
				run_in_background: true,
			},
			toolContext(parent),
		)
		expect(launch.success).toBe(true)
		const path = await started.promise
		const data = launch.data as { task_id: string }
		const gateway = await runtime.gatewayForTurn(parent.scope.turnId)
		expect(gateway.getTask(asTaskId(data.task_id))?.workspace?.meta.worktreePath).toBe(path)
		gateway.cancelTask(asTaskId(data.task_id), 'user')
		await unwound.promise
		await childIdled.promise
		expect(gateway.getTask(asTaskId(data.task_id))?.state).toBe('canceled')
		expect(readFileSync(join(path, 'unfinished-edit.txt'), 'utf8')).toBe('keep me')
		expect(existsSync(path)).toBe(true)
	} finally {
		await runtime.close()
	}
})
