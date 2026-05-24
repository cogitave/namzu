/**
 * First-run preference picker. Renders clawtool's `/v1/agents` registry
 * as a keyboard-driven list: pick one default (must be `callable`), tick
 * any others to keep active for subagent dispatch.
 *
 * Visual treatment mirrors the user's reference screenshot — bordered
 * round panel, `[ ]` / `[x]` toggles for "active", `( )` / `(•)` radio
 * for "default", right-aligned status badge, dim help footer.
 */

import { Box, Text, useInput } from 'ink'
import { useState } from 'react'

import type { Agent } from '../integrations/clawtool/index.js'
import { theme } from './theme.js'

export interface PickerProps {
	readonly agents: readonly Agent[]
	readonly onSubmit: (selection: { default: string; active: readonly string[] }) => void
	readonly onCancel: () => void
}

export function Picker({ agents, onSubmit, onCancel }: PickerProps) {
	const initialDefault = agents.find((a) => a.callable)?.instance ?? null
	const [cursor, setCursor] = useState<number>(0)
	const [defaultInstance, setDefault] = useState<string | null>(initialDefault)
	const [active, setActive] = useState<ReadonlySet<string>>(
		new Set(initialDefault ? [initialDefault] : []),
	)
	const [errorHint, setErrorHint] = useState<string | null>(null)

	const callableCount = agents.filter((a) => a.callable).length

	useInput((input, key) => {
		if (key.upArrow) {
			setCursor((c) => Math.max(0, c - 1))
			return
		}
		if (key.downArrow) {
			setCursor((c) => Math.min(agents.length - 1, c + 1))
			return
		}
		const current = agents[cursor]
		if (!current) return
		if (input === ' ') {
			if (!current.callable) {
				setErrorHint(`"${current.instance}" is ${current.status} — not selectable.`)
				return
			}
			setActive((prev) => {
				const next = new Set(prev)
				if (next.has(current.instance)) {
					if (current.instance === defaultInstance) {
						setErrorHint(
							`Cannot deactivate "${current.instance}" while it is the default. Pick a new default first with "d".`,
						)
						return prev
					}
					next.delete(current.instance)
				} else {
					next.add(current.instance)
				}
				setErrorHint(null)
				return next
			})
			return
		}
		if (input === 'd' || input === 'D') {
			if (!current.callable) {
				setErrorHint(`Cannot set "${current.instance}" as default — status is ${current.status}.`)
				return
			}
			setDefault(current.instance)
			setActive((prev) => {
				const next = new Set(prev)
				next.add(current.instance)
				return next
			})
			setErrorHint(null)
			return
		}
		if (key.return) {
			if (!defaultInstance) {
				setErrorHint('Pick a default first ("d" on a callable row).')
				return
			}
			if (!active.has(defaultInstance)) {
				setErrorHint('Default must be in the active set.')
				return
			}
			onSubmit({ default: defaultInstance, active: [...active] })
			return
		}
		if (key.escape) {
			onCancel()
			return
		}
	})

	return (
		<Box flexDirection="column" borderStyle="round" borderColor={theme.border.focus} paddingX={1}>
			<Box flexDirection="column" paddingBottom={1}>
				<Text color={theme.accent.system} bold>
					Choose your agent
				</Text>
				<Text color={theme.text.muted}>
					{callableCount} callable · {agents.length} total · clawtool registry
				</Text>
			</Box>
			<Box flexDirection="column">
				{agents.map((a, i) => (
					<AgentRow
						key={a.instance}
						agent={a}
						selected={i === cursor}
						isActive={active.has(a.instance)}
						isDefault={a.instance === defaultInstance}
					/>
				))}
			</Box>
			<Box flexDirection="column" paddingTop={1}>
				<Text color={theme.text.muted}>
					↑↓ navigate · space toggle active · d set default · enter accept · esc cancel
				</Text>
				{errorHint ? <Text color={theme.status.warn}>{errorHint}</Text> : null}
			</Box>
		</Box>
	)
}

function AgentRow({
	agent,
	selected,
	isActive,
	isDefault,
}: {
	readonly agent: Agent
	readonly selected: boolean
	readonly isActive: boolean
	readonly isDefault: boolean
}) {
	const radio = isDefault ? '(•)' : '( )'
	const toggle = isActive ? '[x]' : '[ ]'
	const status = agent.callable ? 'callable' : agent.status
	const statusColor = agent.callable ? theme.status.ok : theme.status.warn
	const nameColor = selected
		? theme.border.focus
		: agent.callable
			? theme.text.primary
			: theme.text.muted
	const cursor = selected ? '›' : ' '
	const hint = !agent.callable
		? `  (run \`clawtool agents claim ${agent.instance}\` to wire)`
		: ''
	return (
		<Box>
			<Text color={selected ? theme.border.focus : theme.text.muted}>{cursor} </Text>
			<Text color={isDefault ? theme.accent.user : theme.text.muted}>{radio} </Text>
			<Text color={isActive ? theme.accent.user : theme.text.muted}>{toggle} </Text>
			<Text color={nameColor} bold={selected}>
				{agent.instance.padEnd(14)}
			</Text>
			<Text color={theme.text.muted}>{agent.family.padEnd(10)}</Text>
			<Text color={statusColor}>{status}</Text>
			{hint ? <Text color={theme.text.muted}>{hint}</Text> : null}
		</Box>
	)
}
