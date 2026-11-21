import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { openLivePeers } from '../integrations/peers/runtime.js'
import { sendToTerminal } from '../integrations/peers/send-once.js'
import { planLaunchMode } from '../permissions/launch.js'
import type { PermissionSettings } from '../permissions/settings.js'
import {
	parsePeersArgs,
	peerSenderMode,
	receiptExitCode,
	renderListing,
	renderReceipt,
} from './peers.js'

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

it('acts, with no --mode, in the mode a new terminal here starts in', () => {
	const settings: (PermissionSettings | undefined)[] = [
		undefined,
		{ defaultMode: 'plan' },
		{ disableAutoMode: true },
	]
	for (const each of settings) {
		expect(peerSenderMode(undefined, each)).toEqual(
			planLaunchMode({ settings: each, interactive: true }),
		)
	}
	expect(peerSenderMode(undefined, undefined)).toMatchObject({ plan: { mode: 'classify' } })
	expect(peerSenderMode(undefined, { disableAutoMode: true })).toMatchObject({
		plan: { mode: 'prompt' },
	})
	expect(peerSenderMode('prompt', undefined)).toMatchObject({ plan: { mode: 'prompt' } })
})

it('reaches a terminal in its default mode from a send that names none', async () => {
	const root = mkdtempSync(join(tmpdir(), 'peers-default-'))
	const cwd = join(root, 'p')
	mkdirSync(cwd)
	const common = { home: join(root, 'h'), cwd, version: 'fixture', env: {} }
	const terminal = planLaunchMode({ interactive: true })
	const sender = peerSenderMode(undefined, undefined)
	if ('error' in terminal || 'error' in sender) throw new Error('no plan')
	const receiver = await openLivePeers({
		...common,
		mode: () => terminal.plan.mode,
		owner: () => 0,
		state: () => 'idle' as const,
		ready: () => true,
		available: () => {},
		report: () => {},
	})
	try {
		const receipt = await sendToTerminal({
			...common,
			target: receiver.ref,
			message: 'hi',
			mode: sender.plan.mode,
		})
		expect(receipt.status).toBe('queued')
	} finally {
		await receiver.close()
		removeTempDir(root)
	}
})
