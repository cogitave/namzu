/**
 * Two Pal names are the same name when they differ only by case, spacing at the ends, or the
 * Turkish dotted and dotless i. A Turkish keyboard types "ISIK" and "ısık" for the same word.
 */
export function palNameKey(name: string): string {
	return name.trim().normalize('NFC').replace(/[İIı]/gu, 'i').replaceAll('̇', '').toLowerCase()
}

export function isDuplicatePalName(name: string, existing: readonly string[]): boolean {
	const key = palNameKey(name)
	return key.length > 0 && existing.some((item) => palNameKey(item) === key)
}

/** The first "name 2", "name 3", ... that no existing Pal uses. */
export function suggestPalName(name: string, existing: readonly string[]): string {
	const base = name.trim().replace(/\s+\d+$/u, '')
	for (let n = 2; ; n += 1) {
		const candidate = `${base} ${n}`
		if (!isDuplicatePalName(candidate, existing)) return candidate
	}
}

export function duplicatePalNameMessage(name: string, existing: readonly string[]): string {
	return `You already have a Pal called “${name.trim()}”. Try “${suggestPalName(name, existing)}”.`
}
