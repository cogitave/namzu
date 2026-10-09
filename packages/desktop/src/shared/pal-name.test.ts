import { expect, it } from 'vitest'
import {
	duplicatePalNameMessage,
	isDuplicatePalName,
	palNameKey,
	suggestPalName,
} from './pal-name.js'

it('treats case and edge spacing as the same name', () => {
	expect(isDuplicatePalName(' Pamir ', ['pamir'])).toBe(true)
	expect(isDuplicatePalName('PAMIR', ['pamir'])).toBe(true)
	expect(isDuplicatePalName('pamir two', ['pamir'])).toBe(false)
	expect(isDuplicatePalName('   ', ['pamir'])).toBe(false)
})

it('folds the Turkish dotted and dotless i together', () => {
	expect(palNameKey('ISIK')).toBe(palNameKey('ısık'))
	expect(palNameKey('ISIK')).toBe(palNameKey('isik'))
	expect(palNameKey('İSTANBUL')).toBe(palNameKey('istanbul'))
	expect(isDuplicatePalName('Iris', ['İris'])).toBe(true)
})

it('suggests the next free numbered name', () => {
	expect(suggestPalName('pamir', ['pamir'])).toBe('pamir 2')
	expect(suggestPalName('Pamir', ['pamir', 'pamir 2'])).toBe('Pamir 3')
	expect(suggestPalName('pamir 2', ['pamir', 'pamir 2'])).toBe('pamir 3')
	expect(duplicatePalNameMessage('pamir', ['pamir'])).toBe(
		'You already have a Pal called “pamir”. Try “pamir 2”.',
	)
})
