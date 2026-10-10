import type { SetupHarness, SetupProbe } from '../integrations/providers/setup.js'
import { terminalDisplayText } from './terminal-display.js'

/**
 * What the provider setup screen says about an external program.
 *
 * What a program printed is data. The screen gets the outcome in plain words;
 * the program's own lines appear only when detail was asked for (`--debug`).
 */

/** The installed / not-installed part of a row. */
export function setupRowStatus(row: SetupProbe, debug: boolean): string {
	if (!row.installed) return 'Not installed'
	if (!row.checked) {
		return debug && row.raw.trim()
			? `Couldn’t check ${row.harness.label}. ${lastLines(row.raw, 2)}`
			: `Couldn’t check ${row.harness.label}. Details: --debug`
	}
	return row.version ? `Installed · version ${row.version}` : 'Installed'
}

/** The line shown while an install runs. Progress lines from npm are not shown. */
export function setupInstalling(harness: Pick<SetupHarness, 'label'>): string {
	return `Installing ${harness.label}… This can take a minute.`
}

/** The line shown when an install ended without success. */
export function setupInstallFailed(
	harness: Pick<SetupHarness, 'label'>,
	output: string,
	debug: boolean,
): string {
	const plain = `Couldn’t install ${harness.label}. Details: --debug`
	if (!debug || !output.trim()) return plain
	return `Couldn’t install ${harness.label}.\n${lastLines(output, 6)}`
}

function lastLines(text: string, count: number): string {
	return terminalDisplayText(text)
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.slice(-count)
		.join('\n')
}
