import type { LookupAddress } from 'node:dns'
import { describe, expect, it } from 'vitest'

import {
	type AddressResolver,
	EgressAddressDenied,
	blockedAddressReason,
	blockedLiteralReason,
	createScreeningLookup,
} from '../address.js'

/**
 * The allowlist answers "is this NAME permitted". Where the name goes is a
 * different question, and only the second one decides what the socket
 * reaches — so this file is about addresses, and `allowlist.test.ts` is about
 * names.
 *
 * Both directions are pinned deliberately. A screen that blocks too much is
 * not the safe failure it looks like: a boundary written with `>=` where it
 * needed `>` deletes a slice of the public internet, and it does so quietly,
 * because nobody writes a test for the address that was supposed to work.
 */

/** A resolver that answers with exactly these addresses. */
function resolvesTo(...addresses: string[]): AddressResolver {
	return (_hostname, _options, callback) => {
		callback(
			null,
			addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
		)
	}
}

function screen(hostname: string, resolve: AddressResolver, allowInwardFor?: string[]) {
	const lookup = createScreeningLookup(
		{ resolve, ...(allowInwardFor ? { allowInwardFor } : {}) },
		(host, patterns) => patterns.includes(host),
	)
	return new Promise<{ err: NodeJS.ErrnoException | null; address: string | LookupAddress[] }>(
		(resolve_) => {
			lookup(hostname, { all: false }, (err, address) => resolve_({ err, address }))
		},
	)
}

describe('which addresses a sandbox may reach', () => {
	it('refuses the v4 ranges that point back inside', () => {
		expect(blockedAddressReason('127.0.0.1')).toBe('loopback')
		expect(blockedAddressReason('10.1.2.3')).toBe('private')
		expect(blockedAddressReason('192.168.1.1')).toBe('private')
		expect(blockedAddressReason('172.20.0.5')).toBe('private')
		expect(blockedAddressReason('100.100.0.1')).toBe('shared-address-space')
		expect(blockedAddressReason('0.0.0.0')).toBe('this-host')
	})

	it('refuses the metadata address every host platform answers on', () => {
		// The range that turns a name check into a credential leak: an
		// allowlisted name resolving here gets the brokered token delivered to
		// the instance's own metadata service.
		expect(blockedAddressReason('169.254.169.254')).toBe('link-local')
	})

	it('lets an ordinary public address through', () => {
		expect(blockedAddressReason('93.184.216.34')).toBeNull()
		expect(blockedAddressReason('8.8.8.8')).toBeNull()
		expect(blockedAddressReason('2606:4700:4700::1111')).toBeNull()
	})

	describe('the boundaries, from both sides', () => {
		// Each pair brackets a blocked block. The address one step outside has
		// to pass, or the screen is quietly refusing hosts that were never the
		// problem — and an over-blocking screen produces a bug report about
		// "the network", not about this file.
		it('brackets 172.16.0.0/12', () => {
			expect(blockedAddressReason('172.15.255.255')).toBeNull()
			expect(blockedAddressReason('172.16.0.0')).toBe('private')
			expect(blockedAddressReason('172.31.255.255')).toBe('private')
			expect(blockedAddressReason('172.32.0.0')).toBeNull()
		})

		it('brackets 169.254.0.0/16', () => {
			expect(blockedAddressReason('169.253.255.255')).toBeNull()
			expect(blockedAddressReason('169.254.0.0')).toBe('link-local')
			expect(blockedAddressReason('169.254.255.255')).toBe('link-local')
			expect(blockedAddressReason('169.255.0.0')).toBeNull()
		})

		it('brackets 100.64.0.0/10', () => {
			expect(blockedAddressReason('100.63.255.255')).toBeNull()
			expect(blockedAddressReason('100.64.0.0')).toBe('shared-address-space')
			expect(blockedAddressReason('100.127.255.255')).toBe('shared-address-space')
			expect(blockedAddressReason('100.128.0.0')).toBeNull()
		})

		it('brackets the multicast and reserved tail', () => {
			expect(blockedAddressReason('223.255.255.255')).toBeNull()
			expect(blockedAddressReason('224.0.0.1')).toBe('multicast')
			expect(blockedAddressReason('239.255.255.255')).toBe('multicast')
			expect(blockedAddressReason('240.0.0.1')).toBe('reserved')
		})
	})

	describe('IPv6', () => {
		it('refuses loopback, unique-local and link-local', () => {
			expect(blockedAddressReason('::1')).toBe('loopback')
			expect(blockedAddressReason('fc00::1')).toBe('unique-local')
			expect(blockedAddressReason('fd12:3456::1')).toBe('unique-local')
			expect(blockedAddressReason('fe80::1')).toBe('link-local')
			expect(blockedAddressReason('febf::1')).toBe('link-local')
			expect(blockedAddressReason('ff02::1')).toBe('multicast')
		})

		it('reads the prefix as a number, not as the letters it starts with', () => {
			// `fd::1` is `00fd:0:0:0:0:0:0:1` — an ordinary global address that
			// merely SPELLS like `fd00::/8`, and `fe8::1` is `0fe8:…`. A
			// `/^f[cd]/` screen blocks both, which is the `>=`-where-`>`-was-
			// meant mistake wearing a regex: it deletes public addresses and
			// nothing complains, because nobody tests the address that worked.
			expect(blockedAddressReason('fd::1')).toBeNull()
			expect(blockedAddressReason('fe8::1')).toBeNull()
			expect(blockedAddressReason('fbff::1')).toBeNull()
			expect(blockedAddressReason('fec0::1')).toBeNull()
		})

		it('sees a v4 address wearing a v6 spelling, in every spelling', () => {
			// A v4-only screen passes all of these, which is a documented way
			// through this kind of filter rather than an oversight.
			expect(blockedAddressReason('::ffff:127.0.0.1')).toBe('loopback')
			expect(blockedAddressReason('::ffff:7f00:1')).toBe('loopback')
			expect(blockedAddressReason('::ffff:169.254.169.254')).toBe('link-local')
			expect(blockedAddressReason('::ffff:a9fe:a9fe')).toBe('link-local')
			// Written long. No `^::`-anchored pattern sees this one, and it is
			// the same metadata address.
			expect(blockedAddressReason('0:0:0:0:0:ffff:169.254.169.254')).toBe('link-local')
			expect(blockedAddressReason('0:0:0:0:0:ffff:a9fe:a9fe')).toBe('link-local')
			// The deprecated v4-compatible form reaches the v4 host too.
			expect(blockedAddressReason('::127.0.0.1')).toBe('loopback')
		})

		it('is not fooled by a zone id', () => {
			expect(blockedAddressReason('fe80::1%eth0')).toBe('link-local')
		})
	})

	describe('a literal, as the proxy receives it', () => {
		it('screens the bracketed spelling a proxied client actually sends', () => {
			// `new URL('http://[::1]/').hostname` is `[::1]`, brackets and all,
			// and that is exactly what the proxy reads off the request line.
			//
			// A layer, not a hole: Node does not read a bracketed string as a
			// literal either, so an unbracketed-only check sends the host to
			// `dns.lookup` and the screening resolver refuses it there. What is
			// pinned here is that this function stops answering `null` about an
			// address it plainly recognises.
			expect(blockedLiteralReason('[::1]')).toBe('loopback')
			expect(blockedLiteralReason('[::ffff:169.254.169.254]')).toBe('link-local')
			expect(blockedLiteralReason('[2606:4700::1111]')).toBeNull()
		})

		it('does not screen a NAME as though it were an address', () => {
			// As text these begin the way the v6 ranges do, and under the
			// regex screen this file replaced they were refused outright — an
			// address screen behaving as a name filter with a bug.
			//
			// Two things now stop that, and the honest reading is that this
			// case pins the OUTCOME rather than either mechanism: `parseV6`
			// refuses a hostname on its own, so removing the `isIP` guard
			// breaks nothing here. The guard is kept as the statement of
			// contract; see its comment.
			expect(blockedLiteralReason('fdsomething.example')).toBeNull()
			expect(blockedLiteralReason('ff-cdn.example')).toBeNull()
			expect(blockedLiteralReason('fe80.example.com')).toBeNull()
			expect(blockedLiteralReason('example.com')).toBeNull()
		})

		it('leaves a numeric host that is not a literal to the resolver', () => {
			// `2130706433` and `0177.0.0.1` are loopback to a C resolver and are
			// not IP literals to Node, so they are NOT screened here — they go
			// out as names, through `createScreeningLookup`, and are refused on
			// the address that comes back. Pinned so nobody closes the gap by
			// string-parsing these forms and reopens it for the next spelling.
			expect(blockedLiteralReason('2130706433')).toBeNull()
			expect(blockedLiteralReason('0177.0.0.1')).toBeNull()
		})
	})
})

describe('screening inside the resolution the socket performs', () => {
	it('passes a public answer through', async () => {
		const { err, address } = await screen('cdn.example', resolvesTo('93.184.216.34'))
		expect(err).toBeNull()
		expect(address).toBe('93.184.216.34')
	})

	it('refuses a name that resolves inward, naming the address', async () => {
		const { err } = await screen('friendly.example', resolvesTo('169.254.169.254'))
		expect(err).toBeInstanceOf(EgressAddressDenied)
		expect((err as EgressAddressDenied).address).toBe('169.254.169.254')
		expect((err as EgressAddressDenied).reason).toBe('link-local')
		expect(err?.message).toContain('friendly.example')
	})

	it('screens every answer, not only the one it would have used', async () => {
		// A record set mixing a public address with an inward one is the
		// ordinary shape of this attack. Screening only the winner makes the
		// outcome depend on resolver ordering, which is not a security
		// property — so the public address FIRST must still be refused.
		const { err } = await screen('mixed.example', resolvesTo('93.184.216.34', '127.0.0.1'))
		expect(err).toBeInstanceOf(EgressAddressDenied)
		expect((err as EgressAddressDenied).address).toBe('127.0.0.1')
	})

	it('exempts one host without exempting the rest', async () => {
		const exempt = await screen('inside.example', resolvesTo('10.0.0.5'), ['inside.example'])
		expect(exempt.err).toBeNull()
		expect(exempt.address).toBe('10.0.0.5')

		// The escape hatch is per host. A neighbour on the same policy gets
		// nothing from it, which is what stops it being a global switch.
		const other = await screen('elsewhere.example', resolvesTo('10.0.0.5'), ['inside.example'])
		expect(other.err).toBeInstanceOf(EgressAddressDenied)
	})

	it('refuses a name that resolves to nothing rather than dialling', async () => {
		const { err } = await screen('void.example', resolvesTo())
		expect(err?.code).toBe('ENOTFOUND')
	})

	it('passes a resolver failure back unchanged', async () => {
		const broken: AddressResolver = (_hostname, _options, callback) => {
			const failure: NodeJS.ErrnoException = new Error('resolver down')
			failure.code = 'ESERVFAIL'
			callback(failure, [])
		}
		const { err } = await screen('down.example', broken)
		expect(err?.code).toBe('ESERVFAIL')
	})

	it('asks for every address, every time', async () => {
		// The screen is worth nothing if it is handed one answer, so the
		// resolver is always asked with `all`. A caller that asked for a single
		// address would be screening the winner alone.
		const asked: Array<{ all: boolean; verbatim: boolean }> = []
		const recording: AddressResolver = (_hostname, options, callback) => {
			asked.push({ all: options.all, verbatim: options.verbatim })
			callback(null, [{ address: '93.184.216.34', family: 4 }])
		}
		await screen('cdn.example', recording)
		expect(asked).toEqual([{ all: true, verbatim: true }])
	})
})
