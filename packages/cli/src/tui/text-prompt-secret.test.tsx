import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'

import { ChoicePicker } from './ChoicePicker.js'
import { TextPrompt } from './TextPrompt.js'
import { ACCOUNT_PICKER_HINTS, buildAccountPicker } from './account-flow.js'

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('a secret answer', () => {
	it('is drawn as dots, never as the typed text, and is handed over whole', async () => {
		const onSubmit = vi.fn()
		const harness = render(
			<TextPrompt
				title="OpenAI API key"
				placeholder="Paste the key"
				mask
				onSubmit={onSubmit}
				onCancel={() => undefined}
			/>,
		)
		await tick()
		harness.stdin.write('sk-secret-123')
		await tick()
		const frame = harness.lastFrame() ?? ''
		expect(frame).toContain('•••••••••••••')
		expect(frame).not.toContain('sk-secret')
		harness.stdin.write('\r')
		await tick()
		expect(onSubmit).toHaveBeenCalledWith('sk-secret-123')
		harness.unmount()
	})

	it('accepts an empty answer only for an optional step', async () => {
		const required = vi.fn()
		const optional = vi.fn()
		const a = render(
			<TextPrompt title="t" placeholder="p" onSubmit={required} onCancel={() => undefined} />,
		)
		const b = render(
			<TextPrompt
				title="t"
				placeholder="p"
				allowEmpty
				onSubmit={optional}
				onCancel={() => undefined}
			/>,
		)
		await tick()
		a.stdin.write('\r')
		b.stdin.write('\r')
		await tick()
		expect(required).not.toHaveBeenCalled()
		expect(optional).toHaveBeenCalledWith('')
		a.unmount()
		b.unmount()
	})
})

describe('the account list on screen', () => {
	it('shows provider, label and state with the current one marked, and offers filtering and the account keys', () => {
		const model = buildAccountPicker({
			accounts: [
				{
					id: 'codex:default',
					provider: 'codex',
					label: 'default',
					source: { kind: 'existing-default' },
					createdAt: '',
				},
				{
					id: 'openai:free-a',
					provider: 'openai',
					label: 'free-a',
					source: { kind: 'api-key', keyRef: 'k' },
					createdAt: '',
				},
			],
			activity: {
				lastUsed: {},
				limitedUntil: { 'openai:free-a': Date.now() + 3_600_000 },
				autoSwitch: {},
			},
			currentId: 'codex:default',
			now: Date.now(),
			signedIn: () => true,
			hasUsualSignIn: () => true,
		})
		const harness = render(
			<ChoicePicker
				title={model.title}
				notice={model.notice}
				options={model.options}
				selected={0}
				query=""
				hints={ACCOUNT_PICKER_HINTS}
				columns={110}
			/>,
		)
		const frame = harness.lastFrame() ?? ''
		expect(frame).toContain('Accounts')
		expect(frame).toContain('Codex · default')
		expect(frame).toContain('[current]')
		expect(frame).toContain('OpenAI · free-a')
		expect(frame).toMatch(/limited until/)
		expect(frame).toContain('Add an account')
		expect(frame).toContain('type to filter')
		expect(frame).toContain('ctrl+x remove')
		for (const hidden of ['openai:free-a', 'keyRef', 'existing-default']) {
			expect(frame).not.toContain(hidden)
		}
		harness.unmount()
	})
})
