import { useEffect, useState } from 'react'
import type { DesktopApi } from '../shared/protocol.js'
import { type PalOperatorMessage, operatorMessages } from './pal-operator-messages.js'

/**
 * What the person has sent this Pal from their own conversations, read again whenever
 * `refreshKey` changes (a turn starting or finishing). A failed read keeps what was shown.
 */
export function usePalOperatorMessages(
	api: Pick<DesktopApi, 'palInbox'>,
	sessionId: string,
	palId: string | undefined,
	refreshKey: string,
): readonly PalOperatorMessage[] {
	const [state, setState] = useState<{ key: string; messages: readonly PalOperatorMessage[] }>({
		key: '',
		messages: [],
	})
	const owner = `${sessionId}\n${palId ?? ''}`
	// biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey only asks for another read
	useEffect(() => {
		if (!palId || !sessionId || !api.palInbox) return
		let current = true
		void api
			.palInbox(sessionId, palId)
			.then((rows) => {
				if (current) setState({ key: owner, messages: operatorMessages(rows) })
			})
			.catch(() => {})
		return () => {
			current = false
		}
	}, [api, sessionId, palId, owner, refreshKey])
	return state.key === owner ? state.messages : []
}
