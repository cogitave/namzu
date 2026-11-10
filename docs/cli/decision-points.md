---
type: Guide
title: Decision points
description: "decision.points: the places the CLI can ask the decision model a question beside its own rule, the off, shadow and on modes, the points (notify, memory, skill, pick), what is sent and what the decision log holds."
resource: packages/cli/src/integrations/decision/points.ts
tags: [cli, config, decision]
---

# Decision points

A decision point is one named yes/no question the CLI already answers with a rule.
With a [decision model](../sdk/decision.md) configured, the CLI can ask the model the
same question beside the rule. The model is advisory: a point never makes a turn fail
or wait, and with no answer in time the rule decides, as it did before.

```yaml
decision:
  provider: azure
  endpoint: https://<resource>.services.ai.azure.com
  deployment: <deployment>
  points:
    notify: shadow
```

`decision` is read only from your user and managed config, never from a project's file.

## Connecting a decision model

You do not have to write that block. After you pick a model (at first start and with `/model`), Namzu
asks once: "Use a decision model to make Namzu's small decisions more accurate?" with Yes, Not now and
Don't ask again. Not now asks again after a later model pick, at most once a day; Don't ask again never
asks again (the answer is kept in `<NAMZU_HOME>/decision-offer.json`). Nothing is asked while a decision
model is configured, or while `NAMZU_NO_DECISION=1`.

Yes opens a short flow in which you connect whatever you want; Namzu has no decision service of its own
and sends nothing anywhere until you connect one:

- **Azure AI Foundry**: one field takes the portal's "Keys and Endpoint" text as it copies, or the endpoint
  and key one at a time. The endpoint (`https://<resource>.services.ai.azure.com` or
  `https://<resource>.cognitiveservices.azure.com`) and the key are picked out of it; key 1 is used when
  both are pasted. A target URI that carries `/deployments/<name>/` gives the deployment too. Otherwise Namzu
  asks the resource which deployments it has, using the key, and asks you for the name only when the
  resource does not say. Leave the key empty to use your Azure sign-in (see
  [the SDK page](../sdk/decision.md#signing-in-with-azure-instead-of-a-key)).
- **My own server (HTTP)**: the address, an optional key (a local server is often keyless) and an optional
  model name.

Namzu then saves the connection and tests it with one cheap yes/no call that has three seconds to answer,
and prints `Connected · 180 ms` or the plain reason it could not. The test runs even if the connection is
wrong, so a typo is found while you are still looking at it.

Where things go: the address, deployment and model are written to the `decision` block of your user
`config.yaml` (and kept in `<NAMZU_HOME>/decision-connection.json`). The key goes to the private
credential store (`api-keys.json`, under the id `decision`, with the same owner-only protection as a provider
key) and never to a config file or the log. A variable the config names (`apiKeyEnv`, `tokenEnv`) still wins
over the saved key. `/status` shows one line, `Decision`: `Not connected`, `Off (NAMZU_NO_DECISION)`, or
`Connected` with the points that are on.

**The points start as** `notify: on`, `skill: on`, `memory: shadow`, `pick: shadow`. A point is `on` at the
start only where its worst case is small: a missed chime (`notify` never mutes a stop, a failure or an
approval) or a withdrawn skill proposal (`skill` can only withdraw a proposal the rule already made). `memory`
can keep a memory out of the store and `pick` can press a control through `ui_do`, so they only record, in
[the log](#the-log), until you have read it and set them to `on`. Edit `points` in the config to change any of
them; `off` stops the question.

`decision: true` is the shorthand: it means "use the decision model I connected", with those points. If
nothing is connected yet, the terminal shows the connect flow once when it starts. It is read only from your
user config (a project file, the git-ignored local file and the managed file cannot say it), and the full
`decision` block keeps working unchanged and wins when it is there. A connected model starts working in the
running session for the points at once; the `decide` tool joins the next conversation.

Each point has a one-word name: `notify` (is a finished reply worth a chime), `memory` (is what a turn learned worth
remembering), `skill` (is a turn worth proposing as a skill) and `pick` (which control on the screen does an action
name; a choice among controls, not a yes/no). The names they were released under
(`notify-worthy`, `memory-admit`, `skill-worthy`) are still read and mean the same points; use the one-word
names, and a point named both ways is refused.

Everything here is a choice you make. With no `decision` block there is no model and
nothing is asked; with one, a point you do not name is `off`; and `NAMZU_NO_DECISION=1`
in the environment turns every use of the decision model off at once (these points, `model:
auto` routing and the `decide` tool), whatever the config says.

## Modes

| Mode | What happens |
|---|---|
| `off` | Nothing is asked. This is every point's mode until you name it, because a question carries text of the conversation to the decision service. |
| `shadow` | The model is asked and its answer is written to the log beside what the rule decided. Nothing else changes. This is how a point earns trust. |
| `on` | A confident answer (`P(true)` of 0.7 or more, or 0.3 or less) decides; anything else is the rule. |

A question is cut short, has its control characters removed, and is answered inside
1.5 seconds, or not at all.

## `notify`

Is this finished reply worth calling you back for? The rule is the length of the turn:
a turn that ran ten seconds or more ends with the [chime](terminal-design.md#the-turn-chime),
a shorter one is silent. Length says nothing about what the reply is: a four-second
answer that stops to ask which of two things to do is silent, and a long turn that ends
in "done" rings. With the point `on`, the model reads the last 1,200 characters of the
reply and a confident yes sounds a short reply, a confident no mutes a long one. A stop,
a failure and an approval always sound, whatever the model says. The reply tail is the
only text that leaves the machine.

## `memory`

Is what this turn learned worth remembering? A turn whose compaction pass extracted a
claim leaves screened claims for [the memory curator](memory.md#how-what-turns-learn-is-curated),
and a store of whatever a turn happened to learn fills with routine progress and facts the
code already states, which the model then reads on every search. With the point `on`, the
decision model reads the task and the screened claims (requirements, decisions, discoveries,
failures, environment) as the turn is released, and a confident no (`P(true)` of 0.3 or
less) keeps them out of the curator's inbox; anything else, a failure included, passes them
on. The question is asked in the turn's release step, so it can delay the end of the turn by
up to its timeout, unlike the curator itself, which runs off the turn. A turn with no claim
asks nothing. The claims are the text that leaves the machine; file paths are not sent. With
`memory.curation: off` the point works as it did, gating the write at settle.

## `skill`

Is this finished turn a procedure worth saving as a skill? The rule looks at the turn's
shape (six successful tool calls, two distinct tools, a clean tail) and cannot tell a
routine you will want again from a one-off that happened to take six calls. With the point
`on`, a proposal the rule already made is put to the decision model, and a confident no
(`P(true)` of 0.3 or less) withdraws it. The model never creates a proposal the rule did not
make, and nothing is saved either way. What is sent is your request (cut at 600
characters) and the names of the tools used; no tool arguments, results or file contents.

## `pick`

Which control does this action name? The computer tool acts on a control by the ref the model read in
a `ui_snapshot`. Choosing the ref is a model round trip over a long tree; a decision model can choose
among the controls in a few hundred milliseconds. Unlike the points above, this is a choice among up to
255 controls rather than a yes/no, and there is no rule of the host's to fall back on, so the two modes
differ in what they do:

- `shadow`: the tool offers `ui_act` an optional `intent` (a few words on what the action is for). When the
  model passes one, the decision model is asked, beside the action and without delaying it, which of the
  window's controls the intent names, and the log records the probability it gave the control the model
  chose and whether its top choice was the same one. Nothing the model does changes.
- `on`: as `shadow`, and the tool also offers `ui_do { target, action, value, window_id }`, which names a
  control in words ("the Save button"). The decision model chooses it from the controls of the latest
  `ui_snapshot` that offer the action, and the tool acts only when the best control has a probability of
  0.85 or more and leads the next one by 0.4 or more. Otherwise it acts on nothing and lists the closest
  controls, so the model uses `ui_act` on one of them. The result says which control it chose and how sure
  the decision model was.

A permission prompt for `ui_do` cannot name the control, since the tool has not chosen it yet; it reads
"Press the control for "the Save button"", the same level of detail a coordinate click gives.

What is sent: the intent (cut at 200 characters) and the controls to choose among, each as its ref, kind and
name (cut at 120). They are the application's own text, which is why the point is off until you name it. No
screenshot, no typed value and no other window content leaves the machine. The log's line for a choice also
holds `options` (how many controls were put to the model) and `agreed` (shadow only).

It applies to the desktop of the session you run, not to a Pal's virtual computer.

The threshold is higher than the 0.7 of the yes/no points on purpose. Run against the live service on windows of
5 and 90 controls, the right control came back at 0.94 to 1.00 every time, while a request that matched nothing
("launch the rocket") still put 0.70 on its nearest control; 0.85 acts on the first and holds on the second.
With 255 controls, many of them near-duplicates, the best control got 0.56 to 0.59 and the tool held, as it should.

## The log

Every question is one line of `<NAMZU_HOME>/decision/points.jsonl` (rotated at a
megabyte): the time, the point, the mode, `p`, what the rule decided, how long the call
took, how it ended (`answered`, `timeout`, `error`) and the size of the question. It holds
no text of the conversation. To see how often the model and the rule agree:

```bash
jq -s 'map(select(.p != null)) | {asked: length, agree: (map(select((.p >= 0.5) == .rule)) | length)}' \
  ~/.namzu/decision/points.jsonl
```

Run a point in `shadow` for a while and read the disagreements before turning it `on`.
