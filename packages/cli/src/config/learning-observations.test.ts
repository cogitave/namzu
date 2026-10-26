import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ConfigValueError, loadConfig } from './load.js'

function layers(user?: string) {
	const home = mkdtempSync(join(tmpdir(), 'namzu-home-'))
	mkdirSync(join(home, '.namzu'), { recursive: true })
	if (user !== undefined) writeFileSync(join(home, '.namzu', 'config.yaml'), user)
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-cwd-'))
	return { home, cwd, env: {}, managedPath: join(cwd, 'managed.json') }
}

describe('learningObservations', () => {
	it('is absent by default, which means on', () => {
		expect(loadConfig(layers()).learningObservations).toBeUndefined()
	})

	it('turns recording off when the file says false', () => {
		expect(loadConfig(layers('learningObservations: false\n')).learningObservations).toBe(false)
	})

	it('refuses a value that is not true or false', () => {
		let error: unknown
		try {
			loadConfig(layers('learningObservations: "no"\n'))
		} catch (caught) {
			error = caught
		}
		expect(error).toBeInstanceOf(ConfigValueError)
		expect(error).toMatchObject({ settingPath: 'learningObservations' })
	})
})
