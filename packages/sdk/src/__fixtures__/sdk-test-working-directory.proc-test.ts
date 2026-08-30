import { realpath } from 'node:fs/promises'
import { expect, it } from 'vitest'

it('applies the SDK test boundary to the separate process suite', async () => {
	const workingDirectory = await realpath(process.cwd())
	expect(process.env.NAMZU_SDK_TEST_ROOT).toBe(workingDirectory)
	expect(process.env.NAMZU_SDK_TEST_WORKER_VERIFIED).toBe(workingDirectory)
})
