/**
 * `open_url`: put a web page in front of the user, in their own browser.
 *
 * The model used to do this with a shell command it guessed per platform —
 * `xdg-open`, `start`, `explorer.exe` — and read the launcher's exit status as
 * the answer. Under WSL `explorer.exe` opens the page and exits 1, so a turn
 * that had done what was asked reported failure. This hands the address to
 * {@link openInBrowser}, the opener `namzu login` uses: http and https only,
 * no shell, the launcher by absolute path, and under WSL the Windows browser.
 *
 * The result says only that a launcher STARTED. No platform reports whether a
 * tab appeared, so the tool does not claim one did.
 *
 * `network` is the category, as for the web tools: it reaches outside this
 * machine's files, so it is reviewed wherever outward actions are, and it
 * declares itself not read-only because it changes what is on the user's
 * screen.
 */

import { type ToolDefinition, defineTool, mcpJsonSchemaToZod } from '@namzu/sdk'

import { type BrowserHost, openInBrowser } from '../../tui/open-browser.js'

export const OPEN_URL_TOOL_NAME = 'open_url'

const inputSchema = {
	type: 'object' as const,
	properties: {
		url: {
			type: 'string',
			minLength: 1,
			maxLength: 8000,
			description: 'The http:// or https:// address to open.',
		},
	},
	required: ['url'],
	additionalProperties: false,
}

/** `open` is injectable for a test; the default is the real opener. */
export function createOpenUrlTool(
	open: (url: string, host?: BrowserHost) => boolean = openInBrowser,
): ToolDefinition {
	return defineTool({
		name: OPEN_URL_TOOL_NAME,
		description:
			"Open an http(s) URL in the user's default web browser on their desktop (under WSL, the Windows browser). Use this rather than a shell command such as xdg-open, start or explorer.exe. It reports that the browser was launched; nothing can confirm the page appeared.",
		inputSchema: mcpJsonSchemaToZod(inputSchema),
		category: 'network',
		permissions: ['network_access'],
		readOnly: false,
		destructive: false,
		concurrencySafe: false,
		timeoutMs: 10_000,
		presentCall: (input) => ({ kind: 'generic', label: String(input.url) }),
		async execute(input) {
			const url = String(input.url).trim()
			if (!/^https?:\/\//i.test(url)) {
				return {
					success: false,
					output: '',
					error: 'Only http:// and https:// addresses can be opened.',
				}
			}
			if (!open(url)) {
				return {
					success: false,
					output: '',
					error:
						'No browser launcher is available on this machine (no desktop session, or no opener installed). Give the user the address to open themselves.',
				}
			}
			return {
				success: true,
				// Stated as the success it is: a model reading a hedge here told
				// the user nothing had happened.
				output: `Opened ${url} in the user's default browser: the launcher started. (No platform reports whether the tab itself appeared.)`,
			}
		},
	})
}
