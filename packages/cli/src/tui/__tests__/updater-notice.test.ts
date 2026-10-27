import { describe, expect, it } from 'vitest'

import { updaterEventAmbient } from '../update-notice.js'

describe('the footer line the background updater leaves', () => {
	it('says plainly that an update was installed and what to do, in the quiet tone', () => {
		expect(updaterEventAmbient({ type: 'installed', from: '1.0.0', to: '2.0.0' })).toEqual({
			text: 'Updated to 2.0.0, restart to use it',
			tone: 'dim',
			strong: '2.0.0',
		})
	})

	it('gives the exact command, in the warning tone, when Namzu leaves the install to the person', () => {
		expect(
			updaterEventAmbient({ type: 'available', latest: '2.0.0', command: 'namzu upgrade' }),
		).toEqual({
			text: 'Update available! Run: namzu upgrade',
			tone: 'warn',
			strong: 'namzu upgrade',
		})
	})

	it('says an automatic attempt did not work without raw installer output', () => {
		const line = updaterEventAmbient({
			type: 'available',
			latest: '2.0.0',
			command: 'sudo npm install --global --prefix /usr @namzu/cli@2.0.0',
			failure: 'no_permission',
		})
		expect(line.text).toBe(
			"Couldn't update Namzu on its own. Run: sudo npm install --global --prefix /usr @namzu/cli@2.0.0",
		)
		expect(line.tone).toBe('warn')
	})

	it('has no command to offer for a layout it cannot update', () => {
		expect(updaterEventAmbient({ type: 'available', latest: '2.0.0', command: null }).text).toBe(
			'Namzu 2.0.0 is available. Reinstall Namzu to get it',
		)
	})
})
