import { describe, expect, it } from 'vitest'
import {
	INTERFACE_FONT_ATTRIBUTE,
	INTERFACE_FONT_CHOICES,
	applyInterfaceFont,
	interfaceFontOf,
	parseInterfaceFont,
} from './interface-font.js'

function root() {
	const attributes = new Map<string, string>()
	return {
		setAttribute: (name: string, value: string) => void attributes.set(name, value),
		removeAttribute: (name: string) => void attributes.delete(name),
		getAttribute: (name: string) => attributes.get(name) ?? null,
		attributes,
	}
}

describe('the interface font choice', () => {
	it('is the app’s own unless the stored value says system', () => {
		expect(parseInterfaceFont(null)).toBe('app')
		expect(parseInterfaceFont('app')).toBe('app')
		expect(parseInterfaceFont('Geist')).toBe('app')
		expect(parseInterfaceFont('system')).toBe('system')
	})

	it('is one attribute on the root: set for system, gone for the default', () => {
		const element = root()
		applyInterfaceFont(element, 'system')
		expect(element.attributes.get(INTERFACE_FONT_ATTRIBUTE)).toBe('system')
		expect(interfaceFontOf(element)).toBe('system')
		applyInterfaceFont(element, 'app')
		expect(element.attributes.has(INTERFACE_FONT_ATTRIBUTE)).toBe(false)
		expect(interfaceFontOf(element)).toBe('app')
	})

	it('offers the two choices, the app’s own first', () => {
		expect(INTERFACE_FONT_CHOICES.map((choice) => choice.value)).toEqual(['app', 'system'])
	})
})
