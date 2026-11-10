import { expect, it } from 'vitest'
import { parsePeersArgs, receiptExitCode, renderListing, renderReceipt } from './peers.js'

it('parses list and send with flags anywhere', () => {
	expect(parsePeersArgs(['list', '--json'])).toEqual({ verb: 'list', json: true })
	expect(parsePeersArgs(['send', 'ab12cd', 'say', 'hi', '--mode', 'auto', '--json'])).toEqual({
		verb: 'send',
		json: true,
		target: 'ab12cd',
		words: ['say', 'hi'],
		mode: 'auto',
	})
	expect(parsePeersArgs(['send', 'ab12cd', '--file', '-'])).toEqual({
		verb: 'send',
		json: false,
		target: 'ab12cd',
		words: [],
		file: '-',
	})
	expect(parsePeersArgs(['send', 't', '--', '--json', 'x'])).toMatchObject({
		words: ['--json', 'x'],
		json: false,
	})
})

it('rejects bad usage', () => {
	for (const args of [
		[],
		['nope'],
		['list', 'x'],
		['send'],
		['send', 'a'],
		['send', 'a', '--file', 'f', 'words'],
		['send', 'a', 'm', '--mode'],
		['send', 'a', 'm', '--bogus'],
	]) {
		expect(parsePeersArgs(args)).toHaveProperty('error')
	}
})

it('renders receipts in plain words with distinct exit codes', () => {
	const queued = { status: 'queued', reason: 'x' } as const
	const refused = {
		status: 'refused',
		reason: 'The terminals have different permission modes.',
	} as const
	const gone = { status: 'unreachable', reason: 'No receipt arrived.' } as const
	expect(renderReceipt(queued)).toBe(
		'Queued: accepted into the live inbox, not proof the model read it.',
	)
	expect(renderReceipt(refused)).toBe('Refused: The terminals have different permission modes.')
	expect(renderReceipt(gone)).toBe('Unreachable: No receipt arrived.')
	expect([queued, refused, gone].map(receiptExitCode)).toEqual([0, 1, 69])
})

it('renders the listing', () => {
	expect(renderListing([])).toBe('No live terminals in this project.')
	expect(
		renderListing([
			{
				ref: 'ab12cd',
				sessionId: 's',
				title: 'proj',
				state: 'idle',
				mode: 'auto',
				acceptsMessages: true,
			},
		]),
	).toBe('ab12cd  proj  idle  auto')
})
