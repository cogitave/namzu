// The benchmark's task list. `site: true` tasks run against the local bench site (scored from the
// server's event log); the others read public pages and are scored from the final answer only.
// `answer` holds regular expressions the final answer must all match (a rough check; the server
// score is the real one wherever there is one).
// The public pages change: each carries the date its expected values were checked.
export const TASKS = {
	A2: { file: 'a2.txt', site: true, answer: [/\$?\s?42\b/, /T-9F2A/], stepsFromAnswer: ['read-price'] },
	S: { file: 's.txt', site: true, answer: [/teal/i] },
	H: { file: 'h.txt', site: true, answer: [/archive/i] },
	E: { file: 'e.txt', site: true, answer: [/clos/i] },
	K: { file: 'k.txt', site: true, answer: [/subscribed/i] },
	D: { file: 'd.txt', site: true, answer: [/lisbon/i] },
	L: { file: 'l.txt', site: true, answer: [/downloaded/i] },
	F: { file: 'f.txt', site: true, answer: [/hello/i] },
	SH: { file: 'sh.txt', site: true, answer: [/went/i] },
	T: { file: 't.txt', site: true, answer: [/finished/i] },
	// herokuapp pages, checked 2026-11-15: checkboxes start 1 unchecked, 2 checked; dropdown has Option 1 and Option 2.
	B2: { file: 'b2.txt', site: false, answer: [/option 2/i] },
	// Wikipedia, checked 2026-11-15: the Lighthouse of Alexandria infobox gives 100 m or more and a 280 BC date; the Eiffel Tower opened 31 March 1889.
	C: { file: 'c.txt', site: false, answer: [/alexandria/i, /\b(1\d\d|2\d\d)\s?(m|metres|meters)\b|\b\d{2,3}\s?(m|metres|meters)\b/i] },
	C2: { file: 'c2.txt', site: false, answer: [/1889/, /\b(300|330|324|33\d)\b/] },
}

export const MODELS = {
	haiku: 'anthropic/claude-haiku-5.5',
	deepseek: 'deepseek/deepseek-v4.1-flash-1017',
}
