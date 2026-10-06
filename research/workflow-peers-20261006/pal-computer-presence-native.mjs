import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Run with native Windows Node against an isolated copy of the built SDK prompt
// module. No CLI, Pal runtime, model, computer lease or desktop process is used.
assert.equal(process.platform, 'win32', 'This fixture verifies native Windows Node only.')
assert.ok(process.argv[2], 'Supply the isolated built prompt module path.')
const modulePath = resolve(process.argv[2])
const { buildPalSystemPrompt, palConversationGreeting } = await import(pathToFileURL(modulePath).href)
const profile = Object.freeze({
	id: 'isolated-native-presence-proof',
	revision: 7,
	name: 'Sıtkı',
	purpose: 'Help with research and creative work.',
	appearance: Object.freeze({ character: 'sprout', color: 'green' }),
})
const unchanged = JSON.stringify(profile)
const greeting = Object.freeze(palConversationGreeting(profile, 'isolated-conversation'))
const cases = []
const prompts = []

for (const [control, expected] of [
	['operator', 'The user currently has control.'],
	['pal', 'The host reports Pal control, but has not admitted computer actions'],
	['transitioning', 'Its control is changing.'],
	['unavailable', 'The host cannot currently confirm its input control.'],
]) {
	const prompt = buildPalSystemPrompt(profile, {
		greeting,
		computer: { status: 'connected', control },
	})
	assert.ok(prompt.includes('Your own local virtual computer is connected.'))
	assert.ok(prompt.includes(expected))
	assert.ok(prompt.includes('No guest tools are admitted to this conversation.'))
	assert.ok(prompt.includes('not a screen observation or execution authority'))
	assert.ok(!prompt.includes('Your own local virtual computer is available.'))
	assert.ok(!prompt.includes('virtual computer is not currently available'))
	assert.ok(!prompt.includes('Use computer_use for its desktop.'))
	if (control === 'operator')
		assert.ok(prompt.includes('return control before you can perform guest actions'))
	cases.push(`connected:${control}`)
	prompts.push(prompt)
}

for (const [label, computer] of [
	['unavailable', { status: 'unavailable' }],
	['default-unavailable', undefined],
]) {
	const prompt = buildPalSystemPrompt(profile, { greeting, computer })
	assert.ok(prompt.includes('Your virtual computer is not currently available to this conversation.'))
	assert.ok(prompt.includes('You can still chat.'))
	assert.ok(!prompt.includes('Your own local virtual computer is connected.'))
	assert.ok(!prompt.includes('Use computer_use for its desktop.'))
	cases.push(label)
	prompts.push(prompt)
}

for (const [label, workGuidance] of [['ready', undefined], ['ready:basic', 'basic']]) {
	const prompt = buildPalSystemPrompt(profile, {
		greeting, workGuidance,
		computer: { status: 'ready', workingDirectory: '/guest/work' },
	})
	assert.ok(prompt.includes('Your own local virtual computer is available.'))
	assert.ok(prompt.includes('only to its filesystem at /guest/work'))
	assert.ok(prompt.includes('Use computer_use for its desktop.'))
	assert.equal(prompt.includes('use an observe, act, compare and correct loop'), workGuidance === undefined)
	assert.ok(!prompt.includes('No guest tools are admitted to this conversation.'))
	cases.push(label)
	prompts.push(prompt)
}

for (const prompt of prompts) {
	assert.ok(prompt.includes('You are "Sıtkı", a persistent Namzu Pal.'))
	assert.ok(prompt.includes('Start in English until the user speaks or requests another language'))
	assert.ok(prompt.includes('A request to use a computer never authorizes a host fallback.'))
	assert.ok(prompt.includes('host-authored onboarding greeting'))
	assert.equal(prompt.split('\n\n')[0], prompts[0].split('\n\n')[0])
}
assert.equal(JSON.stringify(profile), unchanged)
assert.deepEqual(palConversationGreeting(profile, 'isolated-conversation'), greeting)

const receipt = {
	scope: 'Native Windows compiled SDK Pal prompt module only; not live deployment or CLI runtime verification.',
	result: 'passed',
	platform: process.platform,
	arch: process.arch,
	node: process.version,
	verifiedAt: new Date().toISOString(),
	moduleSource: 'packages/sdk/dist/pals/prompt.js (isolated copy, no dependencies)',
	moduleSha256: createHash('sha256').update(readFileSync(modulePath)).digest('hex'),
	cases,
	profileUnchanged: true,
	modelRequests: 0,
	livePalActions: 0,
}
const serialized = `${JSON.stringify(receipt, null, 2)}\n`
if (process.argv[3]) writeFileSync(resolve(process.argv[3]), serialized, 'utf8')
process.stdout.write(serialized)
