import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { render } from 'ink-testing-library'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { scopeOf } from '../../integrations/auto-update/apply.js'
import type { InstallKind } from '../../integrations/auto-update/install-kind.js'
import { readInstalledVersion } from '../../integrations/auto-update/installed-version.js'
import { readAttempt } from '../../integrations/auto-update/state.js'
import { type UpdaterEvent, createUpdater } from '../../integrations/auto-update/updater.js'
import { StatusBar } from '../StatusBar.js'
import { updaterEventAmbient } from '../update-notice.js'

let dir: string
let home: string
let root: string

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'namzu-updater-footer-'))
	home = join(dir, 'home')
	root = join(dir, 'prefix', 'lib', 'node_modules', '@namzu', 'cli')
	mkdirSync(root, { recursive: true })
	writeFileSync(
		join(root, 'package.json'),
		JSON.stringify({ name: '@namzu/cli', version: '1.0.0' }),
	)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** One process: the updater feeds the footer the way the terminal UI wires it. */
function launch() {
	const install: InstallKind = {
		kind: 'npm-global',
		root,
		prefix: join(dir, 'prefix'),
		owned: false,
		writable: true,
	}
	let ambient: ReturnType<typeof updaterEventAmbient> | null = null
	const events: UpdaterEvent[] = []
	const updater = createUpdater({
		currentVersion: '1.0.0',
		install,
		policy: { check: true, install: true, channel: 'latest', decidedBy: 'default' },
		home,
		platform: 'linux',
		fetchRelease: async () => ({ version: '2.0.0', integrity: 'sha512-AAAA' }),
		uptimeMs: () => 0,
		onEvent: (event) => {
			events.push(event)
			ambient = updaterEventAmbient(event)
		},
		applyDeps: {
			installedVersion: readInstalledVersion,
			// The new copy never starts.
			smokeTest: async (at, version) => readInstalledVersion(at) === version && version === '1.0.0',
			pid: 4242,
			isAlive: () => true,
			fetchTarball: async (_release, file) => {
				mkdirSync(dirname(file), { recursive: true })
				writeFileSync(file, 'checked tarball')
			},
			runInstaller: async () => {
				writeFileSync(
					join(root, 'package.json'),
					JSON.stringify({ name: '@namzu/cli', version: '2.0.0' }),
				)
				return 0
			},
		},
	})
	return { updater, install, events, footer: () => ambient }
}

describe('a version that fails its start check, from the updater to the footer', () => {
	it('shows the line once, on the run where it failed, and not on the next start', async () => {
		const first = launch()
		await first.updater.runCycle()
		expect(first.events).toEqual([
			{ type: 'failed', latest: '2.0.0', current: '1.0.0', code: 'verify_failed' },
		])
		expect(readInstalledVersion(root)).toBe('1.0.0')
		const ambient = first.footer()
		expect(ambient).not.toBeNull()
		const shown = render(
			<StatusBar provider="p" model="m" state="idle" ambient={ambient ?? undefined} />,
		)
		expect(shown.lastFrame()).toContain('Namzu 2.0.0 could not start here; staying on 1.0.0')
		shown.unmount()
		expect(readAttempt(home, scopeOf(first.install, 'linux'))).toMatchObject({ shown: true })

		const second = launch()
		await second.updater.runCycle()
		expect(second.events).toEqual([])
		expect(second.footer()).toBeNull()
	})
})
