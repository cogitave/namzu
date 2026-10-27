// The small glob a conditional rule file uses in its `paths` list.
//
// Supported: a double star (any depth), a single star (within one segment),
// `?` (one character) and `{a,b}` alternatives. That covers how a rule names a
// part of a tree, such as a folder plus a file extension; anything fancier is
// not a rule scope.

/** Turn one rule glob into an anchored expression over a project-relative path. */
export function globToRegExp(glob: string): RegExp {
	let out = ''
	let braces = 0
	for (let i = 0; i < glob.length; i += 1) {
		const ch = glob.charAt(i)
		if (ch === '*') {
			if (glob.charAt(i + 1) === '*') {
				// `**/` matches zero or more whole directories.
				if (glob.charAt(i + 2) === '/') {
					out += '(?:.*/)?'
					i += 2
				} else {
					out += '.*'
					i += 1
				}
			} else {
				out += '[^/]*'
			}
		} else if (ch === '?') {
			out += '[^/]'
		} else if (ch === '{') {
			braces += 1
			out += '(?:'
		} else if (ch === '}' && braces > 0) {
			braces -= 1
			out += ')'
		} else if (ch === ',' && braces > 0) {
			out += '|'
		} else {
			out += ch.replace(/[.+^$()|[\]\\]/g, '\\$&')
		}
	}
	// An unbalanced `{` would leave a dangling group; close it rather than throw.
	out += ')'.repeat(braces)
	return new RegExp(`^${out}$`)
}

/** Does a project-relative path (forward slashes) match any of the globs? */
export function matchesAnyGlob(relativePath: string, globs: readonly string[]): boolean {
	return globs.some((glob) => {
		try {
			return globToRegExp(glob.replace(/^\.\//, '')).test(relativePath)
		} catch {
			return false
		}
	})
}
