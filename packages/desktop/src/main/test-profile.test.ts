import { describe, expect, it } from 'vitest'
import { productTitle, testProfileName } from './test-profile.js'

const DEFAULT = '/home/a/.config/Namzu'

describe('the test profile', () => {
	it('is the folder name when a user-data folder other than the default was asked for', () => {
		expect(
			testProfileName({
				argv: ['electron', '.', '--user-data-dir=/tmp/x/userdata'],
				userData: '/tmp/x/userdata',
				defaultUserData: DEFAULT,
			}),
		).toBe('userdata')
		expect(
			testProfileName({
				argv: ['electron', '--user-data-dir', '/tmp/second/'],
				userData: '/tmp/second/',
				defaultUserData: DEFAULT,
			}),
		).toBe('second')
	})

	it('is nothing for the normal profile, with or without the flag', () => {
		expect(testProfileName({ argv: ['namzu'], userData: DEFAULT, defaultUserData: DEFAULT })).toBe(
			undefined,
		)
		expect(
			testProfileName({
				argv: ['namzu', `--user-data-dir=${DEFAULT}`],
				userData: DEFAULT,
				defaultUserData: DEFAULT,
			}),
		).toBe(undefined)
	})

	it('names the product with the profile', () => {
		expect(productTitle(undefined)).toBe('Namzu')
		expect(productTitle('userdata')).toBe('Namzu (test: userdata)')
	})
})
