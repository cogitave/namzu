const STACK_FRAME_RE =
	/^\s+at\s+|^\s+File\s+"[^"]+",\s+line\s+\d+|^\s+at\s+[\w.$]+\(|^\s+\d+:\s+\w|^\s+from\s+\//

// This line is tested against every line of shell output, which is
// attacker-reachable (e.g. bash stdout can carry bytes the run itself never
// typed — a fetched file, a piped response). The first alternative used to
// open with an unbounded `[\s...]+` hunting for a PASS/ok marker that may
// not exist: on a long run of bullet/whitespace characters with nothing to
// match, the engine restarts that scan at every offset, and the per-offset
// scan itself walks the remaining string — quadratic in line length (a
// single crafted line was enough to hang the process). Capping the run
// bounds the per-offset work to a constant, so the unavoidable per-offset
// restart stays linear overall. 40 is generous for the checkmark/indent
// prefixes real tool output produces; nothing legitimate needs more.
const PASS_LINE_RE =
	/[\s✓✔√●∙·►▸▹]{1,40}(PASS|pass|ok|OK|✓|✔|√)\s|^\s*(PASS|ok)\s+[\w/.-]+|^ok\s+\d+\s|PASSED\s*$|^---\s*PASS:|^test\s+\S+\s+\.\.\.\s+ok\s*$/

const NOISE_RE =
	/^\s*[\\\/|─━░▓█▒■□◻◼⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]+\s*$|^\s*\d+%\s*[|█▓░]+|^(Downloading|Fetching|Installing|Resolving|Compiling)\b.*\.\.\./

const DEFAULT_MIN_LINES = 20
const DEFAULT_MIN_REDUCTION = 0.1
const DEFAULT_MAX_STACK_FRAMES = 5
const DEFAULT_MAX_PASS_LINES = 3

export interface ShellCompressResult {
	text: string
	original: string | null
}

export interface ShellCompressOptions {
	minLines?: number
	minReductionPercent?: number
	maxStackFrames?: number
	maxPassLines?: number
}

function normalizeLine(line: string): string {
	return line.replace(/^\s*\d+[\s:.|)]+/, '').replace(/\d+/g, 'N')
}

function collapseRepeated(lines: string[]): string[] {
	const result: string[] = []
	let prevNorm = ''
	let repeatCount = 0

	for (const line of lines) {
		const norm = normalizeLine(line)
		if (norm === prevNorm && norm.trim().length > 0) {
			repeatCount++
		} else {
			if (repeatCount > 0) {
				result.push(`... ${repeatCount} similar line${repeatCount === 1 ? '' : 's'} omitted`)
			}
			result.push(line)
			prevNorm = norm
			repeatCount = 0
		}
	}

	if (repeatCount > 0) {
		result.push(`... ${repeatCount} similar line${repeatCount === 1 ? '' : 's'} omitted`)
	}

	return result
}

export function compressShellOutputFull(
	raw: string,
	options?: ShellCompressOptions,
): ShellCompressResult {
	const minLines = options?.minLines ?? DEFAULT_MIN_LINES
	const minReduction = options?.minReductionPercent ?? DEFAULT_MIN_REDUCTION
	const maxStackFrames = options?.maxStackFrames ?? DEFAULT_MAX_STACK_FRAMES
	const maxPassLines = options?.maxPassLines ?? DEFAULT_MAX_PASS_LINES

	const lines = raw.split('\n')

	if (lines.length < minLines) {
		return { text: raw, original: null }
	}

	// Pass 1: stack frame compression, pass test suppression, noise removal
	const pass1: string[] = []
	let stackCount = 0
	let passCount = 0

	for (const line of lines) {
		// Noise removal
		if (NOISE_RE.test(line)) {
			continue
		}

		// Stack frame compression
		if (STACK_FRAME_RE.test(line)) {
			stackCount++
			if (stackCount <= maxStackFrames) {
				pass1.push(line)
			}
			continue
		}

		if (stackCount > maxStackFrames) {
			pass1.push(`... ${stackCount - maxStackFrames} more frames`)
		}
		stackCount = 0

		// Pass test suppression
		if (PASS_LINE_RE.test(line)) {
			passCount++
			if (passCount <= maxPassLines) {
				pass1.push(line)
			}
			continue
		}

		if (passCount > maxPassLines) {
			pass1.push(`... ${passCount - maxPassLines} passing tests omitted`)
		}
		passCount = 0

		pass1.push(line)
	}

	// Flush trailing counters
	if (stackCount > maxStackFrames) {
		pass1.push(`... ${stackCount - maxStackFrames} more frames`)
	}
	if (passCount > maxPassLines) {
		pass1.push(`... ${passCount - maxPassLines} passing tests omitted`)
	}

	// Pass 2: collapse repeated lines
	const pass2 = collapseRepeated(pass1)

	const compressed = pass2.join('\n')
	const reduction = 1 - compressed.length / raw.length

	if (reduction < minReduction) {
		return { text: raw, original: null }
	}

	return { text: compressed, original: raw }
}

export function compressShellOutput(raw: string, options?: ShellCompressOptions): string {
	return compressShellOutputFull(raw, options).text
}
