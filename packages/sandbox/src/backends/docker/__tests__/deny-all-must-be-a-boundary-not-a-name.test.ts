import { describe, expect, it } from 'vitest'

import { assertNetworkCarriesThePolicy, isInternalNetwork } from '../index.js'

/**
 * The backend shipped a default configuration that could not create a
 * sandbox, and the one test that would have caught it had never run.
 *
 * Two requirements meet on the container's network and neither was checked.
 * A published host port needs a network with a route out, because docker
 * binds the port by NAT to the container's address. `deny-all` needs a
 * network with no route out, because it no longer answers `--network none`
 * and a network's name says nothing about whether it has one.
 *
 * Measured against Docker 29.6 before this was written:
 *
 *  - `--network none --publish 127.0.0.1::2024` is accepted;
 *    `NetworkSettings.Ports` comes back `{"2024/tcp":[]}` and `docker port`
 *    prints nothing. An `--internal` network behaves identically.
 *  - `--network bridge` publishes: `2024/tcp -> 127.0.0.1:62528`.
 *  - `docker network inspect bridge --format '{{.Internal}}'` → `false`;
 *    the same against an `--internal` network → `true`.
 *  - From a container on an internal network a sibling is reachable by
 *    name, and `wget http://1.1.1.1` fails with `Network unreachable` — the
 *    kernel refusing, not a proxy environment variable a workload may
 *    decline to read.
 *
 * Driving the real backend with the documented defaults produced
 * `index of untyped nil` out of the port readback, reported as "the
 * container exited immediately".
 */

const NONE = undefined
const DENY_ALL = { kind: 'deny-all' } as const

describe('isInternalNetwork', () => {
	it('reads the daemon’s answer', () => {
		expect(isInternalNetwork('true')).toBe(true)
		expect(isInternalNetwork('false')).toBe(false)
	})

	it('tolerates the trailing newline the docker CLI actually prints', () => {
		// A version that only matched an already-trimmed string would pass a
		// unit test and reject every real network.
		expect(isInternalNetwork('true\n')).toBe(true)
	})

	it('treats an unreadable answer as no boundary', () => {
		// A missing network or a daemon that is down arrives as the empty
		// string. Absence of evidence is not a boundary, and defaulting the
		// other way turns every lookup failure into full egress under a
		// policy that says none.
		expect(isInternalNetwork('')).toBe(false)
	})

	it('refuses anything that merely contains the word', () => {
		// Guards a substring match, the shape of bug that has already cost
		// this repo a permission rule.
		expect(isInternalNetwork('not true')).toBe(false)
	})
})

describe('a published host port', () => {
	it('is refused on `none`, which is the documented default', () => {
		// The whole finding in one assertion: the default configuration threw
		// from inside a docker inspect template.
		expect(() => assertNetworkCarriesThePolicy('none', 'host-port', NONE, 'false')).toThrow(
			/cannot publish the worker's port/,
		)
	})

	it('is refused on an internal network, which publishes nothing either', () => {
		expect(() => assertNetworkCarriesThePolicy('locked-down', 'host-port', NONE, 'true')).toThrow(
			/cannot publish the worker's port/,
		)
	})

	it('is allowed on a bridge, which is the only thing that works', () => {
		expect(() => assertNetworkCarriesThePolicy('bridge', 'host-port', NONE, 'false')).not.toThrow()
	})

	it('names both ways forward, so the refusal is actionable', () => {
		expect(() => assertNetworkCarriesThePolicy('none', 'host-port', NONE, 'false')).toThrow(
			/container-network/,
		)
	})
})

describe('a deny-all policy', () => {
	it('is satisfied by an internal network reached by container name', () => {
		expect(() =>
			assertNetworkCarriesThePolicy('locked-down', 'container-network', DENY_ALL, 'true'),
		).not.toThrow()
	})

	it('is refused on a network that can still reach the world', () => {
		expect(() =>
			assertNetworkCarriesThePolicy('shared', 'container-network', DENY_ALL, 'false'),
		).toThrow(/is not internal/)
	})

	it('names the network and the command that fixes it', () => {
		// An operator reading this has to know which network was rejected;
		// "a network is not internal" sends them to inspect all of them.
		const refuse = () =>
			assertNetworkCarriesThePolicy('shared-bridge', 'container-network', DENY_ALL, 'false')
		expect(refuse).toThrow(/shared-bridge/)
		expect(refuse).toThrow(/docker network create --internal/)
	})

	it('is impossible over a published host port, from the two rules alone', () => {
		// The requirements are exact opposites — a published port needs a
		// route out and deny-all needs none — so this is impossible rather
		// than unsupported. Closing it means moving the control channel off
		// TCP. Asserted for both answers the daemon can give, because the
		// case must not become reachable by choosing a different network.
		expect(() => assertNetworkCarriesThePolicy('bridge', 'host-port', DENY_ALL, 'false')).toThrow()
		expect(() =>
			assertNetworkCarriesThePolicy('locked-down', 'host-port', DENY_ALL, 'true'),
		).toThrow()
	})
})
