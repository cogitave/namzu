import type RFB from '@novnc/novnc'
import { useEffect, useRef, useState } from 'react'
import type { PalComputerStreamView } from '../shared/protocol.js'
import { computerFramePresented } from './computer-frame-presented.js'
import { LoaderCircleIcon, MonitorIcon } from './icons.js'
import './pal-live-screen.css'

export interface PalLiveScreenProps {
	stream: PalComputerStreamView
	name: string
	onReady: (canvas: HTMLCanvasElement, geometry: { width: number; height: number }) => void
	onDisconnected: () => void
}

/** Frames go directly to noVNC's canvas. All guest input stays on the owned SDK input path. */
export function PalLiveScreen({ stream, name, onReady, onDisconnected }: PalLiveScreenProps) {
	const host = useRef<HTMLDivElement>(null)
	const callbacks = useRef({ onReady, onDisconnected })
	callbacks.current = { onReady, onDisconnected }
	const [connection, setConnection] = useState<{
		id: string
		generation: string
		state: 'connecting' | 'ready' | 'disconnected'
	}>({ id: stream.id, generation: stream.generation, state: 'connecting' })
	const state =
		connection.id === stream.id && connection.generation === stream.generation
			? connection.state
			: 'connecting'

	useEffect(() => {
		const target = host.current
		if (!target) return
		let current = true
		let connected = false
		let failed = false
		let rfbEnded = false
		let closeRequested = false
		let frame: number | undefined
		let confirmedCanvas: HTMLCanvasElement | null = null
		let rfb: RFB | undefined
		let socket: WebSocket | undefined
		setConnection({ id: stream.id, generation: stream.generation, state: 'connecting' })
		const close = () => {
			if (rfb && !rfbEnded && !closeRequested) {
				closeRequested = true
				rfb.disconnect()
			}
			if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING)
				socket.close()
		}
		const fail = () => {
			if (!current || failed) return
			failed = true
			connected = false
			confirmedCanvas = null
			if (frame !== undefined) cancelAnimationFrame(frame)
			frame = undefined
			setConnection({ id: stream.id, generation: stream.generation, state: 'disconnected' })
			callbacks.current.onDisconnected()
			close()
		}
		const onDisconnected = () => {
			rfbEnded = true
			fail()
		}
		const scheduleCanvasCheck = () => {
			if (!current || !connected || failed || confirmedCanvas || frame !== undefined) return
			frame = requestAnimationFrame(() => {
				frame = undefined
				confirmCanvas()
			})
		}
		const confirmCanvas = () => {
			if (!current || !connected || failed) return
			const canvas = target.querySelector('canvas')
			if (!canvas || canvas.width <= 0 || canvas.height <= 0) {
				scheduleCanvasCheck()
				return
			}
			if (canvas.width !== stream.width || canvas.height !== stream.height) {
				fail()
				return
			}
			canvas.tabIndex = -1
			canvas.setAttribute('aria-hidden', 'true')
			canvas.style.pointerEvents = 'none'
			if (confirmedCanvas === canvas) return
			if (!computerFramePresented(canvas, { width: stream.width, height: stream.height })) {
				scheduleCanvasCheck()
				return
			}
			confirmedCanvas = canvas
			if (frame !== undefined) cancelAnimationFrame(frame)
			frame = undefined
			clearTimeout(timeout)
			setConnection({ id: stream.id, generation: stream.generation, state: 'ready' })
			callbacks.current.onReady(canvas, { width: canvas.width, height: canvas.height })
		}
		const observer = new MutationObserver(confirmCanvas)
		observer.observe(target, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ['width', 'height'],
		})
		const onConnect = () => {
			if (!current || failed) return
			connected = true
			scheduleCanvasCheck()
		}
		const timeout = setTimeout(() => {
			if (!confirmedCanvas) fail()
		}, 15_000)
		const connect = async () => {
			try {
				// Browser-only loading also keeps server rendering independent of noVNC's DOM APIs.
				const { default: RfbClient } = await import('@novnc/novnc')
				if (!current || failed) return
				// Supplying an owned WebSocket avoids exposing the ephemeral URL to noVNC's logs.
				socket = new WebSocket(stream.url)
				socket.binaryType = 'arraybuffer'
				rfb = new RfbClient(target, socket, { shared: true })
				rfb.viewOnly = true
				rfb.focusOnClick = false
				rfb.scaleViewport = true
				rfb.resizeSession = false
				rfb.background = 'transparent'
				rfb.addEventListener('connect', onConnect)
				rfb.addEventListener('disconnect', onDisconnected)
				rfb.addEventListener('credentialsrequired', fail)
				rfb.addEventListener('securityfailure', fail)
			} catch {
				fail()
			}
		}
		void connect()
		return () => {
			current = false
			connected = false
			clearTimeout(timeout)
			if (frame !== undefined) cancelAnimationFrame(frame)
			observer.disconnect()
			rfb?.removeEventListener('connect', onConnect)
			rfb?.removeEventListener('disconnect', onDisconnected)
			rfb?.removeEventListener('credentialsrequired', fail)
			rfb?.removeEventListener('securityfailure', fail)
			close()
			target.replaceChildren()
		}
	}, [stream.id, stream.url, stream.width, stream.height, stream.generation])

	return (
		<div className="pal-live-screen" data-state={state}>
			<div ref={host} className="pal-live-canvas" role="img" aria-label={`${name}, live desktop`} />
			{state !== 'ready' && (
				<div className="pal-live-state">
					{state === 'connecting' ? (
						<LoaderCircleIcon className="pal-computer-loading" />
					) : (
						<MonitorIcon />
					)}
					<output aria-live="polite">
						{state === 'connecting'
							? 'Connecting to the live desktop…'
							: 'Live desktop disconnected'}
					</output>
					{state === 'disconnected' && <p>Reconnect to continue viewing this computer.</p>}
				</div>
			)}
		</div>
	)
}
