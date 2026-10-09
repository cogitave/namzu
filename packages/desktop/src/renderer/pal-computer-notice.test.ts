import { expect, it } from 'vitest'
import { COMPUTER_SETUP_NOTICE, presentComputerNotice } from './pal-computer-notice.js'

const developerWording = [
	'A local Docker engine running Linux containers and the namzu-local-computer:1 image are required. Build packages/sandbox/local-computer/Dockerfile explicitly; Namzu does not install or pull it automatically.',
	'The namzu-local-computer:1 image is not installed on this local engine. Build packages/sandbox/local-computer/Dockerfile explicitly; Namzu does not pull or build it automatically.',
	'A local Podman machine running Linux containers and the namzu-local-computer:1 image are required. Build packages/sandbox/local-computer/Dockerfile explicitly.',
	'The local container engine command failed (1)',
	'The local Pal computer image must declare the Namzu desktop protocol and non-root guest user; rebuild the shipped Dockerfile',
]

it('replaces developer build instructions with what is missing and how to get it', () => {
	for (const raw of developerWording) {
		const shown = presentComputerNotice(raw)
		expect(shown).toBe(COMPUTER_SETUP_NOTICE)
		expect(shown).not.toMatch(/Dockerfile|packages\/|namzu-local-computer|build /i)
	}
	expect(COMPUTER_SETUP_NOTICE).toContain('Docker Desktop or Podman')
	expect(COMPUTER_SETUP_NOTICE).toContain('Namzu computer image')
	expect(COMPUTER_SETUP_NOTICE).toContain('Start computer')
})

it('says a stopped Podman machine is stopped, and what to do', () => {
	expect(
		presentComputerNotice(
			'The selected local Podman machine pipe is unavailable; start that machine explicitly',
		),
	).toBe('Your Podman machine is not running. Start it, then choose Start computer again.')
})

it('never leaks a repository path, even from an unrecognised failure', () => {
	const shown = presentComputerNotice('spawn failed at packages/sandbox/src/x.ts:12')
	expect(shown).not.toContain('packages/')
	expect(shown).toContain('Start computer')
})

it('keeps a plain sentence that carries no developer detail', () => {
	expect(presentComputerNotice('Starting the local computer…')).toBe('Starting the local computer…')
	expect(presentComputerNotice('Start your Pal’s local computer to use apps and tools.')).toBe(
		'Start your Pal’s local computer to use apps and tools.',
	)
	expect(presentComputerNotice(undefined)).toBeUndefined()
	expect(presentComputerNotice('  ')).toBeUndefined()
})
