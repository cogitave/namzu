import { describe, expect, it, vi } from 'vitest'

import { InMemoryRunStore } from '../../../store/run/memory.js'
import type { RunId, SessionId, TenantId } from '../../../types/ids/index.js'
import type { RunStore } from '../../../types/run/store.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { NOOP_LOGGER, NOOP_SINK, createLogger } from '../../../utils/log/index.js'
import type { LogRecord, LogSink } from '../../../utils/log/types.js'
import type { Logger } from '../../../utils/logger.js'
import { RunPersistence } from '../persistence.js'

/**
 * The durability asymmetry LOG-14 exists to pin (ses_020 §5): an audit
 * write failure fails the operation it was recording; a log sink failure
 * never does, even for the one log record `recordAudit` itself emits.
 */

function stubStore(overrides: Partial<RunStore> = {}): RunStore {
	return {
		initRun: vi.fn(async () => null),
		writeRunMeta: vi.fn(async () => {}),
		writeMessages: vi.fn(async () => {}),
		appendEvent: vi.fn(async () => {}),
		readEvents: vi.fn(async () => []),
		writeReport: vi.fn(async () => null),
		readCompletedTools: vi.fn(async () => new Map()),
		getRunDir: vi.fn(() => null),
		...overrides,
	}
}

function makeRunMgr(opts: { runStore: RunStore; log?: Logger }): RunPersistence {
	return new RunPersistence({
		runId: 'run_audit_durability' as RunId,
		agentId: 'agent_audit_durability',
		agentName: 'Audit Durability Test Agent',
		runConfig: { model: 'test-model', timeoutMs: 1000, tokenBudget: 1000 },
		providerId: 'mock',
		outputDir: '/tmp/namzu-audit-durability-test',
		log: opts.log ?? NOOP_LOGGER,
		sessionId: 'ses_audit_durability' as SessionId,
		topicId: 'top_audit_durability' as TopicId,
		tenantId: 'tnt_audit_durability' as TenantId,
		projectId: 'prj_audit_durability' as ProjectId,
		runStore: opts.runStore,
	})
}

describe('RunPersistence.recordAudit — the durability asymmetry (LOG-14)', () => {
	it('an audit write failure fails the operation', async () => {
		const store = stubStore({
			appendAuditEvent: vi.fn(async () => {
				throw new Error('disk full')
			}),
			readAuditEvents: vi.fn(async () => []),
		})
		const runMgr = makeRunMgr({ runStore: store })
		await runMgr.init()

		await expect(
			runMgr.recordAudit({ what: { action: 'tool_call', tool: 'bash' }, outcome: 'refused' }),
		).rejects.toThrow('disk full')
	})

	it('refuses rather than degrading when the bound store has no audit trail at all', async () => {
		const store = stubStore() // no appendAuditEvent/readAuditEvents
		const runMgr = makeRunMgr({ runStore: store })
		await runMgr.init()

		await expect(
			runMgr.recordAudit({ what: { action: 'tool_call', tool: 'bash' }, outcome: 'refused' }),
		).rejects.toThrow(/does not implement appendAuditEvent/)
	})

	it('a log sink failure never fails the operation it is recording', async () => {
		const throwingSink: LogSink = {
			emit: () => {
				throw new Error('sink is down')
			},
		}
		const log = createLogger({
			sink: throwingSink,
			level: { current: 'info' },
			resource: { 'service.name': 'test' },
			scope: 'test',
		})
		const runMgr = makeRunMgr({ runStore: new InMemoryRunStore(), log })
		await runMgr.init()

		// The audit write itself lands; the bridge log record on top of it goes
		// through a sink that throws on every call, and createLogger's dispatch
		// swallows that. Same asymmetry design §5 states, pinned at the one
		// point the two pipelines actually touch.
		await expect(
			runMgr.recordAudit({ what: { action: 'tool_call', tool: 'bash' }, outcome: 'refused' }),
		).resolves.toMatchObject({ outcome: 'refused' })
	})

	it('is durable even when the installed sink is NOOP at level silent', async () => {
		const store = new InMemoryRunStore()
		const log = createLogger({
			sink: NOOP_SINK,
			level: { current: 'silent' },
			resource: { 'service.name': 'test' },
			scope: 'test',
		})
		const runMgr = makeRunMgr({ runStore: store, log })
		await runMgr.init()

		await runMgr.recordAudit({ what: { action: 'tool_call', tool: 'bash' }, outcome: 'refused' })

		const trail = await store.readAuditEvents()
		expect(trail).toHaveLength(1)
		expect(trail[0]?.outcome).toBe('refused')
	})

	it('emits at most one operational log record per audit write, carrying only the pointer', async () => {
		const emitted: LogRecord[] = []
		const capturingSink: LogSink = {
			emit: (record) => {
				emitted.push(record)
			},
		}
		const log = createLogger({
			sink: capturingSink,
			level: { current: 'debug' },
			resource: { 'service.name': 'test' },
			scope: 'test',
		})
		const runMgr = makeRunMgr({ runStore: new InMemoryRunStore(), log })
		await runMgr.init()

		const event = await runMgr.recordAudit({
			what: { action: 'tool_call', tool: 'bash' },
			outcome: 'refused',
		})

		expect(emitted).toHaveLength(1)
		// A POINTER — id and seq — never a copy of the event's own content.
		// Duplicating cost/who/what/outcome into the log record is exactly the
		// second, diverging history design §5 rules out.
		expect(Object.keys(emitted[0]?.attributes ?? {}).sort()).toEqual(
			['namzu.audit.event_id', 'namzu.audit.seq'].sort(),
		)
		expect(emitted[0]?.attributes['namzu.audit.event_id']).toBe(event.id)
		expect(emitted[0]?.attributes['namzu.audit.seq']).toBe(event.seq)
	})
})
