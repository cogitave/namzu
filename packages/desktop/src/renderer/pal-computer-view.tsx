import { useEffect, useRef, useState } from 'react'
import type {
	PalComputerView as ComputerState,
	PalComputerInput,
	PalScreenView,
} from '../shared/protocol.js'
import { ArrowLeftIcon, LoaderCircleIcon, MonitorIcon, RefreshIcon } from './icons.js'
import {
	computerFrameReady,
	computerKeyboardInput,
	computerScreenPoint,
} from './pal-computer-input.js'
import { Button } from './ui/button.js'
import './pal-computer-view.css'

export interface PalComputerViewProps {
	palName: string
	computer: { name: string; status: 'ready' | 'connecting' | 'error'; notice?: string }
	screen: PalScreenView | null
	loading: boolean
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
}

/** A content route, keyed by its owning Pal and allocation generation by the host. */
export function PalComputerView({
	palName,
	computer,
	screen,
	loading,
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
	const connected = computer.status === 'ready'
	const changingControl = controlBusy || control?.mode === 'transitioning'
	const hasScreen = connected && screen !== null
	const canInput =
		hasScreen &&
		computerFrameReady(loadedGeometry, screen) &&
		control?.supported === true &&
		control.mode === 'operator' &&
		!changingControl &&
		!!onInput
	const canTakeOver =
		hasScreen &&
		!loading &&
		!changingControl &&
		control?.supported === true &&
		control.mode === 'pal' &&
		!!onTakeOver
	const forwardInput = (input: PalComputerInput) => {
		if (!canInput || !onInput) return
		setInputNotice(null)
		void onInput(input).catch(() =>
			setInputNotice('Input could not be sent. Refresh the computer and try again.'),
		)
	}
	const pointAt = (x: number, y: number) =>
		screen && image.current
			? computerScreenPoint({ x, y }, image.current.getBoundingClientRect(), screen)
			: null
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
			gesture.current?.width !== screen?.width ||
			gesture.current?.height !== screen?.height
		)
			gesture.current = null
		return () => {
			cancelAnimationFrame(moveFrame.current)
			moveFrame.current = 0
			movePoint.current = null
			gesture.current = null
		}
	}, [canInput, screen?.width, screen?.height])
	useEffect(() => {
		const node = surface.current
		if (!node || !canInput) return
		const wheel = (event: WheelEvent) => {
			const at = pointAt(event.clientX, event.clientY)
			if (!at || (!event.deltaX && !event.deltaY)) return
			event.preventDefault()
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
		<section className="pal-computer-view" aria-label={computer.name}>
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
					disabled={!connected || loading || changingControl || inputBusy}
					onClick={onRefresh}
				>
					<RefreshIcon className={loading ? 'pal-computer-loading' : undefined} />
				</Button>
			</header>
			<div className="pal-computer-viewport">
				<section
					className="pal-computer-screen"
					ref={surface}
					data-interactive={canInput}
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
						if (!canInput || !screen || event.button > 2) return
						const point = pointAt(event.clientX, event.clientY)
						if (!point) return
						event.preventDefault()
						event.currentTarget.focus({ preventScroll: true })
						event.currentTarget.setPointerCapture(event.pointerId)
						gesture.current = {
							point,
							button: event.button === 1 ? 'middle' : event.button === 2 ? 'right' : 'left',
							width: screen.width,
							height: screen.height,
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
							started.width !== screen?.width ||
							started.height !== screen?.height ||
							started.pointerId !== event.pointerId
						)
							return
						const to = pointAt(event.clientX, event.clientY)
						if (!to) return
						forwardInput(
							Math.hypot(to.x - started.point.x, to.y - started.point.y) > 4
								? { type: 'mouse_drag', from: started.point, to, button: started.button }
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
					{hasScreen ? (
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
								setLoadedGeometry(null)
								setInputNotice('The computer screen could not be displayed. Refresh to try again.')
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
										? 'Refresh to capture this computer’s desktop.'
										: 'Start this computer to view its desktop.')}
							</p>
							{connected && !loading && (
								<Button variant="outline" size="sm" onClick={onRefresh}>
									Refresh screen
								</Button>
							)}
							{onStart && computer.status === 'error' && !loading && (
								<Button variant="outline" size="sm" onClick={onStart}>
									Start computer
								</Button>
							)}
						</div>
					)}
					{hasScreen && loading && (
						<output className="pal-computer-screen-loading">
							<LoaderCircleIcon className="pal-computer-loading" /> Updating screen…
						</output>
					)}
				</section>
			</div>
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
						disabled={!connected || changingControl || inputBusy}
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
			{(inputNotice || (hasScreen && computer.notice)) && (
				<output className="pal-computer-view-notice">{inputNotice || computer.notice}</output>
			)}
		</section>
	)
}
