/**
 * Hands the main screen back from the spaces screen before the conversation unmounts, waiting at
 * most `limitMs`. When the wait runs out the caller moves on, and the release is told it is no
 * longer wanted, so a slow step cannot write to the terminal after Ink has unmounted.
 */
export async function leaveSpacesBounded(options: {
	release: (stillWanted: () => boolean) => Promise<boolean>
	flush: () => Promise<void>
	limitMs: number
}): Promise<void> {
	let wanted = true
	let timer: ReturnType<typeof setTimeout> | undefined
	const hand = async (): Promise<void> => {
		if (await options.release(() => wanted)) {
			if (wanted) await options.flush()
		}
	}
	try {
		await Promise.race([
			hand().catch(() => undefined),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, options.limitMs)
			}),
		])
	} finally {
		wanted = false
		clearTimeout(timer)
	}
}
