import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Operator } from './operator.js'

const operators: Operator[] = []
afterEach(async () => {
	await Promise.all(operators.splice(0).map((owner) => owner.close()))
})

async function projectWith(pr?: unknown) {
	const owner = new Operator(
		{
			program: process.execPath,
			args: [fileURLToPath(new URL('./__fixtures__/rpc-process.mjs', import.meta.url))],
			env: { ...process.env, ...(pr === undefined ? {} : { FIXTURE_PR: JSON.stringify(pr) }) },
		},
		() => {},
	)
	operators.push(owner)
	const project = await owner.openProject(process.cwd())
	return { owner, project }
}

it('hands on the pull request the host found, and nothing it cannot vouch for', async () => {
	const good = { number: 607, url: 'https://github.com/o/r/pull/607', review: 'changes' }
	const { owner, project } = await projectWith({ pr: good })
	expect(await owner.projectPr(project.id)).toEqual(good)
	for (const bad of [
		{ pr: null },
		{ pr: { ...good, url: 'javascript:alert(1)' } },
		{ pr: { ...good, url: 'http://github.com/o/r/pull/1' } },
		{ pr: { ...good, number: 0 } },
		{ pr: { ...good, number: 1.5 } },
		{ pr: { ...good, review: 'loved' } },
		{ pr: 'x' },
	]) {
		const second = await projectWith(bad)
		expect(await second.owner.projectPr(second.project.id)).toBeNull()
	}
})

it('says nothing when the host has no pull request lookup', async () => {
	const { owner, project } = await projectWith()
	expect(await owner.projectPr(project.id)).toBeNull()
})
