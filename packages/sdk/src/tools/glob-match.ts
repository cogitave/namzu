/**
 * Glob matching for the sandboxed filesystem tools.
 *
 * The host path hands its pattern to the runtime's own directory walker;
 * inside a sandbox there is only a flat listing to filter, so the matching
 * has to happen here. Written out rather than reached for from the
 * platform: the runtime's glob matcher is still flagged experimental, and
 * an SDK that ships into other people's runtimes should not depend on
 * that.
 *
 * The subset is the one the tools document — `**` across separators, `*`
 * and `?` within one segment. Every other character is escaped, so a
 * pattern containing regex punctuation matches literally instead of
 * quietly becoming a different query.
 */

const NEEDS_ESCAPE = /[.+^${}()|[\]\\]/

export function globToRegExp(pattern: string): RegExp {
	let out = ''
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i] as string
		if (ch === '*') {
			if (pattern[i + 1] === '*') {
				if (pattern[i + 2] === '/') {
					// `**/` matches zero directories too, so `**/x.ts` finds a
					// top-level `x.ts` — which is what someone writing it means.
					out += '(?:.*/)?'
					i += 2
				} else {
					out += '.*'
					i += 1
				}
			} else {
				out += '[^/]*'
			}
			continue
		}
		if (ch === '?') {
			out += '[^/]'
			continue
		}
		out += NEEDS_ESCAPE.test(ch) ? `\\${ch}` : ch
	}
	return new RegExp(`^${out}$`)
}

export function matchesGlob(path: string, pattern: string): boolean {
	return globToRegExp(pattern).test(path)
}
