import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => ({
	...(await importOriginal<typeof import('node:child_process')>()),
	spawn: spawnMock,
}))

import { type CommandShell, setHostCommandShellForTesting } from '../../../tools/command-shell.js'
import { BackgroundJobRegistry } from '../registry.js'

const CMD: CommandShell = { path: undefined, dialect: 'cmd', source: 'platform' }

function fakeChild() {
	return Object.assign(new EventEmitter(), {
		pid: 4242 as number | undefined,
		stdout: new PassThrough(),
		stderr: new PassThrough(),
	})
}

afterEach(() => {
	setHostCommandShellForTesting(undefined)
	spawnMock.mockReset()
})

describe('a background job on a host whose shell is cmd', () => {
	it('is spawned exactly as the foreground tool spawns it, never as /bin/sh -c', () => {
		setHostCommandShellForTesting(CMD)
		spawnMock.mockReturnValue(fakeChild())
		new BackgroundJobRegistry().start({
			owner: 'o',
			command: 'ping -n 6 127.0.0.1 > bg-demo.txt',
			workingDirectory: 'C:\\work',
		})
		expect(spawnMock).toHaveBeenCalledTimes(1)
		const [file, args, options] = spawnMock.mock.calls[0] as [
			string,
			string[],
			Record<string, unknown>,
		]
		// The line itself travels in the environment, so cmd reads it as UTF-8.
		expect(file).toMatch(/cmd\.exe$/i)
		expect(args.at(-1)).toContain('!NAMZU_HOST_COMMAND!')
		expect(options).toMatchObject({
			cwd: 'C:\\work',
			env: expect.objectContaining({ NAMZU_HOST_COMMAND: 'ping -n 6 127.0.0.1 > bg-demo.txt' }),
			windowsVerbatimArguments: true,
			windowsHide: true,
			stdio: ['ignore', 'pipe', 'pipe'],
		})
	})

	it('decodes the child bytes it is given', async () => {
		setHostCommandShellForTesting(CMD)
		const child = fakeChild()
		spawnMock.mockReturnValue(child)
		const registry = new BackgroundJobRegistry()
		const job = registry.start({ owner: 'o', command: 'echo é', workingDirectory: '.' })
		child.stdout.write(Buffer.from('é\n'))
		child.emit('spawn')
		child.emit('close', 0, null)
		await registry.waitForExit(job.id)
		expect(registry.read(job.id, {}).chunk).toBe('é\n')
	})
})
