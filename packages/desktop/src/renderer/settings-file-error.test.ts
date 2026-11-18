import { describe, expect, it } from 'vitest'
import {
	FIX_IN_DESKTOP,
	desktopSettingsFileError,
	isSettingsFileError,
} from './settings-file-error.js'

const ENGINE =
	"~/x/config.yaml isn't valid YAML (line 2, column 5). Fix it, then start Namzu again."

describe('settings file error wording', () => {
	it('recognises the engine sentence, bare or behind the hooks prefix', () => {
		expect(isSettingsFileError(ENGINE)).toBe(true)
		expect(isSettingsFileError(`The configuration could not be read: ${ENGINE}`)).toBe(true)
		expect(isSettingsFileError('x.json must be a set of named settings, not a list.')).toBe(true)
		expect(isSettingsFileError('Couldn’t read your settings. Try again.')).toBe(false)
		expect(isSettingsFileError(undefined)).toBe(false)
	})
	it('swaps the terminal advice for Desktop advice and drops the prefix', () => {
		expect(desktopSettingsFileError(`The configuration could not be read: ${ENGINE}`)).toBe(
			`~/x/config.yaml isn't valid YAML (line 2, column 5). ${FIX_IN_DESKTOP}`,
		)
	})
	it('does not mention starting Namzu again', () => {
		expect(desktopSettingsFileError(ENGINE)).not.toMatch(/start Namzu again/)
	})
})
