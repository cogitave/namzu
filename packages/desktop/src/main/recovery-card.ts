import type { WindowAppearance } from '../shared/protocol.js'

/** The address of the Reload link. Main honours it only while the card is on screen. */
export const RECOVERY_RELOAD_URL = 'namzu-recovery://reload'

export type RecoveryCause =
	| { kind: 'crashed'; reason: string; exitCode: number; reloads: number }
	| { kind: 'hung'; reloads: number }
	| { kind: 'load-failed'; errorCode: number }

const escapes: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#39;',
}
const escapeHtml = (text: string): string =>
	text.replace(/[&<>"']/g, (char) => escapes[char] ?? char)

/** What ended the window's process, in a sentence a person can read. */
function endedPhrase(reason: string): string {
	switch (reason) {
		case 'oom':
			return 'ran out of memory'
		case 'launch-failed':
			return 'could not start'
		case 'integrity-failure':
			return 'failed a safety check'
		case 'killed':
			return 'was ended from outside Namzu'
		default:
			return 'crashed'
	}
}

/** A load error as a cause, not a code; the code stays at the end for anyone who needs to look it up. */
function loadPhrase(errorCode: number): string {
	switch (errorCode) {
		// The page is a file: a missing or unreadable one fails as "not found" or "unexpected".
		case -6:
		case -9:
		case -10:
			return 'The window’s files are missing or cannot be read. Installing Namzu again restores them'
		case -102:
			return 'The development server did not answer. Start it, then reload'
		case -105:
		case -137:
			return 'The address of the window could not be found'
		default:
			return 'The window’s page did not load'
	}
}

function times(count: number): string {
	return count === 1 ? 'once' : `${count} times`
}

export interface RecoveryCardText {
	title: string
	message: string
	details: string[]
}

export function recoveryCardText(cause: RecoveryCause, platform: string): RecoveryCardText {
	const keys = platform === 'darwin' ? 'Cmd+Shift+L' : 'Ctrl+Shift+L'
	const logs = `Press ${keys} to open the diagnostic logs, which show what Namzu recorded.`
	if (cause.kind === 'load-failed')
		return {
			title: 'Namzu could not open its window',
			message:
				'The window did not load. Reload tries again. Your conversations and files are not affected.',
			details: [`${loadPhrase(cause.errorCode)} (error ${Math.abs(cause.errorCode)}).`, logs],
		}
	if (cause.kind === 'hung')
		return {
			title: 'Namzu stopped responding',
			message:
				'The window stopped answering, and reloading it did not help. Reload tries again. Your conversations and files are not affected.',
			details: [
				'The window did not respond and was ended by Namzu.',
				`Namzu reloaded the window ${times(cause.reloads)} in the last minute.`,
				logs,
			],
		}
	return {
		title: 'Namzu stopped working',
		message:
			'The window kept crashing, and reloading it did not help. Reload tries again. Your conversations and files are not affected.',
		details: [
			`The window’s process ${endedPhrase(cause.reason)} (exit code ${cause.exitCode}).`,
			`Namzu reloaded the window ${times(cause.reloads)} in the last minute.`,
			logs,
		],
	}
}

const PALETTE: Record<WindowAppearance, { bg: string; text: string; muted: string; rule: string }> =
	{
		dark: { bg: '#171717', text: '#ededed', muted: '#a1a1a1', rule: '#3a3a3a' },
		light: { bg: '#f7f7f7', text: '#171717', muted: '#5f5f5f', rule: '#cfcfcf' },
	}

/**
 * The card as one self-contained page: no script, no external request, and a content policy that
 * allows neither. `role="alert"` sits on a div around the heading and message, so the page keeps
 * its `main` landmark. The drag strip stands in for the title bar the page has no controls in.
 */
export function recoveryCardPage(
	cause: RecoveryCause,
	options: { platform: string; appearance: WindowAppearance },
): string {
	const text = recoveryCardText(cause, options.platform)
	const colors = PALETTE[options.appearance]
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="color-scheme" content="${options.appearance}">
<title>Namzu</title>
<style>
html,body{margin:0;height:100%;background:${colors.bg};color:${colors.text};font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.drag{position:fixed;top:0;left:0;right:0;height:36px;-webkit-app-region:drag}
main{box-sizing:border-box;min-height:100%;display:flex;flex-direction:column;justify-content:center;max-width:520px;margin:0 auto;padding:48px 24px}
h1{margin:0 0 8px;font-size:16px;font-weight:600}
p{margin:0}
.message{color:${colors.muted}}
a{color:inherit;text-decoration:none;display:inline-block;margin-top:20px;padding:2px 0;border-bottom:1px solid transparent}
a:hover,a:focus-visible{border-bottom-color:${colors.text};outline:none}
details{margin-top:16px}
summary{cursor:pointer;display:inline-block}
summary:focus-visible{outline:1px solid ${colors.muted};outline-offset:2px}
ul{margin:8px 0 0;padding-left:16px;color:${colors.muted};font-size:13px}
li{margin:2px 0}
</style>
</head>
<body>
<div class="drag"></div>
<main>
<div role="alert"><h1>${escapeHtml(text.title)}</h1><p class="message">${escapeHtml(text.message)}</p></div>
<div><a href="${RECOVERY_RELOAD_URL}" autofocus>Reload</a></div>
<details><summary>Details</summary><ul>${text.details.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul></details>
</main>
</body>
</html>`
}

export function recoveryCardUrl(page: string): string {
	return `data:text/html;charset=utf-8,${encodeURIComponent(page)}`
}
