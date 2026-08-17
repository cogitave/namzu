import { describe, expect, it } from 'vitest'

import type { SlashContext } from '../slashCommands.js'
import { renderStatus } from '../slashCommands.js'

/**
 * What a run may do is decided by two mechanisms that do not imply each other,
 * and this page exists because they were only readable apart.
 *
 * The sandbox arrived as a boot notice that scrolls away; the approval settings
 * answer to `/permissions`. An operator who read one had no reason to think the
 * other mattered — and the two failures that follow from it are symmetrical and
 * both silent. Turn approvals off and nothing widens the sandbox: writes still
 * land where they landed. Confine the filesystem and nothing stops the prompts.
 * Each looks like the whole answer.
 *
 * So the assertion these tests protect is not any one line. It is that both
 * halves are on the same page, each labelled with the question it answers.
 */

function context(over: Partial<SlashContext> = {}): SlashContext {
	return {
		builtins: [],
		availableTools: () => [],
		sandbox: null,
		lastAssistantMessageId: () => null,
		providerSummary: 'a-provider',
		modelSummary: 'a-model',
		usage: null,
		instructionFiles: [],
		userCommands: [],
		permissions: {
			skipPermissions: false,
			rules: [],
			approvalLatched: () => false,
			neverPrompted: () => [],
		},
		...over,
	} as SlashContext
}

describe('/status puts both axes on one page', () => {
	it('answers both questions, whatever the settings are', () => {
		// The load-bearing test. A page that answered only one would be
		// `/permissions` or the boot notice again, and the reason this command
		// exists would be gone while every other assertion here still passed.
		const rendered = renderStatus(
			context({
				sandbox: {
					unconfined: false,
					environment: 'linux-bwrap',
					enforced: ['filesystem', 'network', 'process'],
					required: [],
				},
			}),
		)
		expect(rendered).toContain('Where it may write')
		expect(rendered).toContain('When it stops to ask')
	})

	it('names the tier and what it actually enforces', () => {
		const rendered = renderStatus(
			context({
				sandbox: {
					unconfined: false,
					environment: 'linux-bwrap',
					enforced: ['filesystem', 'network'],
					required: [],
				},
			}),
		)
		expect(rendered).toContain('linux-bwrap')
		expect(rendered).toContain('filesystem, network')
	})

	it('says plainly that an unconfined run is unconfined', () => {
		// Not softened by the tier name. A tier that enforces nothing is the
		// absence of a sandbox, not a weaker one, and the page that reports it
		// is the last place to be diplomatic about that.
		const rendered = renderStatus(
			context({
				sandbox: { unconfined: true, environment: 'basic', enforced: [], required: [] },
			}),
		)
		expect(rendered).toMatch(/NOT confined/)
		expect(rendered).not.toMatch(/Confined to this session/)
	})

	it('separates what was required from what happens to be enforced', () => {
		// The distinction that survives moving machines. A host that supplies
		// `filesystem` anyway reads identically to one where it was demanded,
		// and only the second still holds on the next host — so a demand is
		// stated even when it matches, and its absence is stated too.
		const demanded = renderStatus(
			context({
				sandbox: {
					unconfined: false,
					environment: 'linux-bwrap',
					enforced: ['filesystem', 'network', 'process'],
					required: ['filesystem'],
				},
			}),
		)
		expect(demanded).toMatch(/Required by config: filesystem/)
		expect(demanded).toMatch(/refuses to run/)

		const coincidence = renderStatus(
			context({
				sandbox: {
					unconfined: false,
					environment: 'linux-bwrap',
					enforced: ['filesystem', 'network', 'process'],
					required: [],
				},
			}),
		)
		expect(coincidence).toMatch(/Required by config: nothing/)
		expect(coincidence).toMatch(/this host decides/)
	})

	it('says the sandbox is unresolved rather than reporting a safe default', () => {
		// Before a session exists there is no answer, and inventing the
		// reassuring one is how a page like this becomes worse than absent.
		const rendered = renderStatus(context({ sandbox: null }))
		expect(rendered).toMatch(/Not resolved yet/)
		expect(rendered).not.toMatch(/Confined to this session/)
	})

	it('reports a provider that has not been picked as missing, not as blank', () => {
		const rendered = renderStatus(context({ providerSummary: null, modelSummary: null }))
		expect(rendered).toMatch(/none — run \/model/)
	})
})
