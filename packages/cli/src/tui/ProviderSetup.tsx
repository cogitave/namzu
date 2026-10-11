import { Box, Text, useInput, useWindowSize } from 'ink'
import { useEffect, useRef, useState } from 'react'
import { discoverProviders } from '../integrations/providers/discover.js'
import { type SetupProbe, installHarness, probeHarnesses } from '../integrations/providers/setup.js'
import { boxedContentWidth, boxedHintWidth, fitHints } from './key-hints.js'
import { explainFailure } from './plain-failure.js'
import { debugRequested } from './plain-interruption.js'
import { setupInstallFailed, setupInstalling, setupRowStatus } from './setup-text.js'
import { choiceDisplayText, wrapBalancedText } from './terminal-choice-text.js'
import { theme } from './theme.js'

const INTRO = 'Codex, Claude Code and OpenCode are optional; Namzu can reuse their sign-ins.'

function wrap(text: string, width: number): readonly string[] {
	return wrapBalancedText(text, Math.max(8, width))
}

export function ProviderSetup({
	cwd,
	onClose,
	onConnect,
}: { cwd: string; onClose: () => void; onConnect: () => void }) {
	const terminal = useWindowSize()
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
	// biome-ignore lint/correctness/useExhaustiveDependencies: the list predates linting of .tsx files; changing it changes when this runs, so it is left as written.
	useEffect(() => {
		const controller = new AbortController()
		lifetime.current = controller
		void refresh(controller.signal)
			.then(() => {
				if (!controller.signal.aborted)
					setOutput('Choose one. Installing and signing in are separate steps.')
			})
			.catch((error) => {
				if (!controller.signal.aborted)
					setOutput(explainFailure(error, 'Could not check this provider.'))
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
		setOutput(setupInstalling(target.harness))
		try {
			const result = await installHarness(target.harness, {
				cwd,
				signal: controller.signal,
				// npm's progress lines are the program's output, not screen text.
				onOutput: () => {},
			})
			if (lifetime.current?.signal.aborted) return
			await refresh(lifetime.current!.signal)
			setOutput(
				controller.signal.aborted
					? 'Installation stopped. Files already installed may remain; state was checked again.'
					: result.code === 0
						? 'Installer exited successfully. Check installation above, then press c to connect; installation alone does not sign you in.'
						: setupInstallFailed(target.harness, result.output, debugRequested()),
			)
		} catch (error) {
			if (!lifetime.current?.signal.aborted)
				setOutput(explainFailure(error, 'Could not check this provider.'))
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
				.catch((error) => setOutput(explainFailure(error, 'Could not check this provider.')))
				.finally(() => setBusy(false))
		}
	})
	const target = rows[selected]
	// Ink keeps the space it broke a line at and starts the next line with it, so
	// text that can wrap is broken here, where a continuation starts at the margin.
	const inner = boxedContentWidth(terminal.columns, 1)
	const hanging = inner - 2
	return (
		<Box borderStyle="round" borderColor={theme.border.focus} flexDirection="column" paddingX={1}>
			<Text bold>Provider setup</Text>
			{wrap(INTRO, inner).map((line, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: wrapped lines have no identity of their own.
				<Text key={index} dimColor>
					{line}
				</Text>
			))}
			{rows.map((row, index) => (
				<Box key={row.harness.id} flexDirection="column" marginTop={1}>
					{/* A hanging indent: a wrapped line lines up under the name, not under the marker. */}
					<Box>
						<Box width={2} flexShrink={0}>
							<Text color={index === selected ? theme.border.focus : undefined}>
								{index === selected ? '›' : ' '}
							</Text>
						</Box>
						<Box flexShrink={1} flexDirection="column">
							{wrap(
								`${row.harness.label} · ${choiceDisplayText(setupRowStatus(row, debugRequested()))}`,
								hanging,
							).map((line, lineIndex) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: wrapped lines have no identity of their own.
								<Text key={lineIndex} color={index === selected ? theme.border.focus : undefined}>
									{line}
								</Text>
							))}
						</Box>
					</Box>
					<Box paddingLeft={2} flexDirection="column">
						{wrap(row.access, hanging).map((line, lineIndex) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: wrapped lines have no identity of their own.
							<Text key={lineIndex} dimColor>
								{line}
							</Text>
						))}
					</Box>
				</Box>
			))}
			<Box marginTop={1} flexDirection="column">
				{output
					.split('\n')
					.slice(-8)
					.flatMap((line) => wrap(choiceDisplayText(line).slice(-200), inner))
					.map((line, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: these rows have no identity of their own and hold no state, so the index is the key.
						<Text key={index}>{line}</Text>
					))}
			</Box>
			{confirm && target ? (
				<Box flexDirection="column" marginTop={1}>
					<Text bold>Install {target.harness.label}?</Text>
					<Text>npm install --global {target.harness.npmPackage}</Text>
					{wrap(
						'Downloads packages and runs their installation scripts on this device.',
						inner,
					).map((line, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: wrapped lines have no identity of their own.
						<Text key={index}>{line}</Text>
					))}
					<Text>y install · n cancel</Text>
				</Box>
			) : (
				<Text dimColor>
					{busy
						? 'Working · esc cancel'
						: fitHints(
								[
									{ text: '↑↓ select', rank: 5 },
									{ text: 'i install missing CLI', short: 'i install', rank: 3 },
									{ text: 'c connect / select model', short: 'c connect', rank: 4 },
									{ text: 'r check again', short: 'r check', rank: 2 },
									{ text: 'esc back', rank: 5 },
								],
								boxedHintWidth(terminal.columns),
							)}
				</Text>
			)}
		</Box>
	)
}
