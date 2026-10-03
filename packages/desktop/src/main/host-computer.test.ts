import { hostname } from 'node:os'
import { expect, it } from 'vitest'
import { humanComputer } from './host-computer.js'

it('reports the actual native host without exposing an input target or a guest endpoint', () => {
	expect(humanComputer()).toEqual({ name: hostname().slice(0, 255), platform: process.platform })
	expect(Object.keys(humanComputer()).sort()).toEqual(['name', 'platform'])
})
