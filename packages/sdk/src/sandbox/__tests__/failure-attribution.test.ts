import { describe, expect, it } from 'vitest'

import { attributeSandboxFailure } from '../denial.js'

const allowedRoots = ['/work/project', '/tmp']

function attribute(
	stderr: string,
	environment: 'linux-bwrap' | 'linux-namespace' | 'basic' = 'linux-bwrap',
	exitCode = 1,
) {
	return attributeSandboxFailure({ environment, exitCode, stderr, timedOut: false, allowedRoots })
}

describe('a sandboxed failure is read for who refused it', () => {
	it('calls a read-only filesystem error a sandbox denial', () => {
		const result = attribute("touch: cannot touch '/etc/hosts': Read-only file system\n")
		expect(result?.kind).toBe('denial')
		expect(result?.message).toContain('looks like a sandbox denial')
	})

	it('calls permission denied outside the allowed set a denial', () => {
		expect(
			attribute("cp: cannot create regular file '/usr/local/x': Permission denied\n")?.kind,
		).toBe('denial')
		expect(attribute('bash: /root/.cfg: Operation not permitted\n')?.kind).toBe('denial')
	})

	it('leaves permission denied inside the allowed set as an ordinary failure', () => {
		expect(attribute("cat: '/work/project/secret': Permission denied\n")).toBeUndefined()
		expect(attribute("rm: cannot remove '/tmp/x': Permission denied\n")).toBeUndefined()
	})

	it('does not attribute a path-less permission message', () => {
		expect(attribute('Permission denied\n')).toBeUndefined()
	})

	it('reports a launcher setup failure as a runner failure, not a denial', () => {
		const result = attribute(
			'bwrap: No permissions to create new namespace, likely because the kernel does not allow non-privileged user namespaces.\n',
		)
		expect(result?.kind).toBe('runner-failure')
		expect(result?.message).toContain('not a failure of the command')
	})

	it('does not blame the runner when bwrap only could not exec the command', () => {
		expect(attribute('bwrap: execvp nope: No such file or directory\n')).toBeUndefined()
	})

	it('says nothing on success, on a timeout, or on a tier that confines no files', () => {
		expect(attribute('x: Read-only file system\n', 'linux-bwrap', 0)).toBeUndefined()
		expect(
			attributeSandboxFailure({
				environment: 'linux-bwrap',
				exitCode: 124,
				stderr: 'x: Read-only file system',
				timedOut: true,
				allowedRoots,
			}),
		).toBeUndefined()
		expect(attribute('x: Read-only file system\n', 'linux-namespace')).toBeUndefined()
		expect(attribute('x: Read-only file system\n', 'basic')).toBeUndefined()
	})
})
