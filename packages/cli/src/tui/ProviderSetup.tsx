import { Box, Text, useInput } from 'ink'
import { useEffect, useRef, useState } from 'react'
import { discoverProviders } from '../integrations/providers/discover.js'
import { installHarness, probeHarnesses, type SetupProbe } from '../integrations/providers/setup.js'
import { choiceDisplayText } from './terminal-choice-text.js'
import { theme } from './theme.js'

export function ProviderSetup({
	cwd,
	onClose,
	onConnect,
}: { cwd: string; onClose: () => void; onConnect: () => void }) {
	const [rows, setRows] = useState<SetupProbe[]>([])
	const [selected, setSelected] = useState(0)
	const [confirm, setConfirm] = useState(false)
	const [busy, setBusy] = useState(true)
	const [output, setOutput] = useState('Checking installations and credential sources…')
	const lifetime = useRef<AbortController | null>(null)
	const operation = useRef<AbortController | null>(null)
	const refresh = async (signal: AbortSignal) => {
		const detected = await discoverProviders({ skipProbes: true })
		const next = await probeHarnesses(detected, cwd, signal)
		if (!signal.aborted) setRows(next)
	}
	useEffect(() => {
		const controller = new AbortController()
		lifetime.current = controller
		void refresh(controller.signal)
			.then(() => {
				if (!controller.signal.aborted)
					setOutput('Choose a provider. Installation and sign-in are separate steps.')
			})
			.catch((error) => {
				if (!controller.signal.aborted) setOutput(String(error))
			})
			.finally(() => {
				if (!controller.signal.aborted) setBusy(false)
			})
		return () => {
			controller.abort()
			operation.current?.abort()
		}
	}, [])
	const install = async () => {
		const target = rows[selected]
		if (!target || busy || operation.current) return
		setConfirm(false)
		setBusy(true)
		const controller = new AbortController()
		operation.current = controller
		setOutput(`Running npm install --global ${target.harness.npmPackage}`)
		try {
			const result = await installHarness(target.harness, {
				cwd,
				signal: controller.signal,
				onOutput: (text) => {
					if (!lifetime.current?.signal.aborted) setOutput(text)
				},
			})
			if (lifetime.current?.signal.aborted) return
			await refresh(lifetime.current!.signal)
			setOutput(
				controller.signal.aborted
					? 'Installation stopped. Files already installed may remain; state was checked again.'
					: result.code === 0
						? 'Installer exited successfully. Check installation above, then press c to connect; installation alone does not sign you in.'
						: `Installation failed (exit ${result.code ?? 'unknown'}).\n${result.output}`,
			)
		} catch (error) {
			if (!lifetime.current?.signal.aborted) setOutput(String(error))
		} finally {
			operation.current = null
			if (!lifetime.current?.signal.aborted) setBusy(false)
		}
	}
	useInput((input, key) => {
		if (key.escape || (key.ctrl && input === 'c')) {
			if (busy && operation.current) {
				operation.current.abort()
				return
			}
			if (confirm) {
				setConfirm(false)
				return
			}
			onClose()
			return
		}
		if (busy) return
		if (confirm) {
			if (input === 'y') void install()
			else if (input === 'n') setConfirm(false)
			return
		}
		if (key.upArrow) setSelected((value) => Math.max(0, value - 1))
		if (key.downArrow) setSelected((value) => Math.min(rows.length - 1, value + 1))
		if (input === 'i' && rows[selected] && !rows[selected]!.installed) setConfirm(true)
		if (input === 'c') onConnect()
		if (input === 'r') {
			setBusy(true)
			void refresh(lifetime.current!.signal)
				.catch((error) => setOutput(String(error)))
				.finally(() => setBusy(false))
		}
	})
	const target = rows[selected]
	return (
		<Box borderStyle="round" borderColor={theme.border.focus} flexDirection="column" paddingX={1}>
			<Text bold>Provider setup</Text>
			<Text dimColor>Namzu connects directly. External CLIs are optional credential owners.</Text>
			{rows.map((row, index) => (
				<Box key={row.harness.id} flexDirection="column" marginTop={1}>
					<Text color={index === selected ? theme.border.focus : undefined}>
						{index === selected ? '›' : ' '} {row.harness.label} ·{' '}
						{row.installed ? `Installed · ${choiceDisplayText(row.version)}` : 'Not installed'}
					</Text>
					<Text dimColor> {row.access}</Text>
				</Box>
			))}
			<Box marginTop={1} flexDirection="column">
				{output
					.split('\n')
					.slice(-8)
					.map((line, index) => (
						<Text key={index}>{choiceDisplayText(line).slice(-200)}</Text>
					))}
			</Box>
			{confirm && target ? (
				<Box flexDirection="column" marginTop={1}>
					<Text bold>Install {target.harness.label}?</Text>
					<Text>npm install --global {target.harness.npmPackage}</Text>
					<Text>Downloads packages and runs their installation scripts on this device.</Text>
					<Text>y install · n cancel</Text>
				</Box>
			) : (
				<Text dimColor>
					{busy
						? 'Working · esc cancel'
						: '↑↓ select · i install missing CLI · c connect / select model · r check again · esc back'}
				</Text>
			)}
		</Box>
	)
}
