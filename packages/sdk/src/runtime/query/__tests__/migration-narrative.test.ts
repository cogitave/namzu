import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { BOOT_EVENT_NAMES } from '../../../constants/telemetry/index.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import {
	MARKER_REL_PATH,
	MIGRATION_VERSION,
	writeMarker,
} from '../../../session/migration/index.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { ProjectId, ThreadId } from '../../../types/session/ids.js'
import type { LogRecord, LogSink } from '../../../utils/log/index.js'
import { __resetProcessSinkForTests, installProcessSink } from '../../../utils/log/process-sink.js'
import { drainQuery } from '../index.js'

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
	__resetProcessSinkForTests()
})

function baseParams(workingDirectory: string, suffix: string) {
	return {
		provider: new MockLLMProvider({ turns: [{ text: 'done' }] }),
		tools: new ToolRegistry(),
		runConfig: {
			model: 'mock-model',
			timeoutMs: 10_000,
			tokenBudget: 100_000,
			maxIterations: 3,
			maxResponseTokens: 256,
		},
		agentId: 'agent_boot',
		agentName: 'Boot Agent',
		messages: [createUserMessage('go')],
		workingDirectory,
		sessionId: `ses_boot_${suffix}` as SessionId,
		threadId: `thd_boot_${suffix}` as ThreadId,
		projectId: `prj_boot_${suffix}` as ProjectId,
		tenantId: `tnt_boot_${suffix}` as TenantId,
	}
}

function migrationRecordsFrom(records: LogRecord[]): LogRecord[] {
	return records.filter((r) => r.eventName === BOOT_EVENT_NAMES.MIGRATION_COMPLETED)
}

describe('the boot-time filesystem migration reaches a log through a real query() run', () => {
	it('a legacy .namzu layout produces one namzu.migration.completed record at info, carrying kind/markerPath/count', async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-migration-narrative-'))
		dirs.push(workingDirectory)

		await mkdir(join(workingDirectory, '.namzu', 'threads', 'thd_legacy', 'runs', 'run_1'), {
			recursive: true,
		})

		const records: LogRecord[] = []
		const sink: LogSink = { emit: (record) => records.push(record) }
		installProcessSink(sink, 'debug', { replace: true })

		await drainQuery(baseParams(workingDirectory, 'migrated'))

		const migrationRecords = migrationRecordsFrom(records)
		expect(migrationRecords).toHaveLength(1)
		expect(migrationRecords[0]?.severityText).toBe('info')
		expect(migrationRecords[0]?.attributes.kind).toBe('migrated')
		expect(migrationRecords[0]?.attributes.markerPath).toContain('.migration')
		expect(migrationRecords[0]?.attributes.migratedThreadCount).toBe(1)
	})

	it('a fresh root with no legacy layout logs noop_no_legacy at debug under the same event name', async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-migration-narrative-'))
		dirs.push(workingDirectory)

		const records: LogRecord[] = []
		const sink: LogSink = { emit: (record) => records.push(record) }
		installProcessSink(sink, 'debug', { replace: true })

		await drainQuery(baseParams(workingDirectory, 'noop'))

		const migrationRecords = migrationRecordsFrom(records)
		expect(migrationRecords).toHaveLength(1)
		expect(migrationRecords[0]?.severityText).toBe('debug')
		expect(migrationRecords[0]?.attributes.kind).toBe('noop_no_legacy')
	})

	it('a root with an existing migration marker logs already_migrated at debug under the same event name', async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-migration-narrative-'))
		dirs.push(workingDirectory)

		const migrationRoot = join(workingDirectory, '.namzu')
		await writeMarker(join(migrationRoot, MARKER_REL_PATH), {
			version: MIGRATION_VERSION,
			at: new Date(),
			migratedThreads: [],
		})

		const records: LogRecord[] = []
		const sink: LogSink = { emit: (record) => records.push(record) }
		installProcessSink(sink, 'debug', { replace: true })

		await drainQuery(baseParams(workingDirectory, 'already'))

		const migrationRecords = migrationRecordsFrom(records)
		expect(migrationRecords).toHaveLength(1)
		expect(migrationRecords[0]?.severityText).toBe('debug')
		expect(migrationRecords[0]?.attributes.kind).toBe('already_migrated')
	})
})
