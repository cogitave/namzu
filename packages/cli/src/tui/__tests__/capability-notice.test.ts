import { describe, expect, it } from 'vitest'

import {
	describeCapabilityNotice,
	describeHistoryRepairNotice,
	withDebugDetail,
} from '../capability-notice.js'

const RAW =
	"Provider 'ollama' does not support tools — 42 registered tool(s) were stripped from the prompt and request."

describe('capability notices', () => {
	it('says a provider without tools will only chat, and what to do', () => {
		const text = describeCapabilityNotice({ capability: 'tools', providerId: 'ollama' })
		expect(text).toBe(
			'Ollama can’t use tools, so Namzu will only chat while you use it. Switch to another provider to let Namzu work with files and commands.',
		)
		expect(text).not.toContain('ollama')
		expect(text).not.toMatch(/\d/)
	})

	it('says a provider without vision will not see the picture', () => {
		expect(describeCapabilityNotice({ capability: 'vision', providerId: 'ollama' })).toBe(
			'Ollama can’t see images, so it won’t see the picture you attached. Switch to a provider that reads images to include it.',
		)
	})

	it('says a provider without document support will not see the file', () => {
		expect(describeCapabilityNotice({ capability: 'documents', providerId: 'deepseek' })).toBe(
			'DeepSeek can’t read documents, so it won’t see the file you attached. Switch to a provider that reads documents to include it.',
		)
	})

	it('names the product, never the id, for a registry provider', () => {
		expect(describeCapabilityNotice({ capability: 'tools', providerId: 'anthropic' })).toMatch(
			/^Anthropic can’t use tools/,
		)
		expect(describeCapabilityNotice({ capability: 'tools', providerId: 'lmstudio' })).toMatch(
			/^LM Studio can’t use tools/,
		)
	})

	it('speaks of a text note when the content came from a tool result', () => {
		expect(
			describeCapabilityNotice({
				capability: 'vision',
				contentSource: 'tool-result',
				providerId: 'ollama',
			}),
		).toBe(
			'Ollama can’t see images, so Namzu gave it a text note in place of a picture a tool returned. Switch to a provider that reads images to include it.',
		)
		expect(
			describeCapabilityNotice({
				capability: 'documents',
				contentSource: 'tool-result',
				providerId: 'ollama',
			}),
		).toBe(
			'Ollama can’t read documents, so Namzu gave it a text note in place of a document a tool returned. Switch to a provider that reads documents to include it.',
		)
	})

	it('still reads as a sentence when the provider is unknown', () => {
		expect(describeCapabilityNotice({ capability: 'tools' })).toMatch(
			/^This provider can’t use tools/,
		)
	})

	it('carries no label, id or kernel wording in any case', () => {
		for (const capability of ['tools', 'vision', 'documents'] as const) {
			for (const contentSource of [undefined, 'tool-result' as const]) {
				const text = describeCapabilityNotice({
					capability,
					...(contentSource ? { contentSource } : {}),
					providerId: 'ollama',
				})
				expect(text).not.toMatch(/Capability|warning|stripped|registered|tool\(s\)|'ollama'/)
			}
		}
	})
})

describe('history repair notices', () => {
	it('says unfinished steps were marked, and what to check, for a fresh history', () => {
		const text = describeHistoryRepairNotice({
			source: 'fresh-history',
			duplicateResults: 1,
			orphanedResults: 2,
			interruptedCalls: 3,
		})
		expect(text).toBe(
			'Some steps in this conversation never finished, so Namzu marked them as unfinished. Check any files or commands they touched before asking again.',
		)
		expect(text).not.toMatch(/History warning|fresh-history|orphan|idempotent|\d/)
	})

	it('explains a cut-off earlier reply', () => {
		const text = describeHistoryRepairNotice({
			source: 'abandoned-checkpoint',
			interruptedCalls: 1,
		})
		expect(text).toBe(
			'Your last reply was cut off before its steps finished, so Namzu marked them as unfinished. Check any files or commands they touched before asking again.',
		)
		expect(text).not.toContain('abandoned-checkpoint')
	})

	it('does not claim unfinished steps when only leftovers were removed', () => {
		for (const source of ['fresh-history', 'abandoned-checkpoint'] as const) {
			for (const counts of [
				{ duplicateResults: 2 },
				{ orphanedResults: 1 },
				{ duplicateResults: 1, orphanedResults: 1 },
				{},
			]) {
				const text = describeHistoryRepairNotice({ source, ...counts })
				expect(text).toBe(
					'Namzu cleaned up some leftover steps from earlier in this conversation. Nothing you need to do.',
				)
			}
		}
	})

	it('says which provider turned a picture down, and what to do', () => {
		expect(
			describeHistoryRepairNotice({
				source: 'provider-rejected-image',
				rejectedImages: 2,
				providerId: 'ollama',
			}),
		).toBe(
			'Ollama didn’t accept 2 pictures you attached. Namzu kept the file but will leave it out of later messages. Attach a corrected copy to try again.',
		)
		expect(
			describeHistoryRepairNotice({ source: 'provider-rejected-image', rejectedImages: 1 }),
		).toMatch(/^A picture you attached wasn’t accepted\. Namzu kept the file/)
	})

	it('names no source id', () => {
		for (const source of [
			'fresh-history',
			'abandoned-checkpoint',
			'provider-rejected-image',
		] as const) {
			expect(describeHistoryRepairNotice({ source })).not.toContain(source)
		}
	})
})

describe('the kernel wording', () => {
	it('shows only when detail was asked for', () => {
		const plain = describeCapabilityNotice({ capability: 'tools', providerId: 'ollama' })
		expect(withDebugDetail(plain, RAW, false)).toBe(plain)
		const debug = withDebugDetail(plain, RAW, true)
		expect(debug).toContain(plain)
		expect(debug).toContain(RAW)
	})
})
