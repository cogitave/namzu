/** Render an instruction path without terminal controls or visual reordering. */
export function visibleProjectInstructionPath(path: string): string {
	return [...path]
		.map((character) => {
			const code = character.codePointAt(0) ?? 0
			const unsafe =
				code <= 0x1f ||
				(code >= 0x7f && code <= 0x9f) ||
				code === 0x2028 ||
				code === 0x2029 ||
				(code >= 0x202a && code <= 0x202e) ||
				(code >= 0x2066 && code <= 0x2069)
			return unsafe ? `\\u${code.toString(16).padStart(4, '0')}` : character
		})
		.join('')
}
