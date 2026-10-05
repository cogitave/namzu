import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDirAsync } from '../../../__fixtures__/temp-dir.js'
import { createToolPresenter } from '../../../registry/tool/presentation.js'
import { SessionPaths } from '../../../session/paths.js'
import { DiskTaskStore } from '../../../store/task/disk.js'
import type { ToolManager } from '../../../toolsets/manager.js'
import type { TaskId } from '../../../types/ids/index.js'
import { generateSessionId, generateTurnId } from '../../../utils/id.js'
import { buildTaskTools } from '../index.js'

describe('a filtered task view does not imply lost durable tasks', () => {
	let home: string
	let paths: SessionPaths
	const sessionId = generateSessionId()
	const firstTurn = generateTurnId()
	const secondTurn = generateTurnId()

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), 'namzu-task-history-'))
		paths = new SessionPaths({ home, slug: '-task-history' })
	})
	afterEach(async () => {
		vi.restoreAllMocks()
		await removeTempDirAsync(home)
	})

	const open = () => new DiskTaskStore({ paths, session: { sessionId } })
	const toolsFor = (store: DiskTaskStore, turnId: typeof firstTurn, turnStartedAt: number) => {
		const tools = new Map(
			buildTaskTools(store, { sessionId, turnId, turnStartedAt }).map((tool) => [tool.name, tool]),
		)
		const run = async (name: string, input: unknown) => {
			const tool = tools.get(name)
			if (!tool) throw new Error(`Missing task tool: ${name}`)
			return tool.execute(tool.inputSchema.parse(input), {} as never)
		}
		const registry = { get: (name: string) => tools.get(name) } as Pick<ToolManager, 'get'>
		return { run, presenter: createToolPresenter(registry) }
	}

	it('keeps two earlier completions after a later deletion and completion, while disclosing the one-row view', async () => {
		const firstStartedAt = Date.now()
		// Control only timestamps; real filesystem operations are awaited directly.
		const clock = vi.spyOn(Date, 'now').mockReturnValue(firstStartedAt)
		const first = toolsFor(open(), firstTurn, firstStartedAt)
		const create = async (subject: string, blockedBy?: TaskId[]) => {
			const result = await first.run('task_create', { subject, blockedBy })
			expect(result.success).toBe(true)
			return (result.data as { id: TaskId }).id
		}
		const write = await create('Write proof note')
		const verify = await create('Verify proof note', [write])
		const missing = await create('Check missing companion')
		const dependent = await create('Await missing companion', [missing])
		for (const id of [write, verify])
			expect((await first.run('task_update', { id, status: 'completed' })).success).toBe(true)
		expect((await first.run('task_update', { id: missing, status: 'failed' })).success).toBe(true)

		const secondStartedAt = firstStartedAt + 1_000
		clock.mockReturnValue(secondStartedAt)
		const reopened = open()
		const second = toolsFor(reopened, secondTurn, secondStartedAt)
		const before = await second.run('task_list', {})
		expect(before.data).toMatchObject({
			tasks: [{ id: dependent, status: 'pending', blockedBy: undefined }],
			stats: { total: 1, pending: 1, completed: 0, failed: 0 },
		})
		expect(before.output).toContain('3 tasks closed in earlier turns remain stored')
		expect((await second.run('task_update', { id: missing, status: 'deleted' })).success).toBe(true)
		expect((await reopened.get(dependent))?.blockedBy).toEqual([])
		expect((await second.run('task_update', { id: dependent, status: 'completed' })).success).toBe(
			true,
		)
		const result = await second.run('task_list', {})
		expect(result.data).toEqual({
			tasks: [
				{
					id: dependent,
					subject: 'Await missing companion',
					status: 'completed',
					owner: null,
					blockedBy: undefined,
					activeForm: undefined,
				},
			],
			stats: { total: 1, pending: 0, in_progress: 0, completed: 1, failed: 0 },
		})
		expect(result.output).toContain('Current-turn view: 1 task: 1 completed')
		expect(result.output).toContain(
			'2 tasks closed in earlier turns remain stored and are omitted from this view',
		)
		const durable = await open().listStrict()
		expect(durable.map((task) => task.id)).toEqual([write, verify, dependent])
		expect(durable.every((task) => task.status === 'completed')).toBe(true)
		expect(durable.find((task) => task.id === write)?.completedAt).toBe(firstStartedAt)
		expect(durable.find((task) => task.id === dependent)?.completedAt).toBe(secondStartedAt)
		expect(second.presenter.presentResult('task_list', {}, result)).toEqual({
			kind: 'generic',
			label: 'Current-turn task view · 1/1 done',
		})
	})

	it('distinguishes an empty current view from finding no session records without exposing history in the presenter', async () => {
		const firstStartedAt = Date.now()
		const clock = vi.spyOn(Date, 'now').mockReturnValue(firstStartedAt)
		const first = toolsFor(open(), firstTurn, firstStartedAt)
		const absent = await first.run('task_list', {})
		expect(absent.data).toMatchObject({ tasks: [], stats: { total: 0 } })
		expect(absent.output).toContain('No planning tasks found for this session')
		expect(absent.output).not.toContain('remain stored')
		const created = await first.run('task_create', {
			subject: 'Private historical subject',
		})
		const id = (created.data as { id: TaskId }).id
		await first.run('task_update', { id, status: 'failed' })
		clock.mockReturnValue(firstStartedAt + 1_000)
		const second = toolsFor(open(), secondTurn, firstStartedAt + 1_000)
		const filtered = await second.run('task_list', {})
		expect(filtered.data).toEqual(absent.data)
		expect(filtered.output).toContain('No open or current-turn planning tasks')
		expect(filtered.output).toContain('1 task closed in earlier turns remains stored')
		expect((await open().listStrict()).map((task) => task.id)).toEqual([id])
		const view = second.presenter.presentResult(
			'task_list',
			{},
			{
				...filtered,
				output: `Untrusted text naming ${id} and Private historical subject`,
			},
		)
		expect(view).toEqual({
			kind: 'generic',
			label: 'No open or current-turn tasks',
		})
		expect(JSON.stringify(view)).not.toContain(id)
		expect(JSON.stringify(view)).not.toContain('Private historical subject')
	})
})
