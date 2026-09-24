/**
 * Folding confusable Unicode forms before a literal-keyword delimiter check.
 *
 * `tools/untrusted-envelope.ts` and `runtime/system-events.ts` each defang a
 * fixed keyword (`namzu-untrusted`, `system-event`) inside untrusted text so
 * the keyword cannot forge a second, fake close of the frame it appears in.
 * Both used to do this with a literal, ASCII, case-insensitive regex —
 * `/namzu-untrusted/gi`, `/system-event/gi` — which a model reads as the same
 * structure it has seen thousands of times as a real tag, but which a
 * Unicode LOOKALIKE character sails straight through: U+2011 NON-BREAKING
 * HYPHEN in place of the ASCII hyphen, a fullwidth spelling of the letters,
 * a zero-width character inserted inside the word, or a bidi override
 * character reordering how the word reads. None of these change how a model
 * parses the text as structure; all of them defeat a literal-byte match.
 *
 * The fix folds the text first, so the keyword check runs against a
 * canonicalized form no confusable character survives:
 *
 * 1. NFKC normalization collapses compatibility and fullwidth forms to
 *    their canonical equivalent (fullwidth "ｓｙｓｔｅｍ" becomes "system").
 * 2. Default-ignorable, bidi-control and variation-selector characters are
 *    dropped outright — these are exactly the zero-width joiners, bidi
 *    override/embedding controls and variation selectors a lookalike attack
 *    hides inside a word without changing how it reads.
 * 3. Every Unicode dash (`\p{Pd}`, plus U+2212 MINUS SIGN, which is a math
 *    symbol and so not itself in `Pd`) folds to the ASCII hyphen.
 * 4. Every Unicode space (`\p{Zs}`) folds to the ASCII space.
 *
 * Folding is lossy by design for untrusted text: an exotic character that
 * does not survive is not restored, an acceptable fidelity loss weighed
 * against the alternative, a keyword check a confusable character can walk
 * straight through. Only untrusted fields are folded; the kernel's own
 * literal tag text is never passed through this.
 */

/**
 * Zero-width joiners/spaces, bidi override/embedding/isolate controls, and
 * variation selectors: the three ECMAScript Unicode property escapes that
 * together cover the "invisible or reordering" class of confusable a
 * lookalike keyword hides behind.
 */
const IGNORABLE_PATTERN =
	/[\p{Default_Ignorable_Code_Point}\p{Bidi_Control}\p{Variation_Selector}]/gu

/**
 * `\p{Pd}` (Unicode "Dash Punctuation") plus U+2212 MINUS SIGN, a math symbol
 * `Pd` does not include. Built from `String.fromCodePoint` rather than typed
 * as a literal character in the class, so the source of a module about
 * confusable characters does not itself carry one that a diff viewer or
 * editor could render ambiguously.
 */
const MINUS_SIGN = String.fromCodePoint(0x2212)
const DASH_PATTERN = new RegExp(`[\\p{Pd}${MINUS_SIGN}]`, 'gu')

/** `\p{Zs}` ("Space Separator"): every Unicode space character, NBSP included. */
const SPACE_PATTERN = /\p{Zs}/gu

/**
 * Fold confusable Unicode forms to the canonical spelling a literal keyword
 * match can find: NFKC normalization, dropped default-ignorable/bidi-control/
 * variation-selector characters, every Unicode dash mapped to `-`, every
 * Unicode space mapped to ` `.
 */
export function foldConfusables(text: string): string {
	return text
		.normalize('NFKC')
		.replace(IGNORABLE_PATTERN, '')
		.replace(DASH_PATTERN, '-')
		.replace(SPACE_PATTERN, ' ')
}

function escapeForRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Fold `text` ({@link foldConfusables}), then replace every case-insensitive
 * occurrence of `keyword` with the same spelling, hyphen swapped for an
 * underscore (`"system-event"` -> `"system_event"`).
 *
 * The replacement swaps the hyphen for an underscore rather than appending a
 * suffix or otherwise mangling the text: `"system-event-literal"` would have
 * read fine to a human and still CONTAINED the token, so a second pass, a
 * looser matcher downstream, or a reader scanning for the substring would
 * all find it again. Swapping the separator shares no substring with the
 * real keyword while staying legible, which is the property that matters.
 *
 * Folding first is what closes the class of bypass a same-value literal
 * regex cannot: matching runs against the folded text, so a Unicode dash
 * lookalike, a fullwidth letter, a zero-width character or a bidi override
 * inserted inside the keyword all fold back to the literal spelling before
 * the match ever runs — including every context a full tag scaffold can
 * appear in (`<keyword attr="x">`, `</keyword>`, `</keyword >`,
 * `< / keyword>`), since folding never removes the ASCII `<`, `/`, `>` or
 * whitespace those already contain.
 */
export function neutralizeConfusableKeyword(text: string, keyword: string): string {
	const folded = foldConfusables(text)
	const pattern = new RegExp(escapeForRegExp(keyword), 'gi')
	const replacement = keyword.replace(/-/g, '_')
	return folded.replace(pattern, replacement)
}
