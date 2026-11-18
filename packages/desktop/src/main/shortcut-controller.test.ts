import { expect, it } from 'vitest'
import { ShortcutController, type ShortcutSystem } from './shortcut-controller.js'

function setup(taken: string[] = []) {
	const held = new Map<string, () => void>()
	const system: ShortcutSystem = {
		register: (accelerator, run) => {
			if (taken.includes(accelerator)) return false
			held.set(accelerator, run)
			return true
		},
		unregister: (accelerator) => void held.delete(accelerator),
	}
	const opened: string[] = []
	const controller = new ShortcutController(system, {
		quickEntry: () => opened.push('quick'),
		voice: () => opened.push('voice'),
	})
	return { held, opened, controller }
}

it('registers what is wanted and runs the slot action when pressed', () => {
	const { held, opened, controller } = setup()
	controller.sync({ quickEntry: 'Ctrl+Alt+Space', voice: '' })
	expect(controller.state('quickEntry')).toEqual({ registered: true })
	expect(controller.state('voice')).toEqual({ registered: false })
	held.get('Ctrl+Alt+Space')?.()
	expect(opened).toEqual(['quick'])
})

it('says plainly that keys another app holds are not registered', () => {
	const { controller } = setup(['Ctrl+Alt+Space'])
	controller.sync({ quickEntry: 'Ctrl+Alt+Space', voice: '' })
	const state = controller.state('quickEntry')
	expect(state.registered).toBe(false)
	expect(state.problem).toContain('Ctrl+Alt+Space is taken by another app')
})

it('clearing removes the shortcut at once, and changing it moves the registration', () => {
	const { held, controller } = setup()
	controller.sync({ quickEntry: 'Ctrl+Alt+Space', voice: 'Ctrl+Alt+V' })
	expect([...held.keys()].sort()).toEqual(['Ctrl+Alt+Space', 'Ctrl+Alt+V'])
	controller.sync({ quickEntry: '', voice: 'Ctrl+Alt+B' })
	expect([...held.keys()]).toEqual(['Ctrl+Alt+B'])
	expect(controller.state('quickEntry')).toEqual({ registered: false })
})

it('refuses the same keys for both slots and keys that are not a shortcut', () => {
	const { held, controller } = setup()
	controller.sync({ quickEntry: 'Ctrl+Alt+Q', voice: 'Ctrl+Alt+Q' })
	expect(controller.state('quickEntry').registered).toBe(true)
	expect(controller.state('voice').problem).toContain('already the other Namzu shortcut')
	controller.sync({ quickEntry: 'Ctrl+Alt+Q', voice: 'nonsense' })
	expect(controller.state('voice').problem).toContain('not a shortcut')
	controller.dispose()
	expect(held.size).toBe(0)
})

it('a key one slot gives up in a sync can be claimed by the other slot in the same sync', () => {
	const { held, controller } = setup()
	controller.sync({ quickEntry: 'Ctrl+Alt+Q', voice: 'Ctrl+Alt+V' })
	controller.sync({ quickEntry: 'Ctrl+Alt+V', voice: 'Ctrl+Alt+Q' })
	expect(controller.state('quickEntry')).toEqual({ registered: true })
	expect(controller.state('voice')).toEqual({ registered: true })
	expect(held.size).toBe(2)
	controller.sync({ quickEntry: 'Ctrl+Alt+V', voice: '' })
	controller.sync({ quickEntry: '', voice: 'Ctrl+Alt+V' })
	expect(controller.state('voice')).toEqual({ registered: true })
})
