import { describe, expect, it } from 'vitest'

import {
	baseBranchReviewPrompt,
	commitReviewPrompt,
	reviewPrompt,
	runSlash,
} from '../slashCommands.js'

/**
 * A review turn can fail in two opposite ways, and both read as success.
 *
 * It can INVENT problems, which is worse than no review because somebody acts
 * on the finding. And it can reassure, or restate the diff back, which is worse
 * than useless because it buys confidence nobody earned — and it is the shape a
 * model falls into when it has nothing to say.
 *
 * The prompt is the only place either is prevented, so these assertions are on
 * the prompt's instructions rather than on its prose. Each one names an
 * instruction whose removal changes what comes back.
 */

describe('reviewPrompt', () => {
	it('asks for a finding to be tied to a file and line', () => {
		// Without this the answer is a paragraph of unease with nothing to check.
		const prompt = reviewPrompt(' src/a.ts | 2 +-', [])
		expect(prompt).toMatch(/tied to a file and line/)
	})

	it('tells the model to withhold a finding it cannot ground', () => {
		// The instruction that costs findings on purpose. A review is read by
		// someone who will act on it, so a guess is more expensive than a gap.
		const prompt = reviewPrompt(' src/a.ts | 2 +-', [])
		expect(prompt).toMatch(/do not\s+raise the finding/i)
	})

	it('refuses the summary answer explicitly', () => {
		const prompt = reviewPrompt(' src/a.ts | 2 +-', [])
		expect(prompt).toMatch(/Do not summarise the diff/i)
	})

	it('allows a short "this looks right" instead of manufactured concern', () => {
		// The other half of refusing invention. Without an approved way to say
		// nothing is wrong, the only available answer is to find something.
		const prompt = reviewPrompt(' src/a.ts | 2 +-', [])
		// BOTH halves: the condition and the permission. Asserting only "say so
		// in one line" passed a mutation that deleted "if the work looks right"
		// and left the rest — an instruction to answer in one line, attached to
		// nothing.
		expect(prompt.replace(/\s+/g, ' ')).toMatch(/If the work looks right, say so in one line/i)
	})

	it('asks the model to state what it did not examine', () => {
		const prompt = reviewPrompt(' src/a.ts | 2 +-', [])
		expect(prompt).toMatch(/did not examine/i)
	})

	it('carries the file list rather than a patch body', () => {
		// The agent has a shell and can read what it wants. A truncated patch
		// pasted in would spend the context that reading the interesting parts
		// properly requires, and a review of a truncated diff is a review of
		// whatever fitted.
		const prompt = reviewPrompt(' src/a.ts | 2 +-\n src/b.ts | 9 +++', [])
		expect(prompt).toContain('src/a.ts')
		expect(prompt).toContain('src/b.ts')
		expect(prompt).not.toContain('@@')
	})

	it('names untracked files, which the diff would not mention at all', () => {
		const prompt = reviewPrompt('', ['brand-new.ts'])
		expect(prompt).toContain('brand-new.ts')
		expect(prompt).toMatch(/no diff shows/)
	})

	it('says plainly when no tracked file changed, rather than leaving a blank', () => {
		// A prompt with an empty section invites the model to fill it in.
		const prompt = reviewPrompt('', ['brand-new.ts'])
		expect(prompt).toMatch(/no tracked file changed/)
	})
})

describe('/review targets', () => {
	it('opens the preset chooser only when custom instructions are absent', () => {
		expect(runSlash('/review', context())).toEqual({ kind: 'review' })
		expect(runSlash('/review focus on cancellation races', context())).toEqual({
			kind: 'review',
			instructions: 'focus on cancellation races',
		})
	})

	it('pins branch and commit prompts to immutable commit ids', () => {
		const sha = 'a'.repeat(40)
		expect(baseBranchReviewPrompt(sha)).toContain(`git diff ${sha}`)
		expect(commitReviewPrompt(sha)).toContain(`git diff ${sha}^ ${sha}`)
	})
})

function context(): Parameters<typeof runSlash>[1] {
	return {
		cwd: '/workspace',
		availableTools: () => [],
		sandbox: null,
		mcp: () => null,
		providerSummary: null,
		modelSummary: null,
		reasoningEffort: { current: () => undefined, levels: undefined },
		usage: null,
		permissions: {
			currentMode: () => ({ mode: 'prompt', source: 'default' }),
			rules: [],
			approvalLatched: () => false,
			neverPrompted: () => [],
		},
		instructionFiles: [],
		userCommands: [],
		configDebug: null,
		lastAssistantMessageId: () => null,
	}
}
