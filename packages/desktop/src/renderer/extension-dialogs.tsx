import { Dialog } from '@base-ui/react/dialog'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
	type ExtensionDisclosure,
	type ExtensionFailure,
	type ExtensionNotice,
	type ExtensionRow,
	readNotice,
} from '../shared/extensions-view.js'
import type { DesktopApi } from '../shared/protocol.js'
import {
	EVENT_HISTORY_SENTENCE,
	EVENT_HISTORY_TITLE,
	auditWords,
	failureWords,
	formatWhen,
	keptWords,
	languageName,
	licenceLines,
	noticeBlocks,
	plainReason,
	reachedEnd,
} from './extensions-model.js'
import { ask, refreshExtensions, useAudit } from './extensions-store.js'
import { Button } from './ui/button.js'
import './extension-dialogs.css'

export type Api = Pick<DesktopApi, 'extensionsCall' | 'extensionsAddFromFile' | 'onEvent'>

/** The dialogs one extension's screen can open; one at a time. */
export type Panel =
	| {
			kind: 'install'
			id: string
			disclosure: ExtensionDisclosure
			update?: { waiting: boolean; reasons: string[] }
	  }
	| { kind: 'notice'; id: string; staged: boolean }
	| { kind: 'record'; id: string }
	| { kind: 'collected'; id: string }
	| { kind: 'admin'; id: string; action: AdminAction }
	| { kind: 'licence'; id: string }
	| { kind: 'key'; id: string }
	| { kind: 'log'; id: string }
	| { kind: 'remove'; id: string }

/** What the administrator password is asked for: each is one way off, or the unlock itself. */
export type AdminAction = 'enable' | 'disable' | 'unlock' | 'background-off'

export const MIN_ADMIN_PASSWORD = 8

/** One password box; the lock's own words, no technical word. */
export function AdminField({
	value,
	onChange,
	label = 'Administrator password',
}: { value: string; onChange: (v: string) => void; label?: string }) {
	return (
		<label className="extension-label extension-admin-field">
			{label}
			<input
				className="extension-input"
				type="password"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				autoComplete="off"
				spellCheck={false}
			/>
		</label>
	)
}

const ADMIN_WORDS: Record<AdminAction, { title: (n: string) => string; body: string; go: string }> =
	{
		enable: {
			title: (n) => `Turn on ${n}`,
			body: 'Set an administrator password. Only the person who knows it can turn this off or remove it afterwards.',
			go: 'Set the password and turn it on',
		},
		disable: {
			title: (n) => `Turn off ${n}`,
			body: 'Your administrator locked this. Enter the administrator password to turn it off.',
			go: 'Turn it off',
		},
		unlock: {
			title: () => 'Unlock',
			body: 'Enter the administrator password to take the lock off. After that anyone can turn it off.',
			go: 'Unlock',
		},
		'background-off': {
			title: () => 'Stop starting at sign-in',
			body: 'Your administrator locked this. Enter the administrator password to stop it starting when you sign in.',
			go: 'Stop it starting',
		},
	}

/** Asks for the administrator password (twice when it is being set) and runs the one operation with it. */
export function AdminDialog({
	api,
	row,
	action,
	onClose,
}: { api: Api; row: ExtensionRow; action: AdminAction; onClose: () => void }) {
	const [first, setFirst] = useState('')
	const [again, setAgain] = useState('')
	const [busy, setBusy] = useState(false)
	const [failure, setFailure] = useState<ExtensionFailure | string>()
	const setting = action === 'enable'
	const words = ADMIN_WORDS[action]
	const problem = setting
		? first.length < MIN_ADMIN_PASSWORD
			? `Use at least ${MIN_ADMIN_PASSWORD} characters.`
			: first !== again && again !== ''
				? 'The two passwords are not the same.'
				: undefined
		: undefined
	const ready = setting ? first.length >= MIN_ADMIN_PASSWORD && first === again : first.length > 0
	const method = {
		enable: 'namzu/extensions/enable',
		disable: 'namzu/extensions/disable',
		unlock: 'namzu/extensions/unlock',
		'background-off': 'namzu/extensions/background/set',
	}[action]
	const go = async () => {
		setBusy(true)
		setFailure(undefined)
		try {
			const r = await ask(api, method, {
				id: row.id,
				admin: first,
				...(action === 'background-off' ? { on: false } : {}),
			})
			if (!r.ok) {
				setFailure(r.failure)
				return
			}
			if (r.value === null) {
				setFailure('This version of Namzu could not perform the operation.')
				return
			}
			await refreshExtensions(api)
			onClose()
		} catch {
			setFailure('Namzu could not complete the operation. Try again.')
		} finally {
			setFirst('')
			setAgain('')
			setBusy(false)
		}
	}
	return (
		<Dialog.Root open onOpenChange={(open) => !open && !busy && onClose()}>
			<Dialog.Portal>
				<Dialog.Backdrop className="dialog-scrim" />
				<Dialog.Viewport className="dialog-viewport">
					<Dialog.Popup className="dialog-popup" data-dialog-size="confirm">
						<Dialog.Title className="dialog-title">{words.title(row.name)}</Dialog.Title>
						<Dialog.Description className="dialog-body">{words.body}</Dialog.Description>
						<AdminField value={first} onChange={setFirst} />
						{setting && <AdminField value={again} onChange={setAgain} label="Type it again" />}
						{problem && first !== '' && <p className="extension-admin-note">{problem}</p>}
						<Failure failure={failure} />
						<div className="dialog-actions">
							<Button variant="outline" disabled={busy} onClick={onClose}>
								Cancel
							</Button>
							<Button disabled={busy || !ready} onClick={() => void go()}>
								{words.go}
							</Button>
						</div>
					</Dialog.Popup>
				</Dialog.Viewport>
			</Dialog.Portal>
		</Dialog.Root>
	)
}

export function Failure({ failure }: { failure: ExtensionFailure | string | undefined }) {
	if (!failure) return null
	return (
		<p role="alert" className="extension-failure">
			{typeof failure === 'string' ? failure : failureWords(failure)}
		</p>
	)
}

function Permissions({ d }: { d: ExtensionDisclosure }) {
	return (
		<ul className="extension-permissions">
			{d.permissions.map((p) => (
				<li key={p.id} data-level={p.level}>
					<p className="extension-permission-head">
						<span>{p.summary}</span>
						{p.optional && <span className="extension-optional"> Optional, asked for later.</span>}
					</p>
					{p.purposes.map((u) => (
						<p key={u} className="extension-purpose">
							<strong>Why: </strong>
							{u}
						</p>
					))}
				</li>
			))}
		</ul>
	)
}

function Disclosure({ d }: { d: ExtensionDisclosure }) {
	return (
		<div className="extension-disclosure">
			<p className="extension-publisher">
				{d.publisher.name} · {d.publisher.contact}
			</p>
			{d.languageNote && <p className="extension-language-note">{d.languageNote}</p>}
			<h3>It asks for</h3>
			<Permissions d={d} />
			<p>{d.network}</p>
			{d.background && (
				<>
					<p>{d.background.line}</p>
					<p>{d.background.whileClosed}</p>
				</>
			)}
			{d.pages && <p>{d.pages}</p>}
			{d.management && (
				<>
					<p>
						<strong>{d.management.line}</strong>
					</p>
					{d.management.purpose && <p>{d.management.purpose}</p>}
				</>
			)}
			<p>
				It keeps data on this computer: {d.storage.where} {d.storage.encryption}{' '}
				{d.storage.adminCanRead ? (
					<strong>An administrator of this computer can get around this protection.</strong>
				) : null}
			</p>
			<p className="extension-folder">Data folder: {d.dataFolder}</p>
			<h3>What it keeps</h3>
			<ul>
				{d.dataKinds.map((k) => (
					<li key={k.id}>
						{k.description} {keptWords(k.retentionDays)}{' '}
						<span className="extension-fields">({k.fields.map((f) => f.name).join(', ')})</span>
					</li>
				))}
			</ul>
			{d.doesNotCollect.length > 0 && (
				<>
					<h3>It does not collect</h3>
					<ul>
						{d.doesNotCollect.map((t) => (
							<li key={t}>{t}</li>
						))}
					</ul>
				</>
			)}
			{d.doesNotDo.length > 0 && (
				<>
					<h3>It does not</h3>
					<ul>
						{d.doesNotDo.map((t) => (
							<li key={t}>{t}</li>
						))}
					</ul>
				</>
			)}
			<p>{d.leavesTheMachine}</p>
			<p>{d.licence || `Licence needed: ${d.licenseRequired ? 'yes' : 'no'}.`}</p>
		</div>
	)
}

export function InstallDialog({
	api,
	panel,
	onClose,
	onNext,
}: {
	api: Api
	panel: Extract<Panel, { kind: 'install' }>
	onClose: () => void
	onNext: (p: Panel) => void
}) {
	const [busy, setBusy] = useState(false)
	const cancel = async () => {
		setBusy(true)
		// Cancel removes what was just added; an update that was staged stays staged only if it was an update.
		if (!panel.update) await ask(api, 'namzu/extensions/remove', { id: panel.id, deleteData: true })
		await refreshExtensions(api)
		onClose()
	}
	return (
		<Dialog.Root open onOpenChange={(open) => !open && !busy && void cancel()}>
			<Dialog.Portal>
				<Dialog.Backdrop className="dialog-scrim" />
				<Dialog.Viewport className="dialog-viewport">
					<Dialog.Popup className="dialog-popup extension-dialog" data-extension-dialog="install">
						<Dialog.Title className="dialog-title">{panel.disclosure.name}</Dialog.Title>
						<Dialog.Description className="dialog-body">
							This is everything it asks for, taken from the file itself. Nothing is running yet.
						</Dialog.Description>
						<div className="extension-dialog-scroll">
							<Disclosure d={panel.disclosure} />
							{panel.update?.waiting && (
								<>
									<h3>This update asks for more</h3>
									<ul>
										{panel.update.reasons.map((r) => (
											<li key={r}>{plainReason(r, panel.disclosure)}</li>
										))}
									</ul>
								</>
							)}
						</div>
						<div className="dialog-actions">
							<Button variant="outline" disabled={busy} onClick={() => void cancel()}>
								Cancel
							</Button>
							<Button
								disabled={busy}
								onClick={() => {
									onClose()
									if (panel.update?.waiting) onNext({ kind: 'notice', id: panel.id, staged: true })
								}}
							>
								Continue
							</Button>
						</div>
					</Dialog.Popup>
				</Dialog.Viewport>
			</Dialog.Portal>
		</Dialog.Root>
	)
}

/** The full-window screen before it starts: read it, then acknowledge exactly what was shown. */
export function NoticeScreen({
	api,
	id,
	staged,
	setPassword,
	onClose,
}: {
	api: Api
	id: string
	staged: boolean
	/** The extension is locked by an administrator and no password is set yet: this screen sets it. */
	setPassword?: boolean
	onClose: (enabled: boolean) => void
}) {
	const [notice, setNotice] = useState<ExtensionNotice>()
	const [failure, setFailure] = useState<ExtensionFailure | string>()
	const [atEnd, setAtEnd] = useState(false)
	const [busy, setBusy] = useState(false)
	// The switch the person sees before acknowledging; its start is the manifest's own default.
	const [startAtSignin, setStartAtSignin] = useState<boolean>()
	const [admin, setAdmin] = useState('')
	const [adminAgain, setAdminAgain] = useState('')
	const needsPassword = setPassword === true && notice?.disclosure.management !== undefined
	const passwordOk = !needsPassword || (admin.length >= MIN_ADMIN_PASSWORD && admin === adminAgain)
	const box = useRef<HTMLDivElement>(null)
	useEffect(() => {
		let live = true
		void ask(api, 'namzu/extensions/notice', { id, staged }).then((r) => {
			if (!live) return
			const n = r.ok ? readNotice(r.value) : undefined
			if (n) {
				setNotice(n)
				setStartAtSignin(n.disclosure.background?.defaultOn)
			} else setFailure(r.failure ?? 'Namzu answered the notice in a way this app cannot read.')
		})
		return () => {
			live = false
		}
	}, [api, id, staged])
	const check = useCallback(() => {
		const el = box.current
		if (el) setAtEnd(reachedEnd(el.scrollTop, el.clientHeight, el.scrollHeight))
	}, [])
	// Text that fits without scrolling counts as read.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the notice arriving is what is measured
	useEffect(check, [notice])
	const acknowledge = async () => {
		if (!notice) return
		setBusy(true)
		const r = await ask(api, 'namzu/extensions/acknowledge', {
			id,
			noticeVersion: notice.noticeVersion,
			scopeHash: notice.scopeHash,
			locale: notice.locale,
			staged,
			...(notice.disclosure.background && startAtSignin !== undefined ? { startAtSignin } : {}),
			...(needsPassword ? { admin } : {}),
		})
		if (!r.ok) {
			setFailure(r.failure)
			setBusy(false)
			return
		}
		const enabled = await ask(api, 'namzu/extensions/enable', {
			id,
			...(needsPassword ? { admin } : {}),
		})
		await refreshExtensions(api)
		setBusy(false)
		if (!enabled.ok) setFailure(enabled.failure)
		else onClose(true)
	}
	return (
		<Dialog.Root open onOpenChange={(open) => !open && !busy && onClose(false)}>
			<Dialog.Portal>
				<Dialog.Popup className="extension-notice-screen" aria-label="Notice">
					<div className="extension-notice-inner">
						<h1>Read this before it starts</h1>
						{notice ? (
							<>
								<p className="extension-notice-sub">
									{notice.disclosure.name} {notice.disclosure.version}
									{staged ? ' (an update that asks for more)' : ''}
								</p>
								{notice.languageNote && (
									<p className="extension-language-note">{notice.languageNote}</p>
								)}
								{notice.diff && notice.diff.length > 0 && (
									<div className="extension-diff">
										<strong>It now also asks:</strong>
										<ul>
											{notice.diff.map((d) => (
												<li key={d}>{plainReason(d, notice.disclosure)}</li>
											))}
										</ul>
									</div>
								)}
								{/* A scrolling region has to take focus, or the keyboard cannot scroll to the end it must reach. */}
								{/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be focusable */}
								<div className="extension-notice-text" ref={box} onScroll={check} tabIndex={0}>
									{noticeBlocks(notice.text).map((b) =>
										b.kind === 'h' ? (
											<h2 key={b.id}>{b.text}</h2>
										) : b.kind === 'li' ? (
											<p key={b.id} className="extension-notice-li">
												• {b.text}
											</p>
										) : (
											<p key={b.id}>{b.text}</p>
										),
									)}
									<h2>What it asks for</h2>
									<Permissions d={notice.disclosure} />
								</div>
								<p className="extension-notice-hint">
									This is shown once. It is shown again only if the extension asks for more or this
									notice changes. You can read it again, and see when you acknowledged it, at any
									time.
								</p>
							</>
						) : (
							!failure && <p>Reading the notice…</p>
						)}
						{notice?.disclosure.background && (
							<label className="extension-signin-switch">
								<input
									type="checkbox"
									checked={startAtSignin === true}
									onChange={(e) => setStartAtSignin(e.target.checked)}
								/>
								<span>
									<strong>Start when I sign in</strong>
									<span>{notice.disclosure.background.line}</span>
									<span>{notice.disclosure.background.whileClosed}</span>
								</span>
							</label>
						)}
						{needsPassword && (
							<div className="extension-admin-set">
								<p>
									<strong>Set the administrator password.</strong> Only the person who knows it can
									turn this off or remove it afterwards.
								</p>
								<AdminField value={admin} onChange={setAdmin} />
								<AdminField value={adminAgain} onChange={setAdminAgain} label="Type it again" />
								{admin !== '' && !passwordOk && (
									<p className="extension-admin-note">
										{admin.length < MIN_ADMIN_PASSWORD
											? `Use at least ${MIN_ADMIN_PASSWORD} characters.`
											: 'The two passwords are not the same.'}
									</p>
								)}
							</div>
						)}
						<Failure failure={failure} />
						<div className="extension-notice-actions">
							<Button variant="outline" onClick={() => onClose(false)} disabled={busy}>
								Not now
							</Button>
							<Button
								onClick={() => void acknowledge()}
								disabled={!notice || !atEnd || busy || !passwordOk}
								title={atEnd ? undefined : 'Read to the end first'}
							>
								I have read this
							</Button>
						</div>
					</div>
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	)
}

export function Shell({
	title,
	onClose,
	children,
	wide,
}: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
	return (
		<Dialog.Root open onOpenChange={(open) => !open && onClose()}>
			<Dialog.Portal>
				<Dialog.Backdrop className="dialog-scrim" />
				<Dialog.Viewport className="dialog-viewport">
					<Dialog.Popup className="dialog-popup extension-dialog" data-wide={wide || undefined}>
						<Dialog.Title className="dialog-title">{title}</Dialog.Title>
						<div className="extension-dialog-scroll">{children}</div>
						<div className="dialog-actions">
							<Button variant="outline" onClick={onClose}>
								Close
							</Button>
						</div>
					</Dialog.Popup>
				</Dialog.Viewport>
			</Dialog.Portal>
		</Dialog.Root>
	)
}

export function MyRecord({
	api,
	row,
	onClose,
	onReread,
}: { api: Api; row: ExtensionRow; onClose: () => void; onReread: () => void }) {
	const [notice, setNotice] = useState<ExtensionNotice>()
	useEffect(() => {
		let live = true
		void ask(api, 'namzu/extensions/notice', { id: row.id }).then((r) => {
			if (live && r.ok) setNotice(readNotice(r.value) ?? undefined)
		})
		return () => {
			live = false
		}
	}, [api, row.id])
	return (
		<Shell title="My record" onClose={onClose}>
			{row.record ? (
				<>
					<p>
						You acknowledged the notice on <strong>{formatWhen(row.record.acknowledgedAt)}</strong>.
					</p>
					<p>
						Notice version {row.record.noticeVersion}, read in {languageName(row.record.locale)}.
					</p>
					{notice && (
						<>
							<h3>What you acknowledged</h3>
							<Permissions d={notice.disclosure} />
						</>
					)}
					<Button variant="outline" onClick={onReread}>
						Read the notice again
					</Button>
				</>
			) : (
				<p>
					You have not acknowledged the notice yet. It is shown the first time you enable this
					extension.
				</p>
			)}
		</Shell>
	)
}

/** Read-only: what is collected, drawn from the manifest and the live counts; nothing here changes anything. */
export function LicenceDialog({
	api,
	row,
	onClose,
}: { api: Api; row: ExtensionRow; onClose: () => void }) {
	const [token, setToken] = useState('')
	const [admin, setAdmin] = useState('')
	const locked = row.management?.locked === true
	const adminPart = locked && admin ? { admin } : {}
	const [failure, setFailure] = useState<ExtensionFailure | string>()
	const [done, setDone] = useState<{ customer: string; seats: number; expires: string }>()
	const service = row.licenceKind === 'service'
	const act = async (action: 'check' | 'release') => {
		setFailure(undefined)
		const r = await ask(api, 'namzu/extensions/license', { id: row.id, action, ...adminPart })
		if (!r.ok) return setFailure(r.failure)
		const v = r.value as { ok?: boolean; message?: string }
		if (v.ok === false) setFailure(v.message ?? 'The licence service could not be reached.')
		await refreshExtensions(api)
	}
	const save = async () => {
		// A key for the publisher's service goes in and is never shown again; a key file is checked here.
		const r = await ask(
			api,
			'namzu/extensions/license',
			service
				? { id: row.id, key: token.trim(), ...adminPart }
				: { id: row.id, token: token.trim(), ...adminPart },
		)
		if (!r.ok) return setFailure(r.failure)
		if (service) {
			const v = r.value as { ok?: boolean; message?: string }
			if (v.ok === false) return setFailure(v.message ?? 'That key was not accepted.')
			setDone({
				customer: row.licence?.customer ?? '',
				seats: row.licence?.seats ?? 0,
				expires: row.licence?.expires ?? '',
			})
			setToken('')
			await refreshExtensions(api)
			return
		}
		const v = r.value as { customer?: string; seats?: number; expires?: string }
		setDone({
			customer: String(v.customer ?? ''),
			seats: Number(v.seats ?? 0),
			expires: String(v.expires ?? ''),
		})
		setToken('')
		await refreshExtensions(api)
	}
	return (
		<Shell title="Licence key" onClose={onClose}>
			{done ? (
				<p>
					Accepted
					{done.customer
						? `: ${done.customer}, ${done.seats} seats, expires ${formatWhen(done.expires)}`
						: ''}
					. The key is not shown again.
				</p>
			) : (
				<>
					<p>
						{service
							? `Paste the licence key you were given. It is sent to ${row.licenceHost ?? 'the publisher'} to check it, together with a code for this computer. Namzu keeps it; the extension never sees it.`
							: 'Paste the licence key you were given. It is checked on this computer and is not sent anywhere.'}
					</p>
					<textarea
						className="extension-textarea"
						value={token}
						onChange={(e) => setToken(e.target.value)}
						rows={5}
						spellCheck={false}
						aria-label="Licence key"
					/>
					{locked && <AdminField value={admin} onChange={setAdmin} />}
					<Failure failure={failure} />
					<Button disabled={!token.trim() || (locked && !admin)} onClick={() => void save()}>
						Save the key
					</Button>
				</>
			)}
			{row.licence && !done && (
				<p className="extension-footnote">
					Current: {row.licence.customer}, {row.licence.seats} seats, expires{' '}
					{formatWhen(row.licence.expires)}
				</p>
			)}
			{licenceLines(row).length > 0 && (
				<ul className="extension-licence-lines">
					{licenceLines(row).map((l) => (
						<li key={l}>{l}</li>
					))}
				</ul>
			)}
			{service && row.licence && (
				<div className="extension-actions">
					{locked && <AdminField value={admin} onChange={setAdmin} />}
					<Button variant="outline" onClick={() => void act('check')}>
						Check now
					</Button>
					<Button variant="ghost-muted" onClick={() => void act('release')}>
						Release this computer
					</Button>
				</div>
			)}
		</Shell>
	)
}

export function KeyDialog({
	api,
	row,
	onClose,
}: { api: Api; row: ExtensionRow; onClose: () => void }) {
	const [provider, setProvider] = useState('openai')
	const [value, setValue] = useState('')
	const [admin, setAdmin] = useState('')
	const locked = row.management?.locked === true
	const [state, setState] = useState<{ hasValue: boolean; masked?: string }>()
	const [failure, setFailure] = useState<ExtensionFailure | string>()
	useEffect(() => {
		let live = true
		void ask(api, 'namzu/extensions/settings/get', { id: row.id, key: 'modelKey', provider }).then(
			(r) => {
				if (live && r.ok) setState(r.value as { hasValue: boolean; masked?: string })
			},
		)
		return () => {
			live = false
		}
	}, [api, row.id, provider])
	const save = async (v: string | null) => {
		const r = await ask(api, 'namzu/extensions/settings/set', {
			id: row.id,
			key: 'modelKey',
			provider,
			value: v,
			...(locked && admin ? { admin } : {}),
		})
		if (!r.ok) return setFailure(r.failure)
		setState(r.value as { hasValue: boolean; masked?: string })
		setValue('')
		setFailure(undefined)
	}
	return (
		<Shell title="Model API key" onClose={onClose}>
			<p>
				A key for a model, entered by hand. It is kept apart from your own Namzu keys and shown only
				as its last four characters. <strong>Nothing uses it in this version</strong>: no model is
				called.
			</p>
			<label className="extension-label">
				Provider
				<input
					className="extension-input"
					value={provider}
					onChange={(e) => setProvider(e.target.value.toLowerCase())}
				/>
			</label>
			<p>{state?.hasValue ? `A key is stored (${state.masked}).` : 'No key stored.'}</p>
			<label className="extension-label">
				Key
				<input
					className="extension-input"
					type="password"
					value={value}
					onChange={(e) => setValue(e.target.value)}
					autoComplete="off"
				/>
			</label>
			{locked && <AdminField value={admin} onChange={setAdmin} />}
			<Failure failure={failure} />
			<div className="extension-inline-actions">
				<Button disabled={!value || (locked && !admin)} onClick={() => void save(value)}>
					Store the key
				</Button>
				{state?.hasValue && (
					<Button variant="outline" onClick={() => void save(null)}>
						Remove the key
					</Button>
				)}
			</div>
		</Shell>
	)
}

export function LogDialog({
	api,
	row,
	onClose,
}: { api: Api; row: ExtensionRow; onClose: () => void }) {
	const lines = useAudit(api, row.id)
	return (
		<Shell title={`${EVENT_HISTORY_TITLE}: ${row.name}`} onClose={onClose} wide>
			<p className="extension-history-sentence">{EVENT_HISTORY_SENTENCE}</p>
			{!lines ? (
				<p>Reading…</p>
			) : lines.length === 0 ? (
				<p>Nothing yet.</p>
			) : (
				<ul className="extension-log">
					{[...lines].reverse().map((l, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: log lines have no identity
						<li key={i}>
							<time>{formatWhen(l.ts)}</time> <strong>{auditWords(l.event, l.detail)}</strong>
						</li>
					))}
				</ul>
			)}
		</Shell>
	)
}

export function RemoveDialog({
	api,
	row,
	onClose,
}: { api: Api; row: ExtensionRow; onClose: () => void }) {
	const [deleteData, setDeleteData] = useState(true)
	const [admin, setAdmin] = useState('')
	const locked = row.management?.locked === true
	const [busy, setBusy] = useState(false)
	const [failure, setFailure] = useState<ExtensionFailure | string>()
	const go = async () => {
		setBusy(true)
		const r = await ask(api, 'namzu/extensions/remove', {
			id: row.id,
			deleteData,
			...(locked && admin ? { admin } : {}),
		})
		await refreshExtensions(api)
		setBusy(false)
		if (!r.ok) setFailure(r.failure)
		else onClose()
	}
	return (
		<Dialog.Root open onOpenChange={(open) => !open && !busy && onClose()}>
			<Dialog.Portal>
				<Dialog.Backdrop className="dialog-scrim" />
				<Dialog.Viewport className="dialog-viewport">
					<Dialog.Popup className="dialog-popup" data-dialog-size="confirm">
						<Dialog.Title className="dialog-title">Remove {row.name}?</Dialog.Title>
						<Dialog.Description className="dialog-body">
							It stops and is removed. Your record of acknowledging the notice is kept for the time
							its notice states. Nothing was ever sent anywhere in this version, so there is nothing
							to take back from elsewhere.
						</Dialog.Description>
						<label className="extension-check">
							<input
								type="checkbox"
								checked={deleteData}
								onChange={(e) => setDeleteData(e.target.checked)}
							/>{' '}
							Delete the data it collected too
						</label>
						{locked && <AdminField value={admin} onChange={setAdmin} />}
						<Failure failure={failure} />
						<div className="dialog-actions">
							<Button variant="outline" disabled={busy} onClick={onClose}>
								Cancel
							</Button>
							<Button disabled={busy || (locked && !admin)} onClick={() => void go()}>
								Remove
							</Button>
						</div>
					</Dialog.Popup>
				</Dialog.Viewport>
			</Dialog.Portal>
		</Dialog.Root>
	)
}
