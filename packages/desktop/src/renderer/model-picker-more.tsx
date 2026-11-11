import { Radio } from '@base-ui/react/radio'
import { RadioGroup } from '@base-ui/react/radio-group'
import { ChevronLeft } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { HarnessView, ProviderView } from '../shared/protocol.js'
import {
	EngineChip,
	type EngineSurfaceControl,
	SurfaceCaption,
	SurfaceSwitch,
} from './harness-picker.js'
import { CheckIcon, CloudIcon, ProviderIcons, ServerIcon } from './icons.js'
import { commitsOnKey } from './picker-commit.js'

type Provider = ProviderView['available'][number]

function ProviderMark({ provider }: { provider: Provider }) {
	const Icon =
		ProviderIcons.get(
			provider.id === 'codex' || provider.id === 'codex-cli'
				? 'openai'
				: provider.id === 'claude-code'
					? 'anthropic'
					: provider.id,
		) ?? (['ollama', 'lmstudio'].includes(provider.id) ? ServerIcon : CloudIcon)
	return (
		<span className="model-provider-mark" aria-hidden="true">
			<Icon />
		</span>
	)
}

/**
 * What the model list no longer carries on its first view: which engine runs the conversation,
 * whether it is chatted with here or opened in a terminal, and which provider's models are listed.
 */
export function ModelMore({
	engine,
	providers,
	shownProvider,
	inUseProvider,
	onPickProvider,
	onBack,
}: {
	/** The engine in force and the way into its list; absent where engines are not offered. */
	engine?: {
		id: HarnessView['selected']
		label: string
		disabled: boolean
		onOpen: () => void
		surface?: EngineSurfaceControl
	}
	/** Offered only when there are two or more. */
	providers?: readonly Provider[]
	shownProvider: string
	inUseProvider: string
	onPickProvider: (id: string) => void
	onBack: () => void
}) {
	const back = useRef<HTMLButtonElement>(null)
	// The popup reclaims focus when the row that opened this view unmounts, so focus is placed again.
	useEffect(() => {
		back.current?.focus({ preventScroll: true })
		const frame = requestAnimationFrame(() => {
			if (document.activeElement !== back.current) back.current?.focus({ preventScroll: true })
		})
		return () => cancelAnimationFrame(frame)
	}, [])
	return (
		<div className="model-more">
			<header className="model-picker-heading">
				<div className="model-picker-heading-copy">
					<button ref={back} type="button" className="model-picker-back" onClick={onBack}>
						<ChevronLeft aria-hidden="true" />
						Models
					</button>
					<h2 className="model-picker-title">More</h2>
				</div>
			</header>
			{engine && (
				<div className="model-more-row">
					<span className="model-more-label">Engine</span>
					<EngineChip
						engine={engine.id}
						label={engine.label}
						disabled={engine.disabled}
						onClick={engine.onOpen}
					/>
				</div>
			)}
			{engine?.surface && (
				<>
					<div className="model-more-row">
						<span className="model-more-label">Open in</span>
						<SurfaceSwitch
							value={engine.surface.value}
							onChange={engine.surface.onChange}
							disabled={engine.surface.disabled}
							reason={engine.surface.reason}
						/>
					</div>
					<SurfaceCaption value={engine.surface.value} />
				</>
			)}
			{providers && providers.length > 1 && (
				<>
					<h3 className="model-more-heading">Show models from</h3>
					<RadioGroup
						aria-label="Show models from"
						className="model-more-providers"
						value={shownProvider}
						// Arrow keys only move the highlight; a choice is made by click, Enter or Space.
						onValueChange={() => {}}
					>
						{providers.map((provider) => (
							<Radio.Root
								key={provider.id}
								value={provider.id}
								nativeButton
								render={<button type="button" />}
								className="model-picker-row"
								aria-label={
									provider.id === inUseProvider ? `${provider.label}, in use` : provider.label
								}
								onClick={(event) => {
									event.preventDefault()
									onPickProvider(provider.id)
								}}
								onKeyDown={(event) => {
									if (commitsOnKey(event.key)) {
										event.preventDefault()
										onPickProvider(provider.id)
									}
								}}
							>
								<ProviderMark provider={provider} />
								<span className="model-picker-name">
									<span>{provider.label}</span>
									{provider.id === inUseProvider && <small>In use</small>}
								</span>
								<span className="model-picker-selection" aria-hidden="true">
									<Radio.Indicator className="model-picker-checked">
										<CheckIcon aria-hidden="true" />
									</Radio.Indicator>
								</span>
							</Radio.Root>
						))}
					</RadioGroup>
				</>
			)}
		</div>
	)
}
