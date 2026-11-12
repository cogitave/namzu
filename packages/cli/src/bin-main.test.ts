import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runCli = vi.hoisted(() => vi.fn())
const release = vi.hoisted(() => vi.fn())
const imports = vi.hoisted(() => ({ kernel: 0 }))
vi.mock('./cli.js', () => ({ runCli }))
vi.mock('@namzu/sdk', () => {
	imports.kernel++
	return { releaseHeldSessionLeases: release }
})
const replaced = vi.hoisted(() => vi.fn(() => false))
vi.mock('./integrations/auto-update/replaced-install.js', () => ({
	installWasReplaced: replaced,
	replacedInstallLine: () => 'Namzu was replaced while this window was open.',
}))
vi.mock('./crash-report.js', () => ({ reportCrash: () => 'Fixture crash report\n' }))

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

beforeEach(() => {
	vi.resetModules()
	runCli.mockReset().mockResolvedValue(0)
	release.mockReset().mockResolvedValue({ released: 0, unfinished: 0 })
	imports.kernel = 0
	replaced.mockReset().mockReturnValue(false)
	vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
	vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})
afterEach(() => vi.restoreAllMocks())

describe('the binary gives back its session leases before exiting', () => {
	it('does not load the kernel for a utility-only invocation', async () => {
		const { main } = await import('./bin-main.js')
		await main('/fixture/bin.js')
		expect(imports.kernel).toBe(0)
		expect(release).not.toHaveBeenCalled()
		expect(process.exit).toHaveBeenCalledWith(0)
	})

	it('awaits lease release even after the command has returned', async () => {
		const { markSessionLeaseUse } = await import('./termination-state.js')
		markSessionLeaseUse()
		const started = deferred<void>()
		const held = deferred<{ released: number; unfinished: number }>()
		release.mockImplementation(() => {
			started.resolve()
			return held.promise
		})
		const { main } = await import('./bin-main.js')
		const exiting = main('/fixture/bin.js')
		await started.promise
		expect(process.exit).not.toHaveBeenCalled()
		held.resolve({ released: 1, unfinished: 0 })
		await exiting
		expect(process.exit).toHaveBeenCalledWith(0)
	})

	it('gives leases back before reporting a failed command exit', async () => {
		const { markSessionLeaseUse } = await import('./termination-state.js')
		markSessionLeaseUse()
		runCli.mockRejectedValue(new Error('controlled failure'))
		const { main } = await import('./bin-main.js')
		const { EXIT_INTERNAL_ERROR } = await import('./exit-codes.js')
		await main('/fixture/bin.js')
		expect(process.stderr.write).toHaveBeenCalledWith('Fixture crash report\n')
		expect(release).toHaveBeenCalledOnce()
		expect(process.exit).toHaveBeenCalledWith(EXIT_INTERNAL_ERROR)
	})

	it('lets a signal arriving during release own the process exit', async () => {
		const { markSessionLeaseUse, setTerminating } = await import('./termination-state.js')
		markSessionLeaseUse()
		const started = deferred<void>()
		const held = deferred<{ released: number; unfinished: number }>()
		release.mockImplementation(() => {
			started.resolve()
			return held.promise
		})
		const { main } = await import('./bin-main.js')
		const exiting = main('/fixture/bin.js')
		await started.promise
		setTerminating('SIGTERM')
		held.resolve({ released: 1, unfinished: 0 })
		await exiting
		expect(process.exit).not.toHaveBeenCalled()
	})
})

describe('the way out reads nothing from disk, and an install replaced meanwhile is a sentence', () => {
	it('gives leases back with the function the command started with, never importing the kernel again', async () => {
		const { markSessionLeaseUse } = await import('./termination-state.js')
		const own = vi.fn().mockResolvedValue({ released: 1, unfinished: 0 })
		markSessionLeaseUse(own)
		const { main } = await import('./bin-main.js')
		await main('/fixture/bin.js')
		expect(own).toHaveBeenCalledOnce()
		expect(release).not.toHaveBeenCalled()
		expect(imports.kernel).toBe(0)
		expect(process.exit).toHaveBeenCalledWith(0)
	})

	it('still exits with the command code, and says one line, when giving leases back fails for a replaced install', async () => {
		const { markSessionLeaseUse } = await import('./termination-state.js')
		const missing = Object.assign(new Error('Cannot find module'), { code: 'ERR_MODULE_NOT_FOUND' })
		markSessionLeaseUse(() => Promise.reject(missing))
		replaced.mockReturnValue(true)
		const { main } = await import('./bin-main.js')
		await main('/fixture/bin.js')
		expect(process.stderr.write).toHaveBeenCalledWith(
			'Namzu was replaced while this window was open.\n',
		)
		expect(process.exit).toHaveBeenCalledWith(0)
	})

	it('does not turn an ordinary failure of the release into a message or a crash', async () => {
		const { markSessionLeaseUse } = await import('./termination-state.js')
		markSessionLeaseUse(() => Promise.reject(new Error('disk gone')))
		const { main } = await import('./bin-main.js')
		await main('/fixture/bin.js')
		expect(process.stderr.write).not.toHaveBeenCalled()
		expect(process.exit).toHaveBeenCalledWith(0)
	})

	it('reports a command that failed because the install was replaced as one line, not a crash report', async () => {
		runCli.mockRejectedValue(
			Object.assign(new Error('Cannot find module'), { code: 'ERR_MODULE_NOT_FOUND' }),
		)
		replaced.mockReturnValue(true)
		const { main } = await import('./bin-main.js')
		const { EXIT_UNAVAILABLE } = await import('./exit-codes.js')
		await main('/fixture/bin.js')
		expect(process.stderr.write).toHaveBeenCalledWith(
			'Namzu was replaced while this window was open.\n',
		)
		expect(process.stderr.write).not.toHaveBeenCalledWith('Fixture crash report\n')
		expect(process.exit).toHaveBeenCalledWith(EXIT_UNAVAILABLE)
	})
})
