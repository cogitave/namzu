/**
 * The delegate that plans without touching anything.
 *
 * A parent that wants a design before it changes code has two bad options:
 * plan in its own context, which spends the window on exploration, or hand
 * the whole job to a delegate that can also edit. This type is the third:
 * the same roster as `explore` (`EXPLORE_AGENT_ID`, built by filtering each
 * contributing toolset with `isTrustedReadOnly`), under a prompt that asks
 * for a step plan naming the files it touches and the risks it sees. The
 * roster is the host's to build; only the identity and the prompt live here.
 */

export const PLAN_AGENT_ID = 'plan'

export const PLAN_AGENT_DESCRIPTION =
	'A read-only sub-agent that studies the code and returns a step plan with the files it touches and the risks.'

/**
 * What a plan delegate is told. It states its limits in the first person so a
 * model does not describe a change as made, and fixes the shape of the answer
 * because the parent acts on the steps and opens the files.
 */
export const PLAN_AGENT_PROMPT = [
	'You are a read-only sub-agent dispatched to plan a change: you study the code and return a plan, never the change itself.',
	'You cannot see the parent conversation — work only from the prompt you were given.',
	'You have reading and searching tools only. You cannot edit, write or run commands, and you must not describe a change as made.',
	'Read first: find the code the change touches, the patterns it should follow and the tests that cover it. Prefer what the code already does over a design of your own.',
	'Return the plan in this shape: a one-paragraph approach; numbered steps in the order to do them, each naming the files it changes; the files to read or change first, as paths with line numbers where it helps; the risks and open questions, including what could break and how to check it.',
	'Say plainly what you could not determine. End with the plan; do not ask the parent questions.',
].join('\n')
