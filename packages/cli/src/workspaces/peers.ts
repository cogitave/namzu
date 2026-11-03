import { watch } from 'node:fs'
import {
	PeerClient,
	type PeerRecord,
	type PeerSessionState,
	readPeerRecords,
	resolveNamzuHome,
} from '@namzu/sdk'
import { resolvePeerRuntime } from '../integrations/peers/runtime.js'

/**
 * Where the host learns what its sessions are doing. Each session's own terminal
 * publishes a live record and answers a ping; nothing is read off its screen.
 */
export interface PeerSource {
	/** Every live-session record in the runtime directory. */
	records(): readonly PeerRecord[]
	/** Asks a terminal for its state now; undefined when it did not answer. */
	ping(record: PeerRecord): Promise<PeerSessionState | undefined>
	/** Calls `onChange` when records are written or removed; returns how to stop. */
	watch?(onChange: () => void): () => void
}

/** Picks the record that belongs to a host slot; a copy that came from a nested run loses to the session's own process. */
export function recordForSlot(
	records: readonly PeerRecord[],
	slot: string,
	pid: number | undefined,
): PeerRecord | undefined {
	const mine = records.filter((r) => r.hostSlot === slot)
	return mine.find((r) => r.pid === pid) ?? [...mine].sort((a, b) => a.startedAt - b.startedAt)[0]
}

/** The record of the process the host itself runs in, for a session that is not a child: the one with its own id. */
export function recordForPid(
	records: readonly PeerRecord[],
	pid: number | undefined,
): PeerRecord | undefined {
	if (pid === undefined) return undefined
	return records.find((r) => r.pid === pid)
}

export function createPeerSource(env: NodeJS.ProcessEnv): PeerSource | undefined {
	let runtime: ReturnType<typeof resolvePeerRuntime>
	try {
		runtime = resolvePeerRuntime(resolveNamzuHome({ env }), env)
	} catch {
		return undefined
	}
	const client = new PeerClient({ timeoutMs: 500 })
	return {
		records: () => readPeerRecords(runtime.sessionsDir),
		async ping(record) {
			const result = await client.ping(record.address)
			return result.kind === 'responded' && result.ok ? result.state : undefined
		},
		watch(onChange) {
			try {
				const watcher = watch(runtime.sessionsDir, () => onChange())
				watcher.on('error', () => {})
				return () => watcher.close()
			} catch {
				return () => {}
			}
		},
	}
}
