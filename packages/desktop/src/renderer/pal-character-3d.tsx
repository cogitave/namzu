import { useEffect, useRef, useState } from 'react'
import type * as Three from 'three'
import type { RoundedBoxGeometry as RoundedBox } from 'three/addons/geometries/RoundedBoxGeometry.js'
import {
	PalCharacter,
	type PalCharacterAppearance,
	defaultPalAppearance,
	palColors,
} from './pal-character.js'
import { type PalSceneLease, PalScenePool, type PalSceneResource } from './pal-scene-pool.js'

interface PalScene extends PalSceneResource {
	attach(element: HTMLSpanElement, paused: boolean, ready: (value: boolean) => void): void
	setPaused(paused: boolean): void
}
interface SceneBinding {
	element: HTMLSpanElement
	paused: boolean
	visible: boolean
	presented: boolean
	ready: (value: boolean) => void
	cleanups: (() => void)[]
}
const scenes = new PalScenePool<PalScene>(2)
const releaseAll = (cleanups: (() => void)[]) => {
	for (const cleanup of cleanups.reverse()) {
		try {
			cleanup()
		} catch {
			/* Release the remaining resources even after a failed browser cleanup. */
		}
	}
}

/** GPU resources survive an idle lease; all callbacks belong only to the current attachment. */
function createScene(
	THREE: typeof Three,
	RoundedBoxGeometry: typeof RoundedBox,
	appearance: PalCharacterAppearance,
): PalScene {
	const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
	const cleanups: (() => void)[] = []
	let binding: SceneBinding | undefined
	let frame = 0
	let alive = true
	const stop = () => {
		cancelAnimationFrame(frame)
		frame = 0
	}
	const suspend = () => {
		const previous = binding
		binding = undefined
		stop()
		if (previous) releaseAll(previous.cleanups)
		renderer.domElement.remove()
	}
	const dispose = () => {
		if (!alive) return
		alive = false
		suspend()
		releaseAll(cleanups)
	}
	cleanups.push(
		() => renderer.forceContextLoss(),
		() => renderer.dispose(),
	)
	try {
		renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75))
		renderer.setClearColor(0, 0)
		renderer.outputColorSpace = THREE.SRGBColorSpace
		renderer.toneMapping = THREE.ACESFilmicToneMapping
		renderer.toneMappingExposure = 1.3
		renderer.domElement.setAttribute('aria-hidden', 'true')
		const scene = new THREE.Scene()
		const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 30)
		camera.position.set(0.25, 0.3, 5.1)
		camera.lookAt(0, 0.05, 0)
		scene.add(new THREE.HemisphereLight('#f5fff4', '#597360', 2.4))
		const key = new THREE.DirectionalLight('#fff7e6', 3.3)
		key.position.set(-3, 5, 6)
		scene.add(key)
		const rim = new THREE.DirectionalLight('#ecfff6', 2)
		rim.position.set(3, 2, -3)
		scene.add(rim)
		const color = palColors.find((item) => item.id === appearance.color) ?? palColors[0]
		const cloth = document.createElement('canvas')
		cloth.width = cloth.height = 128
		const drawing = cloth.getContext('2d')
		if (drawing) {
			drawing.fillStyle = '#888'
			drawing.fillRect(0, 0, 128, 128)
			for (let y = 0; y < 128; y += 2)
				for (let x = 0; x < 128; x += 2) {
					const tone = 90 + Math.round(((Math.sin(x * 17.7 + y * 43.3) + 1) / 2) * 85)
					drawing.fillStyle = `rgb(${tone} ${tone} ${tone})`
					drawing.fillRect(x, y, 1, 1)
				}
		}
		const texture = new THREE.CanvasTexture(cloth)
		cleanups.push(() => texture.dispose())
		texture.wrapS = texture.wrapT = THREE.RepeatWrapping
		texture.repeat.set(3, 3)
		const material = new THREE.MeshStandardMaterial({
			color: color.base,
			roughness: 0.86,
			bumpMap: texture,
			bumpScale: 0.025,
		})
		cleanups.push(() => material.dispose())
		const dark = new THREE.MeshStandardMaterial({ color: color.dark, roughness: 0.9 })
		cleanups.push(() => dark.dispose())
		const eyeMaterial = new THREE.MeshStandardMaterial({
			color: '#101d16',
			roughness: 0.18,
			metalness: 0.06,
		})
		cleanups.push(() => eyeMaterial.dispose())
		const white = new THREE.MeshBasicMaterial({ color: '#fff' })
		cleanups.push(() => white.dispose())
		const figure = new THREE.Group()
		scene.add(figure)
		const mesh = (geometry: Three.BufferGeometry, paint: Three.Material, x = 0, y = 0, z = 0) => {
			cleanups.push(() => geometry.dispose())
			const result = new THREE.Mesh(geometry, paint)
			result.position.set(x, y, z)
			figure.add(result)
			return result
		}
		if (appearance.character === 'spark') {
			const shape = new THREE.Shape()
			for (let index = 0; index < 10; index++) {
				const angle = Math.PI / 2 + (index * Math.PI) / 5
				const radius = index % 2 ? 0.68 : 1.12
				const x = Math.cos(angle) * radius
				const y = Math.sin(angle) * radius
				if (!index) shape.moveTo(x, y)
				else shape.lineTo(x, y)
			}
			shape.closePath()
			mesh(
				new THREE.ExtrudeGeometry(shape, {
					depth: 0.65,
					bevelEnabled: true,
					bevelSegments: 4,
					steps: 1,
					bevelSize: 0.16,
					bevelThickness: 0.16,
				}),
				material,
				0,
				0,
				-0.4,
			)
		} else if (appearance.character === 'sprout') {
			const body = mesh(new THREE.SphereGeometry(0.95, 48, 36), material)
			body.scale.set(0.94, 1.07, 0.78)
			mesh(new THREE.CylinderGeometry(0.045, 0.065, 0.35, 12), dark, 0, 1.06)
			for (const side of [-1, 1]) {
				const leaf = mesh(new THREE.SphereGeometry(0.28, 24, 18), material, side * 0.2, 1.25)
				leaf.scale.set(1.2, 0.48, 0.38)
				leaf.rotation.z = side * 0.5
			}
		} else {
			mesh(new RoundedBoxGeometry(1.6, 1.55, 1.24, 5, 0.27), material)
			for (const side of [-1, 1])
				for (const y of [-0.36, 0.36])
					mesh(new RoundedBoxGeometry(0.34, 0.36, 0.8, 3, 0.12), material, side * 0.79, y)
		}
		for (const side of [-1, 1]) {
			const foot = mesh(
				new RoundedBoxGeometry(0.35, 0.28, 0.48, 3, 0.11),
				dark,
				side * 0.43,
				-0.9,
				0.1,
			)
			foot.rotation.y = side * -0.12
		}
		const eyes: Three.Mesh[] = []
		for (const side of [-1, 1]) {
			const eye = mesh(new THREE.SphereGeometry(0.115, 24, 20), eyeMaterial, side * 0.3, 0.15, 0.69)
			eye.scale.set(1, 1.35, 0.7)
			eyes.push(eye)
			const shineGeometry = new THREE.SphereGeometry(0.027, 12, 8)
			cleanups.push(() => shineGeometry.dispose())
			const shine = new THREE.Mesh(shineGeometry, white)
			shine.position.set(-0.033, 0.045, 0.079)
			eye.add(shine)
		}
		const smile = new THREE.CatmullRomCurve3([
			new THREE.Vector3(-0.13, -0.16, 0.72),
			new THREE.Vector3(0, -0.21, 0.735),
			new THREE.Vector3(0.13, -0.16, 0.72),
		])
		mesh(new THREE.TubeGeometry(smile, 16, 0.024, 8, false), eyeMaterial)
		const shadowGeometry = new THREE.CircleGeometry(0.85, 48)
		cleanups.push(() => shadowGeometry.dispose())
		const shadowMaterial = new THREE.MeshBasicMaterial({
			color: '#07130d',
			transparent: true,
			opacity: 0.1,
			depthWrite: false,
		})
		cleanups.push(() => shadowMaterial.dispose())
		const shadow = new THREE.Mesh(shadowGeometry, shadowMaterial)
		shadow.rotation.x = -Math.PI / 2
		shadow.position.set(0, -1.12, 0)
		shadow.scale.y = 0.7
		scene.add(shadow)
		const pointer = { x: 0, y: 0 }
		const fail = () => {
			const report = binding?.ready
			scenes.discard(resource)
			report?.(false)
		}
		const draw = (time: number) => {
			frame = 0
			const owner = binding
			if (!alive || !owner?.visible || !owner.element.isConnected || document.hidden) return
			if (!resource.valid) {
				fail()
				return
			}
			const seconds = time / 1000
			if (!owner.paused) {
				figure.position.y = Math.sin(seconds * 1.4) * 0.035
				figure.scale.setScalar(1 + Math.sin(seconds * 1.4) * 0.009)
				figure.rotation.y +=
					(-0.1 + pointer.x * 0.25 + Math.sin(seconds * 0.4) * 0.025 - figure.rotation.y) * 0.06
				figure.rotation.x += (pointer.y * 0.12 - figure.rotation.x) * 0.06
				const blink = seconds % 6.2
				const eyeHeight = blink > 5.9 && blink < 6.1 ? 0.08 + Math.abs(blink - 6) * 10 : 1.35
				for (const eye of eyes) eye.scale.y = eyeHeight
			}
			try {
				renderer.render(scene, camera)
			} catch {
				fail()
				return
			}
			if (!resource.valid) {
				fail()
				return
			}
			if (!owner.presented) {
				owner.presented = true
				owner.ready(true)
			}
			if (binding === owner && !owner.paused) start()
		}
		const start = () => {
			if (!alive || !binding?.visible || !binding.element.isConnected || document.hidden || frame)
				return
			if (!resource.valid) {
				fail()
				return
			}
			frame = requestAnimationFrame(draw)
		}
		const resource: PalScene = {
			get valid() {
				return alive && !renderer.getContext().isContextLost()
			},
			suspend,
			dispose,
			setPaused: (paused) => {
				if (!binding) return
				binding.paused = paused
				stop()
				start()
			},
			attach: (element, paused, ready) => {
				if (!resource.valid) throw new Error('This decorative scene is unavailable.')
				suspend()
				pointer.x = pointer.y = 0
				const owner: SceneBinding = {
					element,
					paused,
					ready,
					visible: false,
					presented: false,
					cleanups: [],
				}
				binding = owner
				const current = () => alive && binding === owner
				try {
					element.append(renderer.domElement)
					const resizeTo = (width: number, height: number) => {
						if (!current() || width <= 0 || height <= 0) return
						renderer.setSize(width, height, false)
						camera.aspect = width / height
						camera.updateProjectionMatrix()
						start()
					}
					const rect = element.getBoundingClientRect()
					resizeTo(rect.width, rect.height)
					const resize = new ResizeObserver(([entry]) => {
						if (entry) resizeTo(entry.contentRect.width, entry.contentRect.height)
					})
					owner.cleanups.push(() => resize.disconnect())
					resize.observe(element)
					const observer = new IntersectionObserver(([entry]) => {
						if (!current()) return
						owner.visible = entry?.isIntersecting ?? false
						if (!owner.visible) stop()
						start()
					})
					owner.cleanups.push(() => observer.disconnect())
					observer.observe(element)
					const move = (event: PointerEvent) => {
						if (!current()) return
						const rect = element.getBoundingClientRect()
						pointer.x = Math.max(
							-1,
							Math.min(1, (event.clientX - rect.left - rect.width / 2) / rect.width),
						)
						pointer.y = Math.max(
							-1,
							Math.min(1, (event.clientY - rect.top - rect.height / 2) / rect.height),
						)
					}
					const reset = () => {
						if (current()) pointer.x = pointer.y = 0
					}
					const visibility = () => {
						if (!current()) return
						if (document.hidden) stop()
						start()
					}
					element.addEventListener('pointermove', move)
					owner.cleanups.push(() => element.removeEventListener('pointermove', move))
					element.addEventListener('pointerleave', reset)
					owner.cleanups.push(() => element.removeEventListener('pointerleave', reset))
					document.addEventListener('visibilitychange', visibility)
					owner.cleanups.push(() => document.removeEventListener('visibilitychange', visibility))
				} catch (error) {
					scenes.discard(resource)
					throw error
				}
			},
		}
		const lost = (event: Event) => {
			if (!alive) return
			event.preventDefault()
			fail()
		}
		renderer.domElement.addEventListener('webglcontextlost', lost)
		cleanups.push(() => renderer.domElement.removeEventListener('webglcontextlost', lost))
		return resource
	} catch (error) {
		dispose()
		throw error
	}
}

/** Decorative local scene. SVG remains available when motion or WebGL is unavailable. */
export function PalCharacter3D({
	appearance = defaultPalAppearance,
	size = 'hero',
	paused = false,
}: { appearance?: PalCharacterAppearance; size?: 'hero' | 'avatar'; paused?: boolean }) {
	const character = appearance.character
	const color = appearance.color
	const host = useRef<HTMLSpanElement>(null)
	const pausedState = useRef(paused)
	const activeScene = useRef<PalScene | undefined>(undefined)
	const [ready, setReady] = useState(false)
	useEffect(() => {
		pausedState.current = paused
		activeScene.current?.setPaused(paused)
	}, [paused])
	useEffect(() => {
		let active = true
		let generation = 0
		let lease: PalSceneLease<PalScene> | undefined
		const media = matchMedia('(prefers-reduced-motion: reduce)')
		const release = (discard = false) => {
			activeScene.current = undefined
			lease?.release(discard)
			lease = undefined
		}
		const refresh = async () => {
			const request = ++generation
			release(media.matches)
			setReady(false)
			if (media.matches) {
				scenes.clear()
				return
			}
			if (!host.current) return
			try {
				const [THREE, { RoundedBoxGeometry }] = await Promise.all([
					import('three'),
					import('three/addons/geometries/RoundedBoxGeometry.js'),
				])
				if (!active || request !== generation || media.matches || !host.current) return
				const key = JSON.stringify([character, color, size])
				lease = scenes.acquire(key, () =>
					createScene(THREE, RoundedBoxGeometry, { character, color }),
				)
				activeScene.current = lease.scene
				lease.scene.attach(host.current, pausedState.current, (value) => {
					if (active && request === generation) setReady(value)
				})
			} catch {
				release(true)
				if (active && request === generation) setReady(false)
			}
		}
		void refresh()
		media.addEventListener('change', refresh)
		return () => {
			active = false
			media.removeEventListener('change', refresh)
			release(media.matches)
		}
	}, [character, color, size])
	return (
		<span
			className={`pal-character-scene pal-character-scene-${size}`}
			ref={host}
			data-ready={ready || undefined}
			data-paused={paused || undefined}
			aria-hidden="true"
		>
			<span className="pal-character-fallback">
				<PalCharacter appearance={appearance} size={size} paused={paused} />
			</span>
		</span>
	)
}
