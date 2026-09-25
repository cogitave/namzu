import { describe, expect, it } from 'vitest'

import type { SessionId } from '../../../types/ids/index.js'
import type { Message } from '../../../types/message/index.js'
import type { SessionRecord } from '../../../types/session/records.js'
import {
	type MakeSessionLog,
	SESSION_LOG_CONTRACT_VERSION,
	type SessionLogConformanceOptions,
	defineSessionLogConformance,
} from '../conformance.js'
import type {
	BeginTurnOptions,
	ReadSessionLogOptions,
	SessionLogClaimOptions,
	SessionLogRead,
	TurnStartedDraft,
} from '../core.js'
import { foldSessionMessages } from '../fold.js'
import { type ClaimSessionOptions, InMemorySessionLeaseStore, type SessionLease } from '../lease.js'
import { InMemorySessionLog } from '../memory.js'

/**
 * The suite is only worth shipping if it fails a log that breaks the rules.
 * Each broken log below makes one mistake a first implementation makes, and
 * the suite is run against it with a recording `describe`/`it`, so the cases
 * that fail can be named.
 */

type Outcome = { readonly name: string; readonly failure?: string }

async function runConformance(makeLog: MakeSessionLog): Promise<Outcome[]> {
	const cases: { name: string; body: () => Promise<void> }[] = []
	const record: SessionLogConformanceOptions['describe'] = (_name, body) => {
		body()
	}
	const collect: SessionLogConformanceOptions['it'] = (name, body) => {
		cases.push({ name, body })
	}
	defineSessionLogConformance({
		describe: record,
		it: collect,
		expect,
		contractVersion: SESSION_LOG_CONTRACT_VERSION,
		makeLog,
	})
	const outcomes: Outcome[] = []
	for (const one of cases) {
		try {
			await one.body()
			outcomes.push({ name: one.name })
		} catch (error) {
			outcomes.push({
				name: one.name,
				failure: error instanceof Error ? error.message : String(error),
			})
		}
	}
	return outcomes
}

function failed(outcomes: readonly Outcome[]): string[] {
	return outcomes.filter((o) => o.failure !== undefined).map((o) => o.name)
}

function handleFor(make: (sessionId: SessionId) => InMemorySessionLog): MakeSessionLog {
	return (sessionId) => {
		const log = make(sessionId)
		return {
			log,
			reopen: () => log.reopen(),
			tamper: {
				bytes: async () => log.medium.bytes(),
				overwrite: async (bytes) => log.medium.overwrite(bytes),
			},
		}
	}
}

/** Hands the session to every taker at fence 1. */
class GrantsEveryClaim extends InMemorySessionLeaseStore {
	override async claim(options: ClaimSessionOptions): Promise<SessionLease> {
		return { holder: options.holder, fence: 1, expiresAt: (options.now ?? 0) + options.ttlMs }
	}
	override async fence(): Promise<number> {
		return 1
	}
}

/** Closes an interrupted turn without being asked. */
class ClosesInterruptedTurns extends InMemorySessionLog {
	override beginTurn(lease: SessionLease, draft: TurnStartedDraft, _options?: BeginTurnOptions) {
		return super.beginTurn(lease, draft, { abandonInterrupted: true })
	}
	override reopen(): ClosesInterruptedTurns {
		return new ClosesInterruptedTurns({
			sessionId: this.sessionId,
			medium: this.medium,
			leases: this.leaseStore,
			spills: this.spillStore,
		})
	}
}

/** Folds the model's raw text: ignores message_replaced. */
class IgnoresReplacements extends InMemorySessionLog {
	override async messages(options: { readonly throughSeq?: number } = {}): Promise<Message[]> {
		const read = await this.readAll({ throughSeq: options.throughSeq })
		return foldSessionMessages(
			read.entries
				.map((e) => e.record)
				.filter((record: SessionRecord) => record.type !== 'message_replaced'),
			{ readSpill: (ref) => this.readSpill(ref) },
		)
	}
}

/** Never refuses a break: every read is tolerant. */
class NeverRefuses extends InMemorySessionLog {
	override readAll(options: ReadSessionLogOptions = {}): Promise<SessionLogRead> {
		return super.readAll({ ...options, mode: 'tolerant' })
	}
	override reopen(): NeverRefuses {
		return new NeverRefuses({
			sessionId: this.sessionId,
			medium: this.medium,
			leases: this.leaseStore,
			spills: this.spillStore,
		})
	}
}

/** Ignores the admission option and repairs the log during claim. */
class EagerlyHealsClaims extends InMemorySessionLog {
	override claim(options: SessionLogClaimOptions) {
		return super.claim({ ...options, repairTornTail: true })
	}
	override reopen(): EagerlyHealsClaims {
		return new EagerlyHealsClaims({
			sessionId: this.sessionId,
			medium: this.medium,
			leases: this.leaseStore,
			spills: this.spillStore,
		})
	}
}

describe('the session-log conformance suite', () => {
	it('passes the reference implementation', async () => {
		const outcomes = await runConformance(
			handleFor((sessionId) => new InMemorySessionLog({ sessionId })),
		)
		expect(failed(outcomes)).toEqual([])
		expect(outcomes.length).toBeGreaterThan(8)
	})

	it('fails a log that hands the lease to every taker', async () => {
		const leases = () => new GrantsEveryClaim()
		const names = failed(
			await runConformance(
				handleFor((sessionId) => new InMemorySessionLog({ sessionId, leases: leases() })),
			),
		)
		expect(names).toContain('lets one holder write at a time and refuses a superseded lease')
	})

	it('fails a log that closes an interrupted turn without being asked', async () => {
		const names = failed(
			await runConformance(handleFor((sessionId) => new ClosesInterruptedTurns({ sessionId }))),
		)
		expect(names).toEqual([
			'refuses a turn while one is interrupted, and abandonInterrupted closes only that turn',
		])
	})

	it('fails a log whose fold shows the raw answer', async () => {
		const names = failed(
			await runConformance(handleFor((sessionId) => new IgnoresReplacements({ sessionId }))),
		)
		expect(names).toEqual(['folds messages across compaction and replacement'])
	})

	it('fails a log that reads past a flipped byte', async () => {
		const names = failed(
			await runConformance(handleFor((sessionId) => new NeverRefuses({ sessionId }))),
		)
		expect(names).toEqual([
			'refuses a flipped byte on a strict read, and a tolerant read stops before it',
		])
	})

	it('fails a log that ignores deferred repair during owner admission', async () => {
		const names = failed(
			await runConformance(handleFor((sessionId) => new EagerlyHealsClaims({ sessionId }))),
		)
		expect(names).toEqual(['defers torn-tail repair on an admission claim until the first append'])
	})
})
