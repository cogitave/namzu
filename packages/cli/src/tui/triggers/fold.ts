/**
 * Case- and accent-folding for composer-trigger matching, with a map back to
 * the draft the operator is editing.
 *
 * One grapheme at a time: canonical decomposition (NFD), combining marks
 * dropped, dotless `ı` to `i`, plain `toLowerCase()`, and the typographic
 * apostrophes `’`/`‘` to `'`. So `İSTANBUL` folds to `istanbul`, `KAYDET` to
 * `kaydet`, `ÇALIŞTIR` to `calistir` and `skill’e` to `skill'e`.
 *
 * Folding DOES merge different words: `sık`/`sik`, `düş`/`duş`, `aşı`/`ası`,
 * `şişe`/`sise` all fold to one string. The built-in phrase lists are checked
 * for that against a word list (`__tests__/fold.test.ts`), so no built-in
 * token folds onto a different common word.
 *
 * Pure and locale-free: the same input folds the same way on every machine.
 */

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export interface FoldedText {
	/** The folded text. */
	readonly text: string
	/**
	 * `map[i]` is the offset in the source of the grapheme folded character `i`
	 * came from; `map[text.length]` is the source's length. A span `[a, b)` of
	 * the folded text is `[map[a], map[b])` of the source, and always covers
	 * whole graphemes.
	 */
	readonly map: readonly number[]
}

/** Fold one grapheme cluster. */
export function foldGrapheme(grapheme: string): string {
	return grapheme
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.replace(/ı/g, 'i')
		.toLowerCase()
		.replace(/[’‘]/g, "'")
}

/** Fold a whole string, keeping where every folded character came from. */
export function foldWithMap(source: string): FoldedText {
	let text = ''
	const map: number[] = []
	for (const { segment, index } of graphemes.segment(source)) {
		const folded = foldGrapheme(segment)
		for (let i = 0; i < folded.length; i += 1) map.push(index)
		text += folded
	}
	map.push(source.length)
	return { text, map }
}

/** Fold a string whose offsets nobody needs (registry data, word lists). */
export function fold(source: string): string {
	return foldWithMap(source).text
}
