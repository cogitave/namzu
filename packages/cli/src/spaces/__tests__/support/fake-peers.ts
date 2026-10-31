import type { PeerRecord, PeerSessionState } from '@namzu/sdk'
import type { PeerSource } from '../../peers.js'

export class FakePeers implements PeerSource {
	records_: PeerRecord[] = []
	answers = new Map<string, PeerSessionState | undefined>()
	watchers = new Set<() => void>()
	records(): readonly PeerRecord[] {
		return this.records_
	}
	async ping(record: PeerRecord): Promise<PeerSessionState | undefined> {
		return this.answers.get(record.sessionId)
	}
	watch(onChange: () => void): () => void {
		this.watchers.add(onChange)
		return () => this.watchers.delete(onChange)
	}
	/** A terminal writes (or rewrites) its live record. */
	publish(slot: string, state: PeerSessionState, extra: Partial<PeerRecord> = {}): void {
		const record = {
			v: 1,
			sessionId: `id-${slot}`,
			ref: 'abcdef',
			pid: 1,
			startedAt: 1,
			kind: 'tui',
			cwd: '/work',
			permissionMode: 'default',
			state,
			acceptsMessages: true,
			address: `uds:/tmp/${slot}.sock`,
			token: 'x'.repeat(16),
			protocol: 'namzu-peer/1',
			cliVersion: '1',
			hostSlot: slot,
			...extra,
		} as PeerRecord
		this.records_ = [...this.records_.filter((r) => r.hostSlot !== slot), record]
		for (const watcher of this.watchers) watcher()
	}
}
