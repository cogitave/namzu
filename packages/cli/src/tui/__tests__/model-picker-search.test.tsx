import { afterEach, expect, it, vi } from 'vitest'

import type { DetectedProvider } from '../../integrations/providers/index.js'
import { PROVIDER_REGISTRY } from '../../integrations/providers/registry.js'
import { Picker, type PickerProps } from '../Picker.js'
import { type Screen, renderToScreen } from './support/screen.js'

const models = Array.from({ length: 500 }, (_, index) => ({
	id: `vendor/model-${index}`,
	name: `Catalogue Model ${index}`,
}))
const detected: DetectedProvider[] = [
	{
		entry: { ...PROVIDER_REGISTRY.openai, defaultModel: models[0]?.id ?? '' },
		source: { kind: 'env', envName: 'OPENAI_API_KEY' },
		apiKey: 'not-a-real-key',
		alternatives: [],
	},
]
const mounted: Screen[] = []

afterEach(async () => {
	for (const screen of mounted.splice(0)) await screen.unmount()
})

async function open(overrides: Partial<PickerProps> = {}, cols = 100) {
	const onSubmit = vi.fn()
	const onCancel = vi.fn()
	const screen = await renderToScreen(
		<Picker
			detected={detected}
			currentProvider="openai"
			currentModel="vendor/model-499"
			initialView="models"
			describeModels={async () => ({ kind: 'ok', models })}
			onSubmit={onSubmit}
			onCancel={onCancel}
			{...overrides}
		/>,
		{ cols, rows: 14 },
	)
	mounted.push(screen)
	await vi.waitFor(async () => {
		await screen.waitForRender()
		expect(screen.viewport().join('\n')).toContain('Search:')
	})
	return { screen, onSubmit, onCancel }
}

function selected(screen: Screen): string | undefined {
	return screen.viewport().find((line) => line.includes('❯'))
}

it('filters 500 model IDs and retains the current selection before navigating filtered rows', async () => {
	const { screen, onSubmit } = await open()
	expect(selected(screen)).toContain('Catalogue Model 499 (current)')
	screen.press('VENDOR/MODEL-49')
	await screen.waitForRender()
	expect(selected(screen)).toContain('Catalogue Model 499 (current)')
	expect(screen.viewport().join('\n')).toContain('11/11')
	expect(onSubmit).not.toHaveBeenCalled()

	// Navigation and Enter may be delivered before another React frame.
	screen.press('\x1b[H')
	screen.press('\x1b[B')
	screen.press('\r')
	await screen.waitForRender()
	expect(onSubmit).toHaveBeenCalledWith(
		{ provider: 'openai', model: 'vendor/model-490' },
		expect.any(AbortSignal),
	)
})

it('accepts a pasted display name without submitting its newline, then cancels pending application', async () => {
	const { screen, onSubmit, onCancel } = await open()
	screen.press('Catalogue Model 498\r\n')
	await screen.waitForRender()
	expect(selected(screen)).toContain('Catalogue Model 498')
	expect(screen.viewport().join('\n')).toContain('1/1')
	expect(onSubmit).not.toHaveBeenCalled()
	screen.press('\r')
	await screen.waitForRender()
	expect(onSubmit.mock.calls[0]?.[0]).toEqual({ provider: 'openai', model: 'vendor/model-498' })
	const signal = onSubmit.mock.calls[0]?.[1] as AbortSignal
	expect(signal.aborted).toBe(false)
	screen.press('\x1b')
	await vi.waitFor(() => expect(onCancel).toHaveBeenCalledOnce())
	expect(signal.aborted).toBe(true)
})

it('does not submit an empty match and edits or clears the search back to a selectable row', async () => {
	const { screen, onSubmit } = await open()
	screen.press('model-498x')
	screen.press('\r')
	await screen.waitForRender()
	expect(screen.viewport().join('\n')).toContain('No matching models')
	expect(screen.viewport().join('\n')).toContain('0/0')
	expect(onSubmit).not.toHaveBeenCalled()
	screen.press('\x7f')
	await screen.waitForRender()
	expect(selected(screen)).toContain('Catalogue Model 498')
	screen.press('\x15')
	await screen.waitForRender()
	expect(selected(screen)).toContain('Catalogue Model 498')
	expect(screen.viewport().join('\n')).toContain('499/500')
	expect(screen.viewport().join('\n')).toContain('p change provider')
})

it('keeps numeric shortcuts outside search and treats digits and p as text after slash', async () => {
	const { screen, onSubmit } = await open()
	screen.press('7')
	await screen.waitForRender()
	expect(selected(screen)).toContain('Catalogue Model 6')
	screen.press('/')
	screen.press('499')
	screen.press('\r')
	await screen.waitForRender()
	expect(onSubmit.mock.calls[0]?.[0]).toEqual({ provider: 'openai', model: 'vendor/model-499' })
	screen.press('\x15')
	screen.press('/')
	screen.press('p')
	await screen.waitForRender()
	expect(screen.viewport().join('\n')).toContain('Search: p')
	expect(screen.viewport().join('\n')).toContain('Choose a model')
})

it('fits search, selection markers and controls into a 40-column terminal', async () => {
	const { screen, onSubmit } = await open({ currentModel: 'vendor/model-0' }, 40)
	let output = screen.viewport().join('\n')
	expect(output).toContain('Choose a model')
	expect(output).toContain('Search:')
	expect(selected(screen)).toContain('(current) (default)')
	expect(output).toContain('enter apply')

	screen.press('Catalogue Model 499')
	await screen.waitForRender()
	output = screen.viewport().join('\n')
	expect(output).toContain('Search: Catalogue Model 499')
	expect(selected(screen)).toContain('Catalogue Model 499')
	expect(output).toContain('enter apply')
	screen.press('\r')
	await screen.waitForRender()
	expect(onSubmit.mock.calls[0]?.[0]).toEqual({ provider: 'openai', model: 'vendor/model-499' })
})
