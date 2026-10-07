import { useEffect, useRef } from 'react'
import {
	EFFORT_PALETTE,
	EFFORT_PARAMS,
	type Rgb,
	effortUniforms,
	fillEnd,
	isLight,
	parseColor,
	renderPath,
	shouldAnimate,
	stepToward,
} from './effort-shader-core.js'

const VERT = `#version 300 es
void main() {
	vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
	gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

/** Bayer 8x8 ordered dither over drifting noise, sparkles, a thumb bloom and an idle shimmer past the thumb. */
const FRAG = `#version 300 es
precision highp float;
uniform vec2 u_res;
uniform float u_dpr, u_time, u_end, u_pad, u_level, u_vis, u_light;
uniform float u_cell, u_drift, u_sparkle, u_rise, u_bloom, u_sigma, u_warm;
uniform vec3 u_accent, u_deep, u_teal, u_hot, u_fringe;
out vec4 o;
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
	vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
	return mix(mix(hash(i), hash(i + vec2(1,0)), f.x), mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x), f.y);
}
float bayer8(ivec2 c) {
	int x = c.x & 7, y = c.y & 7, xy = x ^ y;
	int v = ((xy & 1) << 5) | ((y & 1) << 4) | (((xy >> 1) & 1) << 3) | (((y >> 1) & 1) << 2) | (((xy >> 2) & 1) << 1) | ((y >> 2) & 1);
	return (float(v) + .5) / 64.;
}
vec3 ramp(float t) {
	vec3 c = mix(u_deep, u_teal, smoothstep(0., .42, t));
	c = mix(c, u_accent, smoothstep(.3, .74, t));
	return mix(c, u_hot, smoothstep(.62, 1., t) * u_warm);
}
void main() {
	vec2 px = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y);
	float cell = max(1., floor(u_cell * u_dpr + .5));
	vec2 c = floor(px / cell);
	vec2 cc = (c + .5) * cell;
	float trackW = u_res.x - 2. * u_pad;
	float t = clamp((cc.x - u_pad) / trackW, 0., 1.);
	float f = clamp(cc.x / max(u_end, 1.), 0., 1.);
	float L = u_level;
	float time = u_time;
	bool light = u_light > .5;
	// A slow band drifts right; the drift is calm at low levels and quickens with the level.
	float band = sin((cc.x * .9 + cc.y * 2.2) / (u_dpr * 22.) - time * u_drift * 3.) * .5 + .5;
	float n = vnoise(vec2(c.x * .06 - time * u_drift * 1.6, c.y * .35 + time * u_drift * .5));
	// Density climbs along the fill (t^1.5): sparse at the left, dense at the thumb.
	float dens = (.14 + .62 * pow(f, 1.5)) * (.5 + .7 * L) + (band - .5) * .2 * (.5 + L) + (n - .5) * .26;
	dens = min(dens, .82);
	float on = step(bayer8(ivec2(c)), dens);
	vec3 col = ramp(mix(t, f, .45 * L));
	vec3 lit = col * (light ? 1.06 : 1.06) + (light ? 0. : .03);
	// Light theme: the off cells are a pale tint of the colour, not grey.
	vec3 dim = light ? mix(col, vec3(1.), .62) : col * .42;
	vec3 rgb = mix(dim, lit, on);
	float inside = step(cc.x, u_end) * u_vis;
	// Sparkles rise and twinkle.
	float ry = c.y + time * u_rise;
	float sid = hash(vec2(c.x, floor(ry)));
	float sd = u_sparkle * (.4 + 1.6 * f * f);
	float tw = pow(max(sin(time * (2.2 + 4. * sid) + sid * 40.), 0.), 3.);
	float sp = step(1. - sd, sid) * (.35 + .65 * tw);
	vec3 sparkCol = mix(col, vec3(1.), light ? .88 : .8);
	rgb = mix(rgb, sparkCol, sp);
	// Bloom at the thumb: a soft fringe behind, a hot core ahead, both shaped by a dithered rim.
	float dx = px.x - u_end;
	float dy = px.y - u_res.y * .5;
	float s = u_sigma * u_dpr;
	float gy = exp(-dy * dy / (2. * s * s * 1.1));
	float gb = exp(-pow(dx + .35 * s, 2.) / (2. * s * s)) * gy;
	float ga = exp(-pow(dx - .25 * s, 2.) / (2. * s * s * .8)) * gy;
	float pulse = .85 + .15 * sin(time * 1.6);
	float bk = u_bloom * pulse * u_vis;
	float b = clamp((gb * .7 + ga) * bk, 0., 1.);
	float rim = step(bayer8(ivec2(c) + 3), b * .9 - .06);
	vec3 bloomCol = mix(u_fringe, u_hot, smoothstep(-.4 * s, .5 * s, dx)) ;
	bloomCol = light ? mix(bloomCol, u_accent, .35) : bloomCol;
	float inner = clamp(b * (light ? .5 : .32), 0., .6) * inside;
	rgb = mix(rgb, bloomCol, inner);
	float outA = inside;
	vec3 outRgb = rgb * inside;
	float spill = (1. - step(cc.x, u_end)) * u_vis;
	float rimA = spill * (rim * .85);
	outRgb = outRgb + bloomCol * rimA * (1. - outA);
	outA = max(outA, rimA);
	// Idle shimmer past the thumb: a faint dithered gradient so low is never empty.
	float idle = (1. - step(cc.x, u_end)) * u_vis * (1. - step(.5, rimA));
	float idens = (.05 + .12 * t) * (.6 + .4 * sin(time * .5 + cc.x * .03 / u_dpr + n * 4.));
	float ion = step(bayer8(ivec2(c) + 5), idens) * idle;
	float ia = ion * (light ? .2 : .16);
	outRgb = outRgb + u_accent * ia * (1. - outA);
	outA = max(outA, ia);
	o = vec4(min(outRgb, vec3(outA)), outA);
}`

export interface EffortShaderTarget {
	/** 0..1 along the track. */
	progress: number
	/** 0..1 across the levels offered. */
	level: number
	visible: boolean
}

const UNIFORMS = [
	'u_res',
	'u_dpr',
	'u_time',
	'u_end',
	'u_pad',
	'u_level',
	'u_vis',
	'u_light',
	'u_cell',
	'u_drift',
	'u_sparkle',
	'u_rise',
	'u_bloom',
	'u_sigma',
	'u_accent',
	'u_warm',
	'u_deep',
	'u_teal',
	'u_hot',
	'u_fringe',
] as const

const PAD_CSS = 13

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
	const shader = gl.createShader(type)
	if (!shader) return null
	gl.shaderSource(shader, src)
	gl.compileShader(shader)
	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
		gl.deleteShader(shader)
		return null
	}
	return shader
}

/** Builds the program on `canvas`; null when WebGL2 or the shader is unavailable. */
function createRenderer(canvas: HTMLCanvasElement) {
	const gl = canvas.getContext('webgl2', {
		alpha: true,
		premultipliedAlpha: true,
		antialias: false,
		powerPreference: 'low-power',
	})
	if (!gl) return null
	const vs = compile(gl, gl.VERTEX_SHADER, VERT)
	const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG)
	const program = gl.createProgram()
	if (!vs || !fs || !program) return null
	gl.attachShader(program, vs)
	gl.attachShader(program, fs)
	gl.linkProgram(program)
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null
	gl.deleteShader(vs)
	gl.deleteShader(fs)
	gl.useProgram(program)
	const vao = gl.createVertexArray()
	gl.bindVertexArray(vao)
	const u = {} as Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>
	for (const name of UNIFORMS) u[name] = gl.getUniformLocation(program, name)
	gl.enable(gl.BLEND)
	gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
	return {
		gl,
		draw(state: {
			dpr: number
			time: number
			progress: number
			level: number
			vis: number
			light: boolean
			accent: Rgb
			deep: Rgb
			teal: Rgb
			hot: Rgb
			fringe: Rgb
		}) {
			const { width, height } = canvas
			gl.viewport(0, 0, width, height)
			gl.clearColor(0, 0, 0, 0)
			gl.clear(gl.COLOR_BUFFER_BIT)
			const P = EFFORT_PARAMS
			const U = effortUniforms(state.level)
			gl.uniform2f(u.u_res, width, height)
			gl.uniform1f(u.u_dpr, state.dpr)
			gl.uniform1f(u.u_time, state.time)
			gl.uniform1f(u.u_pad, PAD_CSS * state.dpr)
			gl.uniform1f(u.u_end, fillEnd(width, PAD_CSS * state.dpr, state.progress))
			gl.uniform1f(u.u_level, state.level)
			gl.uniform1f(u.u_vis, state.vis)
			gl.uniform1f(u.u_light, state.light ? 1 : 0)
			gl.uniform1f(u.u_cell, P.cellPx)
			gl.uniform1f(u.u_drift, U.drift)
			gl.uniform1f(u.u_sparkle, U.sparkle)
			gl.uniform1f(u.u_rise, U.rise)
			gl.uniform1f(u.u_bloom, U.bloom)
			gl.uniform1f(u.u_sigma, P.bloomSigmaPx)
			gl.uniform1f(u.u_warm, U.warmth)
			gl.uniform3f(u.u_accent, ...state.accent)
			gl.uniform3f(u.u_deep, ...state.deep)
			gl.uniform3f(u.u_teal, ...state.teal)
			gl.uniform3f(u.u_hot, ...state.hot)
			gl.uniform3f(u.u_fringe, ...state.fringe)
			gl.drawArrays(gl.TRIANGLES, 0, 3)
		},
		dispose() {
			gl.deleteProgram(program)
			gl.deleteVertexArray(vao)
			gl.getExtension('WEBGL_lose_context')?.loseContext()
		},
	}
}

/**
 * A living dithered surface behind the thumb. It fills the slider control (the track plus the
 * padding either side) and is transparent past the thumb, so it adds no layout. `onDraw` reports
 * whether the first frame landed, so the CSS fill can step aside only then.
 */
export function EffortShader({
	progress,
	level,
	visible,
	onReady,
}: EffortShaderTarget & { onReady: (ready: boolean) => void }) {
	const host = useRef<HTMLSpanElement>(null)
	const target = useRef<EffortShaderTarget>({ progress, level, visible })
	target.current = { progress, level, visible }
	const redraw = useRef<(() => void) | null>(null)
	const onReadyRef = useRef(onReady)
	onReadyRef.current = onReady

	useEffect(() => {
		const mount = host.current
		if (!mount) return
		// A fresh canvas per run: a lost context cannot be re-acquired on the same element, and
		// a remount (StrictMode, reopened panel) must not inherit one.
		const el = document.createElement('canvas')
		el.style.cssText = 'display:block;width:100%;height:100%'
		mount.appendChild(el)
		const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
		let renderer = createRenderer(el)
		if (!renderer) {
			el.remove()
			return
		}
		let raf = 0
		let last = 0
		let time = 0
		let drawn = false
		const cur = { ...target.current, vis: target.current.visible ? 1 : 0 }
		let theme = readTheme(el)
		let lost = false
		const size = () => {
			const dpr = Math.min(window.devicePixelRatio || 1, 2)
			const w = Math.max(1, Math.round(el.clientWidth * dpr))
			const h = Math.max(1, Math.round(el.clientHeight * dpr))
			if (el.width !== w || el.height !== h) {
				el.width = w
				el.height = h
			}
			return dpr
		}
		const frame = (now: number) => {
			raf = 0
			if (!renderer) return
			const path = renderPath({ webgl: true, contextLost: lost, reducedMotion: reduced.matches })
			const snap = path === 'static'
			const dt = last ? Math.min(now - last, 100) : 16
			last = now
			const t = target.current
			if (snap) {
				cur.progress = t.progress
				cur.level = t.level
				cur.vis = t.visible ? 1 : 0
				time = EFFORT_PARAMS.staticTime
			} else {
				cur.progress = stepToward(cur.progress, t.progress, dt, EFFORT_PARAMS.easeProgressMs)
				cur.level = stepToward(cur.level, t.level, dt, EFFORT_PARAMS.easeLevelMs)
				cur.vis = stepToward(cur.vis, t.visible ? 1 : 0, dt, EFFORT_PARAMS.easeVisibleMs)
				time += dt / 1000
			}
			const dpr = size()
			renderer.draw({
				dpr,
				time,
				progress: cur.progress,
				level: cur.level,
				vis: cur.vis,
				light: theme.light,
				...theme.colors,
			})
			if (!drawn) {
				drawn = true
				onReadyRef.current(true)
			}
			const settled =
				cur.progress === t.progress && cur.level === t.level && cur.vis === (t.visible ? 1 : 0)
			if (shouldAnimate({ active: true, reducedMotion: snap, hidden: document.hidden })) {
				raf = requestAnimationFrame(frame)
			} else if (!settled) raf = requestAnimationFrame(frame)
		}
		const kick = () => {
			if (raf || !renderer) return
			last = 0
			raf = requestAnimationFrame(frame)
		}
		redraw.current = () => kick()
		// The colours are read once and again only when the theme or accent changes.
		const themeWatch = new MutationObserver(() => {
			theme = readTheme(el)
			kick()
		})
		themeWatch.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['class', 'style', 'data-theme'],
		})
		const onVisibility = () => {
			if (document.hidden) {
				cancelAnimationFrame(raf)
				raf = 0
			} else kick()
		}
		const onLost = (event: Event) => {
			event.preventDefault()
			cancelAnimationFrame(raf)
			raf = 0
			drawn = false
			lost = true
			renderer = null
			onReadyRef.current(false)
		}
		const onRestored = () => {
			renderer = createRenderer(el)
			lost = renderer === null
			if (renderer) kick()
		}
		const onMotion = () => kick()
		const resize = new ResizeObserver(kick)
		resize.observe(el)
		document.addEventListener('visibilitychange', onVisibility)
		el.addEventListener('webglcontextlost', onLost)
		el.addEventListener('webglcontextrestored', onRestored)
		reduced.addEventListener('change', onMotion)
		kick()
		return () => {
			cancelAnimationFrame(raf)
			resize.disconnect()
			themeWatch.disconnect()
			document.removeEventListener('visibilitychange', onVisibility)
			el.removeEventListener('webglcontextlost', onLost)
			el.removeEventListener('webglcontextrestored', onRestored)
			reduced.removeEventListener('change', onMotion)
			redraw.current = null
			renderer?.dispose()
			renderer = null
			el.remove()
			onReadyRef.current(false)
		}
	}, [])

	// A new target wakes a loop that had settled (reduced motion, or a hidden document).
	// biome-ignore lint/correctness/useExhaustiveDependencies: the values are the trigger
	useEffect(() => {
		redraw.current?.()
	}, [progress, level, visible])

	return <span ref={host} className="composer-effort-shader" aria-hidden="true" />
}

function readTheme(el: HTMLElement) {
	const style = getComputedStyle(el)
	const probe = (name: string) => {
		const raw = style.getPropertyValue(name).trim()
		if (!raw) return null
		const span = document.createElement('span')
		span.style.color = raw
		el.appendChild(span)
		const resolved = getComputedStyle(span).color
		span.remove()
		return parseColor(resolved) ?? parseColor(raw)
	}
	const light = isLight(probe('--popover') ?? [0.1, 0.1, 0.1])
	const accent = probe('--primary') ?? (light ? [0.09, 0.42, 0.16] : [0.37, 1, 0.37])
	const palette = light ? EFFORT_PALETTE.light : EFFORT_PALETTE.dark
	return {
		light,
		colors: {
			accent,
			deep: palette.deep,
			teal: palette.teal,
			hot: palette.hot,
			fringe: palette.fringe,
		},
	}
}
