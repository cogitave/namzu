/**
 * An extension's open page goes with the extension when it is turned off or removed. Only when that
 * happened: a refusal (wrong or missing administrator password, a wait, a locked extension) leaves the
 * page open, so a wrong password cannot be used to shut someone's Records page.
 */
export function closePageAfter(
	method: string,
	id: string | undefined,
	done: Promise<unknown>,
	close: (id: string) => void,
): Promise<unknown> {
	if (method !== 'namzu/extensions/remove' && method !== 'namzu/extensions/disable') return done
	if (!id) return done
	return done.then((result) => {
		const refused =
			typeof result === 'object' &&
			result !== null &&
			'error' in (result as Record<string, unknown>)
		if (!refused) close(id)
		return result
	})
}
