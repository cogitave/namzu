import { useEffect, useMemo, useState } from 'react'
import type { ConversationSearchHit, DesktopApi } from '../shared/protocol.js'

type Bridge = Pick<DesktopApi, 'searchConversations'>

/** How long typing must pause before the text is searched. */
export const CONVERSATION_SEARCH_DELAY_MS = 220
export const CONVERSATION_SEARCH_MIN_CHARS = 2

export interface ConversationTextMatches {
	/** The text these matches answer; they apply only while the box still holds it. */
	query: string
	/** Palette item id to the short excerpt that matched. */
	excerpts: ReadonlyMap<string, string>
}

/**
 * Searches what conversations said while someone types. Typing restarts a short wait; only the newest
 * request may answer; a failed search leaves the title matches as they are. Timers are the platform's,
 * so a test drives them with fake ones.
 */
export class ConversationSearch {
	private timer: ReturnType<typeof setTimeout> | undefined
	private latest = 0
	constructor(
		private readonly search: (query: string) => Promise<ConversationSearchHit[]>,
		private readonly publish: (matches: ConversationTextMatches | undefined) => void,
	) {}
	change(raw: string): void {
		this.stop()
		const query = raw.trim()
		if (query.length < CONVERSATION_SEARCH_MIN_CHARS) {
			this.publish(undefined)
			return
		}
		const mine = this.latest
		this.timer = setTimeout(() => {
			this.search(query).then(
				(hits) => {
					if (this.latest !== mine) return
					this.publish({
						query,
						excerpts: new Map(
							hits.map((hit) => [`conversation:${hit.conversationId}`, hit.excerpt]),
						),
					})
				},
				() => {
					if (this.latest === mine) this.publish(undefined)
				},
			)
		}, CONVERSATION_SEARCH_DELAY_MS)
	}
	/** Drops the wait and any answer still on its way. */
	stop(): void {
		clearTimeout(this.timer)
		this.latest++
	}
}

/** Matches inside what conversations said, for the search box; `onQueryChange` is absent without the bridge. */
export function useConversationSearch(api: Bridge | undefined, open: boolean) {
	const [matches, setMatches] = useState<ConversationTextMatches>()
	const search = api?.searchConversations
	const controller = useMemo(
		() => (search ? new ConversationSearch(search, setMatches) : undefined),
		[search],
	)
	useEffect(() => {
		if (open) return
		controller?.stop()
		setMatches(undefined)
	}, [open, controller])
	useEffect(() => () => controller?.stop(), [controller])
	return {
		matches,
		onQueryChange: controller ? (value: string) => controller.change(value) : undefined,
	}
}
