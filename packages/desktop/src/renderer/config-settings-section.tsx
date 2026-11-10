import { useId, useState } from 'react'
import type {
	ConfigSettingDescriptor,
	ConfigSettingsView,
} from '../shared/config-settings-protocol.js'
import type { SettingsSection } from '../shared/settings-protocol.js'
import {
	configSettingId,
	configSettingsFor,
	confirmationCopy,
	defaultNote,
	defaultToggle,
	jsonText,
	numberFromText,
	stateFor,
} from './config-settings-model.js'
import { SettingsConfirmDialog } from './settings-confirm-dialog.js'
import { Row, Switch } from './settings-row.js'
import { Button } from './ui/button.js'
import type { ConfigSettingsControls } from './use-config-settings.js'

/** Every engine setting that belongs to `section`, drawn from the engine's own description. */
export function ConfigSettingsGroup({
	section,
	config,
	heading,
}: {
	section: SettingsSection
	config: ConfigSettingsControls
	/** A line above the group, when the section has nothing else on the page. */
	heading?: string
}) {
	const rows = configSettingsFor(config.view, section)
	if (config.loadError && section === 'agent')
		return (
			<p role="alert" className="settings-error">
				{config.loadError}
			</p>
		)
	if (!config.view || rows.length === 0) return null
	return (
		<>
			{heading && <h2 className="settings-section-title">{heading}</h2>}
			{config.confirmation && (
				<SettingsConfirmDialog
					onConfirm={config.confirm}
					onCancel={config.dismiss}
					copy={confirmationCopy(config.confirmation.message)}
				/>
			)}
			{rows.map((descriptor) => (
				<ConfigRow
					key={descriptor.path}
					descriptor={descriptor}
					view={config.view as ConfigSettingsView}
					config={config}
				/>
			))}
		</>
	)
}

function ConfigRow({
	descriptor,
	view,
	config,
}: {
	descriptor: ConfigSettingDescriptor
	view: ConfigSettingsView
	config: ConfigSettingsControls
}) {
	const state = stateFor(view, descriptor.path)
	const error = config.errors[descriptor.path]
	const note = [descriptor.description, state?.set ? '' : defaultNote(descriptor)]
		.filter(Boolean)
		.join(' ')
	const reset =
		state?.set && descriptor.control.kind !== 'file-only' ? (
			<Button
				variant="ghost-muted"
				size="xs"
				onClick={() => void config.change(descriptor.path)}
				aria-label={`Use the default for ${descriptor.label}`}
			>
				Use default
			</Button>
		) : null
	const stacked = descriptor.control.kind === 'json' || descriptor.control.kind === 'checks'
	return (
		<Row
			id={configSettingId(descriptor.path)}
			label={descriptor.label}
			description={note}
			stacked={stacked}
		>
			<div className="settings-config-control">
				<Control
					descriptor={descriptor}
					value={state?.value}
					set={state?.set ?? false}
					config={config}
				/>
				{reset}
				{error && (
					<p role="alert" className="settings-error settings-config-error">
						{error}
					</p>
				)}
			</div>
		</Row>
	)
}

function Control({
	descriptor,
	value,
	set,
	config,
}: {
	descriptor: ConfigSettingDescriptor
	value: unknown
	set: boolean
	config: ConfigSettingsControls
}) {
	const control = descriptor.control
	switch (control.kind) {
		case 'toggle':
			return (
				<Switch
					label={descriptor.label}
					checked={set ? value === true : defaultToggle(descriptor)}
					onChange={(next) => void config.change(descriptor.path, next)}
				/>
			)
		case 'select':
			return (
				<select
					className="settings-config-input"
					aria-label={descriptor.label}
					value={set && typeof value === 'string' ? value : ''}
					onChange={(event) =>
						void config.change(
							descriptor.path,
							event.target.value === '' ? undefined : event.target.value,
						)
					}
				>
					<option value="">Default</option>
					{control.options.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
			)
		case 'checks':
			return (
				<Checks descriptor={descriptor} options={control.options} value={value} config={config} />
			)
		case 'number':
			return <NumberInput descriptor={descriptor} control={control} value={value} config={config} />
		case 'text':
			return (
				<TextInput
					descriptor={descriptor}
					placeholder={control.placeholder}
					value={value}
					config={config}
				/>
			)
		case 'json':
			return (
				<JsonEditor
					descriptor={descriptor}
					example={control.example}
					value={value}
					config={config}
				/>
			)
		case 'file-only':
			return <span className="settings-value">{set ? 'Set in your config file' : 'Not set'}</span>
	}
}

function Checks({
	descriptor,
	options,
	value,
	config,
}: {
	descriptor: ConfigSettingDescriptor
	options: { value: string; label: string }[]
	value: unknown
	config: ConfigSettingsControls
}) {
	const current = Array.isArray(value) ? (value as string[]) : []
	return (
		<fieldset className="settings-choices settings-choices-inline">
			<legend className="sr-only">{descriptor.label}</legend>
			{options.map((option) => (
				<label key={option.value} className="settings-choice">
					<input
						type="checkbox"
						checked={current.includes(option.value)}
						onChange={(event) => {
							const next = event.target.checked
								? [...current, option.value]
								: current.filter((item) => item !== option.value)
							void config.change(descriptor.path, next)
						}}
					/>
					<span className="settings-choice-label">{option.label}</span>
				</label>
			))}
		</fieldset>
	)
}

function NumberInput({
	descriptor,
	control,
	value,
	config,
}: {
	descriptor: ConfigSettingDescriptor
	control: { min?: number; max?: number; unit?: string }
	value: unknown
	config: ConfigSettingsControls
}) {
	const id = useId()
	const saved = typeof value === 'number' ? String(value) : ''
	const [draft, setDraft] = useState<string>()
	const [local, setLocal] = useState('')
	const text = draft ?? saved
	const commit = async () => {
		if (draft === undefined || draft === saved) return setDraft(undefined)
		const parsed = numberFromText(draft, control)
		if ('error' in parsed) return setLocal(parsed.error)
		setLocal('')
		if (await config.change(descriptor.path, parsed.value)) setDraft(undefined)
	}
	return (
		<span className="settings-config-field">
			<input
				id={id}
				type="number"
				inputMode="numeric"
				className="settings-config-input"
				aria-label={descriptor.label}
				value={text}
				placeholder={descriptor.defaultText ?? ''}
				min={control.min}
				max={control.max}
				onChange={(event) => setDraft(event.target.value)}
				onBlur={() => void commit()}
				onKeyDown={(event) => {
					if (event.key === 'Enter') void commit()
				}}
			/>
			{control.unit && <span className="settings-config-unit">{control.unit}</span>}
			{local && (
				<span role="alert" className="settings-error settings-config-error">
					{local}
				</span>
			)}
		</span>
	)
}

function TextInput({
	descriptor,
	placeholder,
	value,
	config,
}: {
	descriptor: ConfigSettingDescriptor
	placeholder?: string
	value: unknown
	config: ConfigSettingsControls
}) {
	const saved = typeof value === 'string' ? value : ''
	const [draft, setDraft] = useState<string>()
	const commit = async () => {
		if (draft === undefined || draft === saved) return setDraft(undefined)
		const ok = await config.change(descriptor.path, draft.trim() === '' ? undefined : draft)
		if (ok) setDraft(undefined)
	}
	return (
		<input
			type="text"
			className="settings-config-input settings-config-wide"
			aria-label={descriptor.label}
			value={draft ?? saved}
			placeholder={placeholder ?? ''}
			spellCheck={false}
			onChange={(event) => setDraft(event.target.value)}
			onBlur={() => void commit()}
			onKeyDown={(event) => {
				if (event.key === 'Enter') void commit()
			}}
		/>
	)
}

function JsonEditor({
	descriptor,
	example,
	value,
	config,
}: {
	descriptor: ConfigSettingDescriptor
	example: string
	value: unknown
	config: ConfigSettingsControls
}) {
	const saved = jsonText(value)
	const [draft, setDraft] = useState<string>()
	const text = draft ?? saved
	const dirty = draft !== undefined && draft !== saved
	return (
		<div className="settings-config-json">
			<textarea
				className="settings-config-input settings-config-area"
				aria-label={descriptor.label}
				value={text}
				rows={Math.min(12, Math.max(3, text.split('\n').length))}
				placeholder={`For example: ${example}`}
				spellCheck={false}
				onChange={(event) => setDraft(event.target.value)}
			/>
			<span>
				<Button
					variant="outline"
					size="sm"
					disabled={!dirty}
					onClick={async () => {
						if (draft === undefined) return
						const ok = await config.change(descriptor.path, draft.trim() === '' ? undefined : draft)
						if (ok) setDraft(undefined)
					}}
				>
					Save
				</Button>
				{dirty && (
					<Button variant="ghost-muted" size="sm" onClick={() => setDraft(undefined)}>
						Discard
					</Button>
				)}
			</span>
		</div>
	)
}
