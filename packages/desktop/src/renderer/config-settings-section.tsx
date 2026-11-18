import { Fragment, type ReactNode, useId, useState } from 'react'
import type {
	ConfigSettingDescriptor,
	ConfigSettingsView,
} from '../shared/config-settings-protocol.js'
import { environmentNote, layerNote } from '../shared/config-settings-values.js'
import type { SettingsSection } from '../shared/settings-protocol.js'
import {
	AutoModeEditor,
	EventSwitch,
	KeyPicker,
	LevelsEditor,
	ListSwitch,
	ManyChecks,
	ModelSetting,
	PermissionChecksEditor,
	PermissionRulesEditor,
	RoutingEditor,
	ScreensEditor,
	SitesEditor,
	WordList,
} from './config-settings-lists.js'
import {
	configRowRuns,
	configSettingId,
	configSettingsFor,
	confirmationCopy,
	defaultHelper,
	defaultLabel,
	defaultToggle,
	displayNumber,
	effectiveDefault,
	jsonText,
	numberFromText,
	numberPlaceholder,
	rangeText,
	requirementNote,
	restartBadge,
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
	fallbackHeading,
	omit,
	lead,
	after,
}: {
	section: SettingsSection
	config: ConfigSettingsControls
	/** A line above the group, when the section has nothing else on the page. */
	heading?: string
	/**
	 * The heading to draw over the engine's rows when the engine names no group (an older engine),
	 * so they do not run on from the app's own rows above them.
	 */
	fallbackHeading?: string
	/** Settings the page shows another way. */
	omit?: readonly string[]
	/**
	 * Rows the app draws itself that belong under one of the engine's own headings: they are drawn
	 * first under it, so the heading is said once. Without such a heading they get their own.
	 */
	lead?: { heading: string; rows: ReactNode }
	/**
	 * Rows the app draws itself that belong with one of the engine's headings but under a heading of
	 * their own: drawn right after the engine's rows of `heading`, or first when it names none.
	 */
	after?: { heading: string; title: string; rows: ReactNode }
}) {
	const rows = configSettingsFor(config.view, section).filter(
		(descriptor) => !omit?.includes(descriptor.path),
	)
	const runs = config.view && rows.length > 0 ? configRowRuns(rows) : []
	const joins = lead !== undefined && runs.some((run) => run.heading === lead.heading)
	// The app's own rows are drawn at once when there is no engine heading of that name to join.
	const afterFits = after !== undefined && runs.some((run) => run.heading === after.heading)
	const afterRows = after ? (
		<>
			<h2 className="settings-section-title">{after.title}</h2>
			{after.rows}
		</>
	) : null
	const own =
		(lead && !joins) || (after && !afterFits) ? (
			<>
				{lead && !joins && (
					<>
						<h2 className="settings-section-title">{lead.heading}</h2>
						{lead.rows}
					</>
				)}
				{after && !afterFits && afterRows}
			</>
		) : null
	// Every page with engine rows says when the list could not be read or is still being read.
	if (config.loadError)
		return (
			<div className="settings-config-state">
				{own}
				<p role="alert" className="settings-error">
					{config.loadError}
				</p>
				<Button variant="outline" size="sm" onClick={config.reload}>
					Try again
				</Button>
			</div>
		)
	if (config.loading)
		return (
			<>
				{own}
				<p className="settings-note">Reading your settings…</p>
			</>
		)
	if (!config.view || rows.length === 0) return own
	return (
		<>
			{own}
			{heading && !rows.some((row) => row.group) && (
				<h2 className="settings-section-title">{heading}</h2>
			)}
			{config.confirmation && (
				<SettingsConfirmDialog
					onConfirm={config.confirm}
					onCancel={config.dismiss}
					copy={confirmationCopy(config.confirmation.message)}
				/>
			)}
			{runs.map((run) => {
				const title = run.heading ?? (rows.some((row) => row.group) ? undefined : fallbackHeading)
				return (
					<Fragment key={title ?? ''}>
						{title && <h2 className="settings-section-title">{title}</h2>}
						{lead && joins && run.heading === lead.heading && lead.rows}
						{run.rows.map((descriptor) => (
							<ConfigRow
								key={descriptor.path}
								descriptor={descriptor}
								view={config.view as ConfigSettingsView}
								config={config}
							/>
						))}
						{after && afterFits && run.heading === after.heading && afterRows}
					</Fragment>
				)
			})}
		</>
	)
}

const STACKED_KINDS: readonly string[] = [
	'json',
	'checks',
	'toggle-checks',
	'levels',
	'screens',
	'list',
	'routing',
	'auto-mode',
	'permission-rules',
	'permission-checks',
	'sites',
]

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
	const control = descriptor.control
	// A layer other than the user's file decides the value: the row shows that value, read-only.
	const locked =
		state?.effective !== undefined &&
		(state.layer === 'project' ||
			state.layer === 'local' ||
			state.layer === 'managed' ||
			state.layer === 'env')
	const shownSet = locked ? true : (state?.set ?? false)
	const shownValue = locked ? state?.effective : state?.value
	const chosen = locked
		? state?.effective
		: state?.set
			? state.value
			: effectiveDefault(descriptor, view)
	const optionHelp =
		control.kind === 'select' ? control.options.find((o) => o.value === chosen)?.help : undefined
	const meta = [
		optionHelp,
		control.kind === 'number' ? rangeText(control) : '',
		state?.set || locked ? '' : defaultHelper(descriptor, view),
		requirementNote(descriptor, view),
		state?.layer && state.layer !== 'user' && state.env?.value !== ''
			? layerNote(state.layer, state.env, state.set)
			: state?.env
				? environmentNote(state.env)
				: '',
		control.kind === 'file-only' && view.file ? `Config file: ${view.file}.` : '',
	]
		.filter(Boolean)
		.join(' ')
	const lockedByLayer = Boolean(state?.layer && state.layer !== 'user')
	const reset =
		state?.set && descriptor.control.kind !== 'file-only' ? (
			<Button
				variant="ghost-muted"
				size="xs"
				// The button must not take the focus from a field first: leaving a field saves what is
				// typed in it, which is the opposite of asking for the default.
				onMouseDown={(event) => event.preventDefault()}
				onClick={() => {
					config.discard(descriptor.path)
					void config.change(descriptor.path)
				}}
				aria-label={
					lockedByLayer
						? `Remove your saved value for ${descriptor.label}`
						: `Use the default for ${descriptor.label}`
				}
				title={
					!lockedByLayer && defaultLabel(descriptor, view)
						? `Default · ${defaultLabel(descriptor, view)}`
						: undefined
				}
			>
				{lockedByLayer ? 'Remove my saved value' : 'Use default'}
			</Button>
		) : null
	const stacked = STACKED_KINDS.includes(descriptor.control.kind)
	return (
		<Row
			id={configSettingId(descriptor.path)}
			label={descriptor.label}
			description={descriptor.description}
			meta={meta}
			badge={restartBadge(descriptor)}
			stacked={stacked}
		>
			<div className="settings-config-control">
				{/* A disabled fieldset turns off every field and button inside it, whatever the control. */}
				<fieldset disabled={locked} className="settings-config-locked">
					<Control
						key={config.resets[descriptor.path] ?? 0}
						descriptor={descriptor}
						value={shownValue}
						set={shownSet}
						view={view}
						config={config}
					/>
				</fieldset>
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
	view,
	config,
}: {
	descriptor: ConfigSettingDescriptor
	value: unknown
	set: boolean
	view: ConfigSettingsView
	config: ConfigSettingsControls
}) {
	const control = descriptor.control
	switch (control.kind) {
		case 'toggle':
			return (
				<Switch
					label={descriptor.label}
					checked={set ? value === true : defaultToggle(descriptor, view)}
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
					<option value="">
						{defaultLabel(descriptor, view)
							? `Default · ${defaultLabel(descriptor, view)}`
							: 'Default'}
					</option>
					{control.options.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
			)
		case 'toggle-checks':
			return (
				<EventSwitch
					descriptor={descriptor}
					control={control}
					value={set ? value : effectiveDefault(descriptor, view)}
					config={config}
				/>
			)
		case 'toggle-list':
			return (
				<ListSwitch
					descriptor={descriptor}
					control={control}
					value={set ? value : effectiveDefault(descriptor, view)}
					config={config}
				/>
			)
		case 'key':
			return (
				<KeyPicker
					descriptor={descriptor}
					control={control}
					value={value}
					set={set}
					defaultText={defaultLabel(descriptor, view)}
					config={config}
				/>
			)
		case 'levels':
			return (
				<LevelsEditor
					descriptor={descriptor}
					control={control}
					value={set ? value : undefined}
					config={config}
				/>
			)
		case 'screens':
			return (
				<ScreensEditor
					descriptor={descriptor}
					control={control}
					value={value}
					set={set}
					config={config}
				/>
			)
		case 'list':
			return <WordList descriptor={descriptor} control={control} value={value} config={config} />
		case 'checks':
			if (control.allLabel)
				return (
					<ManyChecks
						descriptor={descriptor}
						control={control}
						value={set ? value : effectiveDefault(descriptor, view)}
						config={config}
					/>
				)
			return (
				<Checks
					descriptor={descriptor}
					options={control.options}
					value={set ? value : effectiveDefault(descriptor, view)}
					config={config}
				/>
			)
		case 'number':
			return <NumberInput descriptor={descriptor} control={control} value={value} config={config} />
		case 'text':
			return (
				<TextInput
					descriptor={descriptor}
					placeholder={control.placeholder}
					folderPicker={control.picker === 'folder'}
					value={value}
					config={config}
				/>
			)
		case 'model':
			return (
				<ModelSetting descriptor={descriptor} control={control} value={value} config={config} />
			)
		case 'routing':
			return <RoutingEditor descriptor={descriptor} value={value} config={config} />
		case 'auto-mode':
			return (
				<AutoModeEditor descriptor={descriptor} control={control} value={value} config={config} />
			)
		case 'permission-rules':
			return (
				<PermissionRulesEditor
					descriptor={descriptor}
					control={control}
					value={value}
					config={config}
				/>
			)
		case 'permission-checks':
			return (
				<PermissionChecksEditor
					descriptor={descriptor}
					control={control}
					value={value}
					config={config}
				/>
			)
		case 'sites':
			return <SitesEditor descriptor={descriptor} control={control} value={value} config={config} />
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
	const saved = typeof value === 'number' ? displayNumber(value, control.unit) : ''
	const typed = control.unit === 'ms' || control.unit === 'tokens'
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
				type={typed ? 'text' : 'number'}
				inputMode={typed ? 'text' : 'numeric'}
				className="settings-config-input settings-config-number"
				aria-label={descriptor.label}
				value={text}
				placeholder={numberPlaceholder(descriptor)}
				spellCheck={false}
				min={typed ? undefined : control.min}
				max={typed ? undefined : control.max}
				onChange={(event) => setDraft(event.target.value)}
				onBlur={() => void commit()}
				onKeyDown={(event) => {
					if (event.key === 'Enter') void commit()
				}}
			/>
			{control.unit && control.unit !== 'ms' && (
				<span className="settings-config-unit">{control.unit}</span>
			)}
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
	folderPicker,
	value,
	config,
}: {
	descriptor: ConfigSettingDescriptor
	placeholder?: string
	/** A button beside the box chooses a folder with the system picker. */
	folderPicker?: boolean
	value: unknown
	config: ConfigSettingsControls
}) {
	const saved = typeof value === 'string' ? value : ''
	const [draft, setDraft] = useState<string>()
	const [pickError, setPickError] = useState('')
	const pick = folderPicker ? config.tools?.pickFolder : undefined
	const commit = async () => {
		if (draft === undefined || draft === saved) return setDraft(undefined)
		const ok = await config.change(descriptor.path, draft.trim() === '' ? undefined : draft)
		if (ok) setDraft(undefined)
	}
	const box = (
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
	if (!pick) return box
	return (
		<>
			{box}
			<Button
				variant="outline"
				size="sm"
				aria-label={`Choose folder for ${descriptor.label}`}
				onClick={() => {
					setPickError('')
					pick().then(
						(picked) => {
							if (picked) void config.change(descriptor.path, picked)
						},
						() => setPickError('The folder picker did not open.'),
					)
				}}
			>
				Choose folder
			</Button>
			{pickError && (
				<p role="alert" className="settings-error settings-config-error">
					{pickError}
				</p>
			)}
		</>
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
