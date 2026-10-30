import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runCli = vi.hoisted(() => vi.fn())
const release = vi.hoisted(() => vi.fn())
const imports = vi.hoisted(() => ({ kernel: 0 }))
vi.mock('./cli.js', () => ({ runCli }))
vi.mock('@namzu/sdk', () => {
	imports.kernel++
	return { releaseHeldSessionLeases: release }
})
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
