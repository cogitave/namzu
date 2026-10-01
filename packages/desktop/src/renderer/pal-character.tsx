import { useId } from 'react'
import './pal-character.css'

export type PalCharacterAppearance = {
	character: 'pixel' | 'sprout' | 'spark'
	color: 'green' | 'blue' | 'amber' | 'violet' | 'rose'
}

export const defaultPalAppearance: PalCharacterAppearance = { character: 'pixel', color: 'green' }
export const palColors = [
	{ id: 'green', label: 'Green', light: '#a2ff91', base: '#62e96e', dark: '#228b42' },
	{ id: 'blue', label: 'Blue', light: '#a0e7ff', base: '#50b8f3', dark: '#2464ad' },
	{ id: 'amber', label: 'Amber', light: '#fff4a5', base: '#ffcf54', dark: '#b87621' },
	{ id: 'violet', label: 'Violet', light: '#efb3ff', base: '#c17dec', dark: '#7044a9' },
	{ id: 'rose', label: 'Rose', light: '#ffbdd9', base: '#f786b2', dark: '#af3d75' },
] as const
export const palCharacters = [
	{ id: 'pixel', label: 'Pixel' },
	{ id: 'sprout', label: 'Sprout' },
	{ id: 'spark', label: 'Spark' },
] as const

const bodies: Record<PalCharacterAppearance['character'], string> = {
	pixel: 'M48 36H112V44H124V56H132V120H124V132H112V140H48V132H36V120H28V56H36V44H48Z',
	sprout:
		'M64 40H96V48H108V60H116V76H128V116H120V132H108V140H52V132H40V116H32V92H40V76H48V60H56V48H64Z',
	spark:
		'M72 28H88V44H100V56H120V68H140V84H128V100H116V124H100V140H84V128H72V140H56V124H44V100H32V84H20V68H44V56H60V44H72Z',
}

/** Original Namzu character. SVG scales cleanly from a sidebar icon to the live preview. */
export function PalCharacter({
	appearance = defaultPalAppearance,
	size = 'avatar',
	paused = false,
}: {
	appearance?: PalCharacterAppearance
	size?: 'compact' | 'avatar' | 'choice' | 'hero'
	paused?: boolean
}) {
	const id = useId().replace(/:/gu, '')
	const color = palColors.find((item) => item.id === appearance.color) ?? palColors[0]
	return (
		<span
			className={`pal-character pal-character-${size}`}
			data-paused={paused || undefined}
			aria-hidden="true"
		>
			<svg className="size-full" viewBox="0 0 160 180" fill="none" aria-hidden="true">
				<defs>
					<linearGradient
						id={`${id}-body`}
						x1="38"
						y1="40"
						x2="120"
						y2="140"
						gradientUnits="userSpaceOnUse"
					>
						<stop stopColor={color.light} />
						<stop offset="0.45" stopColor={color.base} />
						<stop offset="1" stopColor={color.dark} />
					</linearGradient>
					<radialGradient id={`${id}-eye`} cx="0.35" cy="0.25" r="0.85">
						<stop stopColor="#344b3e" />
						<stop offset="1" stopColor="#0b1711" />
					</radialGradient>
					<clipPath id={`${id}-clip`}>
						<path d={bodies[appearance.character] ?? bodies.pixel} />
					</clipPath>
				</defs>
				<ellipse
					className="pal-character-shadow"
					cx="80"
					cy="161"
					rx="43"
					ry="6"
					fill="currentColor"
					opacity="0.12"
				/>
				<g className="pal-character-body">
					<path d="M47 133H63V153H43V143H47ZM98 133H114V143H118V153H98Z" fill={color.dark} />
					{appearance.character === 'sprout' && (
						<g className="pal-character-leaf">
							<path
								d="M80 43V24H65V15H49V25H57V35H72V43ZM81 28V15H95V8H111V19H101V28Z"
								fill={color.base}
							/>
							<path d="M80 44V28H95" stroke={color.dark} strokeWidth="5" />
						</g>
					)}
					<path d={bodies[appearance.character] ?? bodies.pixel} fill={`url(#${id}-body)`} />
					<g clipPath={`url(#${id}-clip)`}>
						<path
							d="M28 61V124H38V134H49V144H118V135H130V124H137V111H120V126H48V116H38V61Z"
							fill={color.dark}
							opacity="0.27"
						/>
						<path d="M40 56H48V47H111V53H48V70H40Z" fill="white" opacity="0.26" />
						{[
							[46, 61],
							[113, 55],
							[37, 101],
							[113, 115],
							[98, 129],
							[54, 124],
						].map(([x, y]) => (
							<rect
								key={`${x}:${y}`}
								x={x}
								y={y}
								width="5"
								height="5"
								fill={color.light}
								opacity="0.2"
							/>
						))}
					</g>
					<g className="pal-character-face">
						<g className="pal-character-eyes">
							<rect x="53" y="72" width="16" height="23" rx="8" fill={`url(#${id}-eye)`} />
							<rect x="91" y="72" width="16" height="23" rx="8" fill={`url(#${id}-eye)`} />
							<g className="pal-character-glints">
								<circle cx="59" cy="78" r="3" fill="white" opacity="0.8" />
								<circle cx="97" cy="78" r="3" fill="white" opacity="0.8" />
							</g>
						</g>
						<path
							d="M71 107V112H89V107"
							stroke="#163723"
							strokeWidth="4"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
						<rect x="44" y="101" width="10" height="5" rx="2.5" fill={color.dark} opacity="0.25" />
						<rect x="108" y="101" width="10" height="5" rx="2.5" fill={color.dark} opacity="0.25" />
					</g>
				</g>
			</svg>
		</span>
	)
}
