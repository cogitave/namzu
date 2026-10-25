import { useEffect, useRef } from 'react'

import { IdleCompactor } from '../integrations/compaction/idle-compaction.js'

/**
 * What the screen knows that the idle compactor needs. Read through a ref at
 * fire time, so a value that changed since the timer was armed is the one used.
 */
export interface IdleCompactionHost {
	/** Names the conversation and model; a change cancels the attempt. */
	readonly conversationKey: () => string
	/** Undefined while idle compaction is off. */
	readonly settings: () => { readonly minTokens: number } | undefined
	readonly lastInteractionAt: () => number
	readonly isTurnRunning: () => boolean
	readonly isDialogOpen: () => boolean
	readonly hasPendingWake: () => boolean
	readonly hasBackgroundWork: () => boolean
	/** Run the compaction and show its result; true when something was compacted. */
	readonly compact: () => Promise<boolean>
}

/** One compactor for the life of the screen; its timer is cleared on unmount. */
export function useIdleCompaction(host: IdleCompactionHost): {
	readonly compactor: IdleCompactor
	/** The latest context size the kernel reported, or undefined after a rewrite. */
	readonly contextTokens: { current: number | undefined }
} {
	const hostRef = useRef(host)
	hostRef.current = host
	const contextTokens = useRef<number | undefined>(undefined)
	const compactorRef = useRef<IdleCompactor | null>(null)
	if (compactorRef.current === null) {
		compactorRef.current = new IdleCompactor({
			now: Date.now,
			setTimer: (run, ms) => {
				const handle = setTimeout(run, ms)
				// The process may exit with this pending; it is not work to wait for.
				handle.unref?.()
				return handle
			},
			clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
			isEnabled: () => hostRef.current.settings() !== undefined,
			conversationKey: () => hostRef.current.conversationKey(),
			minTokens: () => hostRef.current.settings()?.minTokens ?? Number.POSITIVE_INFINITY,
			contextTokens: () => contextTokens.current,
			// No usage-limit signal reaches the terminal, so there is none to defer to.
			isNearLimit: () => false,
			lastInteractionAt: () => hostRef.current.lastInteractionAt(),
			isTurnRunning: () => hostRef.current.isTurnRunning(),
			isDialogOpen: () => hostRef.current.isDialogOpen(),
			hasPendingWake: () => hostRef.current.hasPendingWake(),
			hasBackgroundWork: () => hostRef.current.hasBackgroundWork(),
			compact: () => hostRef.current.compact(),
		})
	}
	const compactor = compactorRef.current
	useEffect(() => () => compactor.dispose(), [compactor])
	return { compactor, contextTokens }
}
