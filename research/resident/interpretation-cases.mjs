// Synthetic, deterministic observations. Expectations are never sent to the model.
export const objective =
	'Review the Cedar and Juniper delivery records in routing.txt. Retain observations across steps, then answer the operator’s follow-up question. Only read and analyse; do not change files, run commands, delegate, or contact anyone. Once the follow-up is answered, complete the review.'

export const versions = [
	'Cedar delivery routing code: CD-1472.\nJuniper delivery routing code: JP-6381.\n',
	'Cedar delivery routing code: CD-2859.\nJuniper delivery routing code: JP-7406.\n',
	'Cedar delivery routing code: CD-3964.\nJuniper delivery routing code: JP-8527.\n',
]

export const correction =
	'Both Cedar and Juniper entries in routing.txt were corrected. Read the changed document, retain the observations, and wait for my follow-up.'

export const summaries = [
	'Read routing.txt for the Cedar and Juniper deliveries. Their routing codes were observed. Await the correction review.',
	'Reviewed the corrected Cedar and Juniper delivery entries in routing.txt. Both have retained tool observations. Await the operator’s follow-up.',
]

export const cases = [
	{
		id: 'explicit-original',
		heldOut: false,
		wakes: ['What was Cedar’s routing code in the first document you read, before the correction?'],
		expected: {
			required: ['CD-1472'],
			forbidden: ['CD-2859', 'CD-3964'],
			freshRead: false,
			disposition: 'complete',
		},
	},
	{
		id: 'implicit-current',
		wakes: ['Let’s focus on Cedar’s routing code.', 'And now?'],
		expected: { required: ['CD-3964'], forbidden: [], freshRead: true, disposition: 'complete' },
	},
	{
		id: 'ambiguous-original',
		wakes: ['What was its routing code in the first document you read?'],
		// A labelled answer for each alternative is also acceptable: evaluate the
		// exact prose separately. A single unqualified choice is not acceptable.
		expected: { alternatives: ['CD-1472', 'JP-6381'], freshRead: false, ambiguity: true },
	},
	{
		id: 'corrected-reference',
		wakes: [
			'Tell me about Cedar’s routing code.',
			'I meant Juniper, not Cedar. What did you first read for it, and what is it now?',
		],
		expected: {
			required: ['JP-6381', 'JP-8527'],
			forbidden: ['CD-1472', 'CD-3964'],
			freshRead: true,
			disposition: 'complete',
		},
	},
	{
		id: 'unavailable-current',
		wakes: ['Let’s focus on Juniper’s routing code.', 'And now?'],
		removeCurrent: true,
		expected: { forbidden: ['JP-8527'], freshRead: true, unavailable: true },
	},
	{
		id: 'turkish-current',
		heldOut: true,
		wakes: ['Juniper kaydını soruyorum. Bugün dosyada hangi yönlendirme kodu yazıyor?'],
		expected: { required: ['JP-8527'], freshRead: true, disposition: 'complete' },
	},
	{
		id: 'turkish-ambiguous',
		heldOut: true,
		wakes: ['İki kaydı da incelemiştin. Bunun ilk gördüğün yönlendirme kodu neydi?'],
		expected: { alternatives: ['CD-1472', 'JP-6381'], freshRead: false, ambiguity: true },
	},
]
