---
'@namzu/cli': minor
---

The provider picker lists every provider you can set up, not only the ones it
detected on this machine.

The gap was reported from a session where it cost something: the saved provider
was OpenRouter, the picker drew the four providers discovery had found, and
OpenRouter was not among them — so there was no row to select and therefore no
way to type the key that was already in hand. A list assembled from `detected`
cannot name a provider `detected` does not mention, whatever the operator is
holding.

Detected rows are untouched: same order, same numbering, same source column
(`Claude session · this device`), same place at the top, and the header's count
still counts exactly what it counted before. Below them, under `Not detected —
enter a credential to use these:`, come every provider this build can construct
that takes a typed credential — `anthropic`, `google`, `openai`, `deepseek`,
`openrouter`, `zen`, `zen-go` — each marked with the environment variable that
sets it up (`needs OPENROUTER_API_KEY`), because that variable is both what
makes the provider work now and what keeps it working after a restart.

Enter on one of those rows opens the paste field for that provider, and `k`
follows the highlighted row instead of a fixed choice in the registry. Where the
row takes no typed credential — a local server, or a provider that signs in —
`k` still falls back to the provider the picker was opened for, which is the
saved one whose key is missing, so the route the notice above the list
advertises is unchanged. A typed credential is still held for the session and
written nowhere; nothing about how a credential is resolved at run time changed,
and no config key was added.

**What moves, and why it is not a patch.** The footer now names a provider only
when `k` reaches past the highlighted row to the one the picker was opened for.
With the cursor on the row the key will act on, the line reads `k enter a
credential`; the label returns as `k enter a credential for <provider>` exactly
when the two differ. That is shorter than the sentence it replaces — long enough
to wrap and lose its tail on a 100-column terminal — but it is a change to a
line a script or a reader may have matched, which is why this is `minor` rather
than `patch`. Two smaller consequences, both stated because they are visible:
the list is longer, so a machine with seven of these rows draws a taller screen,
and the digit shortcut still reaches the first nine rows only (a tenth needs two
keystrokes, and two keystrokes cannot be told from two presses without a timer),
which the screen now says out loud when the list passes nine.

Five registry entries are deliberately not offered there, because a row that
leads nowhere is worse than an absent one. `bedrock` needs an AWS credential
chain rather than one string; `http` is an endpoint whose base URL is half the
credential; `lmstudio` has no driver in this build; `ollama` needs a running
server, which is how discovery finds it; and `codex` is a device-code sign-in
this screen already offers with `l`, so it is not set up two ways.
`provider-list.test.ts` asserts that omission list by name, so flipping a
registry flag turns it red rather than quietly adding or dropping a row.

One defect was found in this screen while building it and is fixed here: the
cursor is an index into whichever list the screen is drawing, and the sign-in
screen draws three rows while the provider list draws more. With a saved
preference naming `openai` and a Codex device session detected, `/login` opened
with `openai` resolved against the provider list — row four — and read against
the sign-in list, so no row was highlighted and Enter did nothing at all.
