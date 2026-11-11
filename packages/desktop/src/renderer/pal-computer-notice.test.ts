import { expect, it } from 'vitest'
import {
	COMPUTER_SETUP_NOTICE,
	computerNotSetUp,
	computerPodmanStopped,
	computerSetupMissing,
	presentComputerNotice,
} from './pal-computer-notice.js'

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
	expect(COMPUTER_SETUP_NOTICE).not.toMatch(/image|docs/i)
	expect(COMPUTER_SETUP_NOTICE).toContain('start your Pal again')
})

it('says a stopped Podman machine is stopped, and what to do', () => {
	expect(
		presentComputerNotice(
			'The selected local Podman machine pipe is unavailable; start that machine explicitly',
		),
	).toBe('Your Podman machine is not running. Start it, then start your Pal again.')
})

it('never leaks a repository path, even from an unrecognised failure', () => {
	const shown = presentComputerNotice('spawn failed at packages/sandbox/src/x.ts:12')
	expect(shown).not.toContain('packages/')
	expect(shown).toContain('start your Pal again')
})

it('keeps a plain sentence that carries no developer detail', () => {
	expect(presentComputerNotice('Starting the local computer…')).toBe('Starting the local computer…')
	expect(presentComputerNotice('Start your Pal’s local computer to use apps and tools.')).toBe(
		'Start your Pal’s local computer to use apps and tools.',
	)
	expect(presentComputerNotice(undefined)).toBeUndefined()
	expect(presentComputerNotice('  ')).toBeUndefined()
})

it('never shows the command line or the engine name from Windows', () => {
	for (const raw of [
		'Windows Linux container support and the Pal computer image are required. Namzu sets them up; finish the setup from the Pal computer and try again. Run namzu computer setup to set this up.',
		'Windows Linux container support on this PC is too old for Namzu. Run namzu computer setup to set this up.',
	]) {
		const shown = presentComputerNotice(raw)
		expect(shown).toBe(
			'Linux support for Pal computers is not ready on this PC. Namzu sets it up from the Pal computer.',
		)
		expect(shown).not.toMatch(/namzu computer|wslc/i)
	}
})

it('does not send the person back to the setup once this PC has been set up', () => {
	const shown = presentComputerNotice(
		'Windows Linux container support and the Pal computer image are required. Run namzu computer setup to set this up.',
		{ setupRan: true },
	)
	expect(shown).toBe(
		'The Pal computer did not start on this PC. Use Try again in the Pal computer row, or open Details there.',
	)
	expect(shown).not.toMatch(/sets it up|namzu computer|wslc/i)
})

it('parks the read loop and shows the setup card on one test, so a parked loop always has its card', () => {
	for (const notice of [
		'Local Docker or Podman is required for the Pal computer.',
		'The Pal computer is not set up on this machine.',
		'Podman machine is stopped.',
	]) {
		const parked = computerNotSetUp('unavailable', notice)
		expect(parked, notice).toBe(true)
	}
	expect(computerNotSetUp('stopped', 'Podman machine is stopped.')).toBe(false)
	expect(computerNotSetUp('unavailable', 'The socket timed out.')).toBe(false)
	// A notice only the wider test knows is still parked; the card follows the same test.
	expect(computerSetupMissing('The Pal computer is not set up on this machine.')).toBe(false)
	expect(computerNotSetUp('unavailable', 'The Pal computer is not set up on this machine.')).toBe(
		true,
	)
})

it('tells a stopped Podman machine from a missing engine', () => {
	expect(computerPodmanStopped('Podman machine is stopped.')).toBe(true)
	expect(computerPodmanStopped('Local Docker or Podman is required.')).toBe(false)
	expect(computerPodmanStopped(undefined)).toBe(false)
})
