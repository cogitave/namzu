import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type Message,
	type ProjectInstructionContext,
	type ToolResultObservation,
	createProjectInstructionMessage,
} from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { visibleProjectInstructionPath } from '../project-path.js'
import { ProjectInstructionTracker } from '../project-tracker.js'

let root: string
let repo: string

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-live-project-'))
	repo = join(root, 'repo')
	mkdirSync(join(repo, '.git'), { recursive: true })
})

afterEach(() => removeTempDir(root))

function observation(
	toolName: 'read' | 'write' | 'edit',
	path: string,
	success = true,
): ToolResultObservation {
	return {
		runId: 'run_project_tracker' as ToolResultObservation['runId'],
		toolUseId: 'call_project_tracker',
		toolName,
		input: { path },
		result: success
			? { success: true, output: 'ok' }
			: { success: false, output: '', error: 'failed' },
	}
}

async function initial(context: ProjectInstructionContext, messages: readonly Message[] = []) {
	return await context.prepareInitialSnapshot?.({
		messages,
		signal: new AbortController().signal,
	})
}

async function observe(
	context: ProjectInstructionContext,
	result: ToolResultObservation,
	messages: readonly Message[],
) {
	return await context.observeToolResult(result, {
		messages,
		signal: new AbortController().signal,
	})
}

describe('ProjectInstructionTracker', () => {
	it('renders terminal controls and bidi format characters as visible escapes', () => {
		const dangerous = `pkg/${String.fromCodePoint(0x1b, 0x85, 0x9b, 0x202e, 0x2066)}AGENTS.md`
		const rendered = visibleProjectInstructionPath(dangerous)

		expect(rendered).toBe('pkg/\\u001b\\u0085\\u009b\\u202e\\u2066AGENTS.md')
		expect(rendered).toMatch(/^[\x20-\x7e]*$/)
	})

	it('discovers a nested scope after a successful file read and replaces the snapshot', async () => {
		const pkg = join(repo, 'packages', 'a')
		mkdirSync(pkg, { recursive: true })
		writeFileSync(join(repo, 'AGENTS.md'), 'Root rule.')
		writeFileSync(join(pkg, 'AGENTS.md'), 'Nested rule.')
		writeFileSync(join(pkg, 'file.ts'), 'export const value = 1\n')
		const tracker = new ProjectInstructionTracker(repo)
		const context = tracker.createRunContext()

		const baseline = await initial(context)
		expect(baseline?.source).toEqual({
			type: 'project-instructions',
			files: ['AGENTS.md'],
		})
		const update = await observe(
			context,
			observation('read', 'packages/a/file.ts'),
			baseline ? [baseline] : [],
		)

		expect(update?.source).toEqual({
			type: 'project-instructions',
			files: ['AGENTS.md', 'packages/a/AGENTS.md'],
		})
		expect(update?.content).toContain('Root rule.')
		expect(update?.content).toContain('Nested rule.')
		expect(update?.content).toContain('only paths under `packages/a/`')
		expect(update?.retain).toBe(true)
	})

	it('re-reads an edited instruction file and explicitly removes a blank one', async () => {
		writeFileSync(join(repo, 'AGENTS.md'), 'Rule A.')
		const tracker = new ProjectInstructionTracker(repo)
		const context = tracker.createRunContext()
		const baseline = await initial(context)

		writeFileSync(join(repo, 'AGENTS.md'), 'Rule B.')
		const updated = await observe(
			context,
			observation('edit', 'AGENTS.md'),
			baseline ? [baseline] : [],
		)
		expect(updated?.content).toContain('Rule B.')

		writeFileSync(join(repo, 'AGENTS.md'), '')
		expect(
			await observe(context, observation('write', 'AGENTS.md'), updated ? [updated] : []),
		).toBeNull()
		expect(tracker.instructionFiles).toEqual([])
	})

	it('uses persisted paths only for discovery and re-reads authoritative disk text', async () => {
		const pkg = join(repo, 'pkg')
		mkdirSync(pkg)
		writeFileSync(join(pkg, 'AGENTS.md'), 'Current disk policy.')
		const forged = createProjectInstructionMessage('Persisted stale policy.', ['pkg/AGENTS.md'])
		const tracker = new ProjectInstructionTracker(repo)

		const snapshot = await initial(tracker.createRunContext(), [
			forged,
			{ role: 'user', content: 'continue', timestamp: 1 },
		])

		expect(snapshot?.content).toContain('Current disk policy.')
		expect(snapshot?.content).not.toContain('Persisted stale policy.')
	})

	it('gives sibling runs independent drain cursors over shared discovery', async () => {
		const pkg = join(repo, 'pkg')
		mkdirSync(pkg)
		writeFileSync(join(pkg, 'AGENTS.md'), 'Package policy.')
		writeFileSync(join(pkg, 'file.ts'), 'x')
		const tracker = new ProjectInstructionTracker(repo)
		const parent = tracker.createRunContext()
		const child = tracker.createRunContext()
		const parentBaseline = await initial(parent)
		const childBaseline = await initial(child)

		expect(
			(
				await observe(
					child,
					observation('read', 'pkg/file.ts'),
					childBaseline ? [childBaseline] : [],
				)
			)?.content,
		).toContain('Package policy.')
		// The parent compares shared state on its next actual tool result; the
		// child's read did not change the parent's durable-message cursor.
		const parentUpdate = await observe(
			parent,
			{
				...observation('read', 'pkg/file.ts'),
				toolName: 'Agent',
			},
			parentBaseline ? [parentBaseline] : [],
		)
		expect(parentUpdate?.content).toContain('Package policy.')
	})

	it('ignores failed file operations', async () => {
		const pkg = join(repo, 'pkg')
		mkdirSync(pkg)
		writeFileSync(join(pkg, 'AGENTS.md'), 'Must stay undiscovered.')
		writeFileSync(join(pkg, 'file.ts'), 'x')
		const tracker = new ProjectInstructionTracker(repo)
		const context = tracker.createRunContext()
		const baseline = await initial(context)

		expect(
			await observe(context, observation('read', 'pkg/file.ts', false), baseline ? [baseline] : []),
		).toBeUndefined()
		expect(tracker.instructionFiles).toEqual([])
	})
})
