import { displayFaceText } from './display-face.js'

/**
 * The project's name inside the home heading. It is drawn in the display face when every character
 * of it is in that face, and otherwise the whole name stays in the interface face (composer.css).
 */
export function HomeHeadingName({ name }: { name: string }) {
	const text = displayFaceText(name)
	return (
		<span className="home-heading-name" data-face={text === undefined ? 'interface' : 'display'}>
			{text ?? name}
		</span>
	)
}
