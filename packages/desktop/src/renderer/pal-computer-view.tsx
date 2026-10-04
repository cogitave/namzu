import { type CSSProperties, type ComponentProps, useEffect, useRef, useState } from 'react'
import type {
	PalComputerView as ComputerState,
	PalComputerInput,
	PalComputerStreamView,
	PalScreenView,
} from '../shared/protocol.js'
import { ComputerInputRetiredError, computerSurfaceOwnsFocus } from './computer-input-focus.js'
import { ArrowLeftIcon, LoaderCircleIcon, MonitorIcon, RefreshIcon } from './icons.js'
import {
	computerFrameReady,
	computerKeyboardInput,
	computerScreenPoint,
} from './pal-computer-input.js'
import { PalLiveScreen } from './pal-live-screen.js'
import { Button } from './ui/button.js'
import './pal-computer-view.css'

export interface PalComputerViewProps
	extends Pick<ComponentProps<'section'>, 'id' | 'aria-labelledby' | 'role'> {
	palName: string
	computer: {
		name: string
		status: 'ready' | 'connecting' | 'error'
		notice?: string
	}
	screen: PalScreenView | null
	loading: boolean
	stream?: PalComputerStreamView | null
	/** The surrounding computer workspace can supply its own shared toolbar. */
	hideHeader?: boolean
	control?: ComputerState['control']
	controlBusy?: boolean
	inputBusy?: boolean
	onBack: () => void
	onRefresh: () => void
	onStart?: () => void
	onTakeOver?: () => void
	onRelease?: () => void
	/** The host callback captures and validates the owning Pal and computer generation. */
	onInput?: (input: PalComputerInput) => Promise<void>
	/** Capture native menu shortcuts only while the live operator surface has keyboard focus. */
	onKeyboardFocus?: (focused: boolean) => void
	/** Called only when the owning live canvas has confirmed its actual geometry. */
	onStreamReady?: (id: string) => void
	onStreamDisconnected?: (id: string) => void
}

/** A content route, keyed by its owning Pal and allocation generation by the host. */
export function PalComputerView({
	id,
	'aria-labelledby': labelledBy,
	role,
	palName,
	computer,
	screen,
	loading,
	stream,
	hideHeader = false,
	control,
	controlBusy = false,
	inputBusy = false,
	onBack,
	onRefresh,
	onStart,
	onTakeOver,
	onRelease,
	onInput,
	onKeyboardFocus,
	onStreamReady,
	onStreamDisconnected,
}: PalComputerViewProps) {
	const image = useRef<HTMLImageElement>(null)
	const surface = useRef<HTMLElement>(null)
	const keyboardFocused = useRef(false)
	const keyboardFocusCallback = useRef(onKeyboardFocus)
	keyboardFocusCallback.current = onKeyboardFocus
	const moveFrame = useRef(0)
	const movePoint = useRef<{ x: number; y: number } | null>(null)
	const gesture = useRef<{
		point: { x: number; y: number }
		button: 'left' | 'middle' | 'right'
		width: number
		height: number
		pointerId: number
	} | null>(null)
	const [loadedGeometry, setLoadedGeometry] = useState<Pick<
		PalScreenView,
		'width' | 'height'
	> | null>(null)
	const [inputNotice, setInputNotice] = useState<string | null>(null)
	const [liveFrame, setLiveFrame] = useState<{
		id: string
		generation: string
		canvas: HTMLCanvasElement
		width: number
		height: number
	} | null>(null)
	const [disconnectedStream, setDisconnectedStream] = useState<string | null>(null)
	const inputReady = useRef(false)
	const connected = computer.status === 'ready'
	const changingControl = controlBusy || control?.mode === 'transitioning'
	const hasStream = connected && !!stream
	const frameGeometry = stream ?? screen
	const frameRatio =
		frameGeometry && frameGeometry.width > 0 && frameGeometry.height > 0
			? frameGeometry.width / frameGeometry.height
			: 16 / 10
	const liveReady =
		hasStream &&
		liveFrame?.id === stream.id &&
		liveFrame.generation === stream.generation &&
		liveFrame.canvas.isConnected &&
		computerFrameReady(liveFrame, stream)
	const displayGeometry = hasStream ? (liveReady ? liveFrame : null) : screen
	const hasScreen = connected && (hasStream || screen !== null)
	const displayReady = hasStream ? liveReady : computerFrameReady(loadedGeometry, screen)
	const displayLoading = hasStream ? !liveReady && disconnectedStream !== stream.id : loading
	const canInput =
		hasScreen &&
		displayReady &&
		control?.supported === true &&
		control.mode === 'operator' &&
		!changingControl &&
		!!onInput
	inputReady.current = canInput
	const canTakeOver =
		hasScreen &&
		(!hasStream || liveReady) &&
		!displayLoading &&
		!changingControl &&
		control?.supported === true &&
		control.mode === 'pal' &&
		!!onTakeOver
	const forwardInput = (input: PalComputerInput) => {
		if (
			!canInput ||
			!inputReady.current ||
			!document.hasFocus() ||
			!computerSurfaceOwnsFocus(document.activeElement) ||
			!onInput
		)
			return
		setInputNotice(null)
		void onInput(input).catch((error) => {
			if (!(error instanceof ComputerInputRetiredError))
				setInputNotice('Input could not be sent. Refresh the computer and try again.')
		})
	}
	const pointAt = (x: number, y: number) => {
		const displayed = hasStream ? liveFrame?.canvas : image.current
		return displayGeometry && displayed
			? computerScreenPoint({ x, y }, displayed.getBoundingClientRect(), displayGeometry)
			: null
	}
	useEffect(() => {
		keyboardFocusCallback.current?.(canInput && keyboardFocused.current)
	}, [canInput])
	useEffect(
		() => () => {
			keyboardFocused.current = false
			keyboardFocusCallback.current?.(false)
		},
		[],
	)
	useEffect(() => {
		if (
			!canInput ||
			gesture.current?.width !== displayGeometry?.width ||
			gesture.current?.height !== displayGeometry?.height
		)
			gesture.current = null
		return () => {
			cancelAnimationFrame(moveFrame.current)
			moveFrame.current = 0
			movePoint.current = null
			gesture.current = null
		}
	}, [canInput, displayGeometry?.width, displayGeometry?.height])
	useEffect(() => {
		const node = surface.current
		if (!node || !canInput) return
		const wheel = (event: WheelEvent) => {
			const at = pointAt(event.clientX, event.clientY)
			if (!at || (!event.deltaX && !event.deltaY)) return
			event.preventDefault()
			node.focus({ preventScroll: true })
			const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY)
			const delta = horizontal ? event.deltaX : event.deltaY
			forwardInput({
				type: 'scroll',
				at,
				direction: horizontal ? (delta > 0 ? 'right' : 'left') : delta > 0 ? 'down' : 'up',
				amount: Math.min(10, Math.max(1, Math.ceil(Math.abs(delta) / 100))),
			})
		}
		node.addEventListener('wheel', wheel, { passive: false })
		return () => node.removeEventListener('wheel', wheel)
	})
	return (
		<section
			id={id}
			role={role}
			className="pal-computer-view"
			aria-label={computer.name}
			aria-labelledby={labelledBy}
			data-header={!hideHeader}
			data-control={control?.mode}
		>
			{hideHeader && disconnectedStream === stream?.id && stream && (
				<Button variant="outline" size="sm" className="pal-computer-reconnect" onClick={onRefresh}>
					<RefreshIcon /> Reconnect live desktop
				</Button>
			)}
			{!hideHeader && (
				<header className="pal-computer-view-heading">
					<Button variant="ghost-muted" size="sm" onClick={onBack} className="pal-computer-back">
						<ArrowLeftIcon /> <span>Back to chat</span>
					</Button>
					<div className="pal-computer-view-title">
						<MonitorIcon />
						<h2 title={computer.name}>{computer.name}</h2>
					</div>
					<Button
						variant="ghost-muted"
						size="icon-sm"
						aria-label="Refresh computer screen"
						disabled={!connected || displayLoading || changingControl || inputBusy}
						onClick={onRefresh}
					>
						<RefreshIcon className={displayLoading ? 'pal-computer-loading' : undefined} />
					</Button>
				</header>
			)}
			<div className="pal-computer-viewport">
				<div
					className="pal-computer-display"
					style={{ '--computer-aspect-ratio': frameRatio } as CSSProperties}
				>
					<section
						className="pal-computer-screen"
						ref={surface}
						data-interactive={canInput}
						data-display={hasStream ? 'live' : 'capture'}
						aria-label={`${computer.name} screen${canInput ? ', keyboard and mouse enabled' : ', viewing only'}`}
						tabIndex={canInput ? 0 : undefined}
						onFocus={() => {
							keyboardFocused.current = true
							keyboardFocusCallback.current?.(canInput)
						}}
						onBlur={() => {
							keyboardFocused.current = false
							keyboardFocusCallback.current?.(false)
						}}
						onContextMenu={(event) => {
							if (canInput) event.preventDefault()
						}}
						onPointerDown={(event) => {
							if (!canInput || !displayGeometry || event.button > 2) return
							const point = pointAt(event.clientX, event.clientY)
							if (!point) return
							event.preventDefault()
							event.currentTarget.focus({ preventScroll: true })
							event.currentTarget.setPointerCapture(event.pointerId)
							gesture.current = {
								point,
								button: event.button === 1 ? 'middle' : event.button === 2 ? 'right' : 'left',
								width: displayGeometry.width,
								height: displayGeometry.height,
								pointerId: event.pointerId,
							}
						}}
						onPointerCancel={() => {
							gesture.current = null
						}}
						onPointerMove={(event) => {
							if (!canInput || gesture.current) return
							movePoint.current = pointAt(event.clientX, event.clientY)
							if (!movePoint.current || moveFrame.current) return
							moveFrame.current = requestAnimationFrame(() => {
								moveFrame.current = 0
								if (movePoint.current) forwardInput({ type: 'mouse_move', to: movePoint.current })
							})
						}}
						onPointerUp={(event) => {
							const started = gesture.current
							gesture.current = null
							if (
								!started ||
								!canInput ||
								started.width !== displayGeometry?.width ||
								started.height !== displayGeometry?.height ||
								started.pointerId !== event.pointerId
							)
								return
							const to = pointAt(event.clientX, event.clientY)
							if (!to) return
							forwardInput(
								Math.hypot(to.x - started.point.x, to.y - started.point.y) > 4
									? {
											type: 'mouse_drag',
											from: started.point,
											to,
											button: started.button,
										}
									: { type: 'mouse_click', at: to, button: started.button },
							)
						}}
						onKeyDown={(event) => {
							if (!canInput) return
							const input = computerKeyboardInput({
								...event,
								isComposing: event.nativeEvent.isComposing,
								altGraph: event.getModifierState('AltGraph'),
							})
							if (!input) return
							event.preventDefault()
							event.stopPropagation()
							forwardInput(input)
						}}
					>
						{hasStream ? (
							<PalLiveScreen
								stream={stream}
								name={computer.name}
								onReady={(canvas, geometry) => {
									onStreamReady?.(stream.id)
									setDisconnectedStream(null)
									setLiveFrame({
										id: stream.id,
										generation: stream.generation,
										canvas,
										...geometry,
									})
								}}
								onDisconnected={() => {
									inputReady.current = false
									gesture.current = null
									cancelAnimationFrame(moveFrame.current)
									moveFrame.current = 0
									movePoint.current = null
									setLiveFrame(null)
									setDisconnectedStream(stream.id)
									onStreamDisconnected?.(stream.id)
								}}
							/>
						) : hasScreen && screen ? (
							<img
								ref={image}
								src={screen.source}
								width={screen.width}
								height={screen.height}
								alt={`${palName}’s actual computer screen`}
								draggable={false}
								onLoad={(event) =>
									setLoadedGeometry({
										width: event.currentTarget.naturalWidth,
										height: event.currentTarget.naturalHeight,
									})
								}
								onError={() => {
									inputReady.current = false
									setLoadedGeometry(null)
									setInputNotice(
										'The computer screen could not be displayed. Refresh to try again.',
									)
								}}
							/>
						) : (
							<div className="pal-computer-empty">
								{loading || computer.status === 'connecting' ? (
									<LoaderCircleIcon className="pal-computer-loading" />
								) : (
									<MonitorIcon />
								)}
								<h3>
									{computer.status === 'connecting'
										? `Connecting to ${computer.name}…`
										: loading
											? `Opening ${computer.name}…`
											: connected
												? 'Screen unavailable'
												: 'Computer is offline'}
								</h3>
								<p>
									{computer.notice ||
										(connected
											? 'Connect to view this computer’s live desktop.'
											: 'Start this computer to view its desktop.')}
								</p>
								{connected && !loading && (
									<Button variant="outline" size="sm" onClick={onRefresh}>
										Connect live desktop
									</Button>
								)}
								{onStart && computer.status === 'error' && !loading && (
									<Button variant="outline" size="sm" onClick={onStart}>
										Start computer
									</Button>
								)}
							</div>
						)}
						{!hasStream && hasScreen && loading && (
							<output className="pal-computer-screen-loading">
								<LoaderCircleIcon className="pal-computer-loading" /> Updating screen…
							</output>
						)}
					</section>
					<footer className="pal-computer-control-bar">
						<output aria-live="polite">
							{changingControl
								? 'Changing control…'
								: !connected
									? 'Offline'
									: control?.mode === 'operator'
										? 'You have control'
										: control?.mode === 'pal'
											? `${palName} has control`
											: 'Viewing only'}
						</output>
						{control?.supported && control.mode === 'operator' && onRelease ? (
							<Button
								variant="outline"
								size="sm"
								className="pal-computer-control-button"
								disabled={!connected || changingControl}
								onClick={onRelease}
							>
								Return control
							</Button>
						) : onTakeOver ? (
							<Button
								variant="outline"
								size="sm"
								className="pal-computer-control-button"
								disabled={!canTakeOver}
								onClick={onTakeOver}
							>
								Take over
							</Button>
						) : null}
					</footer>
				</div>
			</div>
			{(inputNotice || (hasScreen && computer.notice)) && (
				<output className="pal-computer-view-notice">{inputNotice || computer.notice}</output>
			)}
		</section>
	)
}
