/**
 * One search fold for the whole app, independent of the operating system's locale.
 *
 * `toLocaleLowerCase()` under a Turkish locale turns `I` into `ı`, so an all-caps English word
 * stops matching, and plain `toLowerCase()` leaves `İ` as `i` plus a combining dot. Here the
 * text is decomposed, the combining marks are dropped (the dot of `İ` and the accents of Ş, Ğ,
 * Ü, Ö, Ç), the dotless `ı` is mapped to `i`, and only then lower-cased, so I, ı, İ and i all
 * compare equal whatever the locale is.
 */
export function foldSearchText(text: string): string {
	return text.normalize('NFD').replace(/\p{M}/gu, '').replace(/ı/g, 'i').toLowerCase()
}

/** True when the folded `text` contains the folded `term`. */
export function foldedIncludes(text: string, term: string): boolean {
	return foldSearchText(text).includes(foldSearchText(term))
}
