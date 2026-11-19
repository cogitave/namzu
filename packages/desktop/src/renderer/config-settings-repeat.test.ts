import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type {
	ConfigSettingDescriptor,
	ConfigSettingsView,
} from '../shared/config-settings-protocol.js'
import { unlessRepeated } from './config-settings-model.js'
import { ConfigSettingsGroup } from './config-settings-section.js'
import type { ConfigSettingsControls } from './use-config-settings.js'

const memorySelect: ConfigSettingDescriptor = {
	path: 'memory.select',
	label: 'Let a model choose memories',
	description:
		'A model picks which memories to bring in. It uses the model for quick tasks and sees your message and memory titles.',
	section: 'agent',
	control: {
		kind: 'select',
		options: [
			{ value: 'on', label: 'On', help: 'A model picks which memories to bring in.' },
			{ value: 'off', label: 'Off', help: 'Memories are chosen without a model.' },
		],
	},
	default: 'on',
}

const controlsFor = (view: ConfigSettingsView): ConfigSettingsControls =>
	({
		view,
		loadError: undefined,
		loading: false,
		resets: {},
		discard: () => undefined,
		reload: () => undefined,
		confirmation: undefined,
		errors: {},
		change: async () => true,
		confirm: () => undefined,
		dismiss: () => undefined,
	}) as unknown as ConfigSettingsControls

const metaLines = (html: string): string[] =>
	[...html.matchAll(/<p data-settings-meta[^>]*>([^<]*)<\/p>/g)].map((m) => m[1] ?? '')

describe('a second line never repeats the description', () => {
	it('drops a choice help that is the description first sentence', () => {
		expect(
			unlessRepeated('A model picks which memories to bring in.', memorySelect.description),
		).toBe('')
		expect(unlessRepeated('Memories are chosen without a model.', memorySelect.description)).toBe(
			'Memories are chosen without a model.',
		)
		expect(unlessRepeated(undefined, 'x')).toBe('')
	})

	it('draws no second line for the chosen option that repeats, and keeps one that adds', () => {
		const view = (value: string): ConfigSettingsView => ({
			file: '/f',
			descriptors: [memorySelect],
			settings: [{ path: 'memory.select', set: true, value, effective: value }],
		})
		const html = (value: string) =>
			renderToStaticMarkup(
				createElement(ConfigSettingsGroup, {
					section: 'agent',
					config: controlsFor(view(value)),
				}),
			)
		expect(metaLines(html('on'))).not.toContain('A model picks which memories to bring in.')
		expect(metaLines(html('off')).join(' ')).toContain('Memories are chosen without a model.')
	})
})
