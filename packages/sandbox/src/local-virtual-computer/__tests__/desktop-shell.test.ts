import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)
const entrypoint = fileURLToPath(new URL('../../../local-computer/entrypoint.sh', import.meta.url))

it('opens dock browser windows with guest-only flags and literal arguments without restarting services', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'namzu-desktop-launcher-'))
	try {
		await writeFile(
			join(directory, 'chromium'),
			`#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)))\n`,
			{ mode: 0o700 },
		)
		// Startup must never reach directory creation, Xvfb or any worker for a dock launch.
		await writeFile(join(directory, 'mkdir'), '#!/bin/sh\nexit 98\n', { mode: 0o700 })
		const env = {
			...process.env,
			PATH: `${directory}${delimiter}${process.env.PATH ?? ''}`,
			NAMZU_SANDBOX_SCREEN_WIDTH: '1280',
			NAMZU_SANDBOX_SCREEN_HEIGHT: '800',
		}
		const launch = async (...args: string[]): Promise<string[]> => {
			const { stdout, stderr } = await execute('/bin/sh', [entrypoint, '--browser', ...args], {
				env,
			})
			expect(stderr).toBe('')
			return JSON.parse(stdout) as string[]
		}
		const argv = await launch()
		expect(argv).toEqual([
			'--no-sandbox',
			'--test-type',
			'--disable-dev-shm-usage',
			'--no-first-run',
			'--no-default-browser-check',
			'--password-store=basic',
			'--force-dark-mode',
			'--user-data-dir=/home/namzu/.config/chromium',
			'--remote-debugging-address=127.0.0.1',
			'--remote-debugging-port=9222',
			'--window-position=32,24',
			'--window-size=1216,660',
			'file:///opt/namzu-computer/home.html',
		])
		const address = 'https://example.test/?query=literal spaces&value=$(exit 97)'
		expect(await launch(address)).toEqual([...argv.slice(0, -1), address])
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
})
