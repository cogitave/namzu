import { mkdir, realpath, rename } from 'node:fs/promises'
import { expect, it } from 'vitest'

it('runs inside the working directory verified by the SDK test boundary', async () => {
	const workingDirectory = await realpath(process.cwd())
	expect(process.env.NAMZU_SDK_TEST_ROOT).toBe(workingDirectory)
	expect(process.env.NAMZU_SDK_TEST_WORKER_VERIFIED).toBe(workingDirectory)

	if (process.env.NAMZU_SDK_TEST_PROBE_FAIL === '1') {
		expect.fail('deliberate SDK test-runner child failure')
	}
	if (process.env.NAMZU_SDK_TEST_PROBE_HOLD === '1') {
		await new Promise<void>((resolve) => setTimeout(resolve, 3_000))
	}
	if (process.env.NAMZU_SDK_TEST_PROBE_REPLACE_ROOT === '1') {
		await rename(workingDirectory, `${workingDirectory}-moved`)
		await mkdir(workingDirectory)
	}
})
