---
type: Design
title: Learning your work, one work profile at a time
description: The goal, concepts, lifecycle, consent defaults, status surfaces and build order for Namzu learning the work a person does on their own computer, suggesting how to keep it going, handing it to a Pal, and optionally training a small model for it.
resource: packages/sdk/src/learning/
tags: [sdk, learning, profiles, consent, pals, design]
status: draft
generated: { by: process:claude-code, at: 2026-11-07T00:00:00Z }
---

# Learning your work, one work profile at a time

> **Draft.** This page states a direction and the decisions taken for it. Only the parts marked *exists* below are shipped. Nothing here changes a default: every capability it describes is off until the person turns it on, by hand.

## Goal

With the person's consent, Namzu learns the work they do on their own computer, tells them when it has learned enough to keep a piece of it going, and offers the next step: help while they are there, a schedule, a Pal that does it on its own computer, and, when it is worth it, a small model trained for that work. The person is told what is happening at every step and can stop, inspect or delete it at any time.

This is for anyone, not only organisations. An organisation that runs Namzu on its people's computers adds a policy layer (see [Organisations](#organisations)) but does not change what the person is shown or may refuse.

## What exists and what does not

| Piece | State |
| --- | --- |
| [Learning cycle](learning.md): observations, candidates, paired verification, fresh confirmation | *exists* |
| Decision points with a `shadow` mode that predicts and records agreement without acting | *exists* in the CLI |
| [Scheduled tasks](../cli/scheduled-tasks.md) with `script`, `agent` and `script+agent` kinds | *exists* |
| [Pals](pals.md) with their own guest computer | *exists* |
| Computer-use host that reads a window as a tree of controls, not pixels | *exists* |
| `namzu doctor` | *exists* |
| Durable background sessions you can attach to and read the log of | planned |
| Automations: a learned or recorded piece of work as typed, editable steps | planned (decided, never built) |
| Work profiles, the consent ledger, the readiness states and the surfaces below | planned (this page) |

## Concepts

| Word | Means | Notes |
| --- | --- | --- |
| **Profile** | One work context ("company X", "my freelance work") | Owns its accounts, its observation scope and consent record, what it learned, its automations, its limits and the Pal that serves it |
| **Automation** | A piece of work as typed, editable steps with the evidence it came from | The thing that is learned; not a workflow (that word means several agents) |
| **Schedule** | When an automation runs | Already exists |
| **Pal** | The worker, with its own computer, name and purpose | One per profile; created on hand-off |
| **Run** | One execution of an automation | Shows in the agents list like any session |

A profile is to a person's work what a browser profile is to their browsing: separate accounts, separate history, nothing shared unless they share it. Moving to a different piece of work does not retrain anything. The old profile goes dormant with everything it learned, and wakes when the person returns. It also removes the need to keep making new Pals: a Pal belongs to a profile, not to the person.

Two existing uses of the word need qualifying wherever they appear next to this one: the SDK's Pal *profile revisions* (the Pal's name, purpose and model record) and the CLI's *model profiles*, *egress profiles* and the browser's own profile. A work profile owns a browser profile; it is not one.

## Lifecycle of a profile

A profile has one status at a time. The status is derived from facts, never set by a model's own opinion of itself.

| Status | What is true |
| --- | --- |
| `off` | Nothing is observed. The default |
| `observing` | The sources the person enabled are recorded locally; nothing is analysed yet |
| `learning` | Repeated work is being found; progress is shown as what has been seen, not as a percentage of a guess |
| `ready to suggest` | At least one drafted automation has enough evidence to show the person |
| `assisting` | An approved automation runs beside the person in shadow: it prepares what it would do, never sends or changes anything, and the agreement with what the person really did is measured |
| `ready to schedule` | Agreement over enough runs passes the threshold the person accepted |
| `ready for a Pal` | The same, and the work needs no more of the person's computer than a Pal can be given |
| `with a Pal` | A Pal runs it; every send and every change still follows the approval level the person set |
| `ready for its own model` | Enough consented data exists and a model would help; resources are described (see [Training a model](#training-a-model)) |
| `training`, `on trial` | A model is being trained, then run in shadow against held-out work |
| `supervised autonomy` | The model's work is carried out within limits, with a named owner, sampling for review and a stop control |

Moving to a status that grants more than the one before always needs the person's explicit yes, and the yes is recorded. A status never moves up because of an update. No status is a percentage: a percentage of "learned" would claim precision nobody has, so the status is a name plus one concrete fact ("11 of 12 mornings matched").

## Working without a Pal

Everything up to `ready to schedule` happens on the person's own computer, with no Pal. Namzu helps while they are there: it shows what it noticed, prepares drafts, runs approved automations in shadow, and asks before anything leaves the machine. A Pal is one way to continue the work after that, not a requirement. The person can also schedule the automation to run on their own computer, or never hand it over.

## Start by showing, not by watching

The first way to teach is explicit. The person starts a short recording ("show me this work") and is told, in a dialog they must answer each time, what is captured and that they should not type passwords or secrets. The start control ignores clicks for a moment after the dialog appears and after it is resized, so a stray click cannot start a recording. While it runs, a small indicator is always visible; it turns off only when capture has actually stopped, never when the person clicked stop. A recording ends by itself after a fixed maximum, and Discard is as prominent as Done.

What is kept is bounded: raw evidence is held briefly and in memory, and what remains is the derived steps, which the person can read, edit and delete. A recording can be reviewed and trimmed before anything is drafted from it, so private stretches can be cut.

Watching a profile's work continuously is a later and separately consented step, not part of this one. It is Namzu's own design with no shortcut through the explicit one: it has its own notice, its own indicator that stays on for as long as it runs, its own retention in numbers, and it is off until the person turns it on for that profile.

## Consent and defaults

- **Everything is off by default** and is enabled by hand, per profile and per source: window and control trees, commands, files, browser pages. Screenshots are a separate, stricter source.
- **Capturing the screen is its own decision.** The notice says what is captured, how often, where it is stored (locally, encrypted, with an expiry), who can see it, and, when a model reads it, which provider receives it, with a local-model option offered first. While it is capturing, a visible indicator is on screen and pausing is one action.
- **A consent ledger** the person can read: what was enabled, when, in which profile, with what scope. Widening a scope asks again. Deleting a profile deletes what it observed.
- **An update never enables, widens or starts anything.** A release that adds an observation capability ships it off, says so in the release notes and in the app's "what's new", and the capability appears off in the profile settings.
- **Tips and first-run text** explain, once, what a profile is and that nothing is observed until it is turned on. They never nudge the person to turn it on.
- **Consent keys are not read from a project's own settings.** A setting that a cloned folder carries can never turn observation or hand-over on. A narrower scope may only tighten what a wider one allowed, and `namzu doctor` names the layer that decided.
- **A decision that goes unanswered expires to the safe answer** ("not now") after a few minutes. Waiting never becomes consent.
- Secrets and password fields are never captured. Content that belongs to other people is minimised and, where it cannot be avoided, masked.
- The raw observations stay on the person's computer. What is sent to a model is what the person approved for that profile, and is shown to them first.

## Observing, and what is never captured

Observation is structured events: the controls of a window and their changes, commands, files touched, pages visited, not pixels. The computer-use host already reads windows this way. Observations are stored per profile, not per person, so two profiles never mix.

Before anything reaches the learner, low-level events are merged into named steps (a run of keys becomes one typed entry, a press and release becomes a click), and evidence is recorded only when something changed. Evidence per item has a hard cap and says when it was cut. Typing in a secure field is recorded as one "secure input" marker with no content. Each profile has an app deny-list (password managers, banking, terminals) that is never observed, and the text of password-role controls is masked at the source. Everything observed is wrapped as data to describe, never as instructions, and observed text is never copied verbatim into memory or into a draft.

## Where it is shown

A decision does not belong in the middle of a conversation, so the status has its own places:

- **`namzu doctor`** reports each profile's status, the enabled sources, the oldest and newest observation, how many automations are drafted, approved and running, and what is blocking the next status in plain words ("learning: 9 of the 12 mornings it needs").
- **A profile surface** in the CLI (`namzu profile status`, `/profiles` in the interface) and in the desktop app: the list of profiles with their status, the drafted automations to review, the consent ledger and the controls.
- **A card, not a chat message,** when something needs the person's decision ("one automation has matched your work 11 of 12 times"). In the desktop app it sits in the strip of notices under the conversation, which is not part of the model's context; in the terminal it is one dim system row. A dismissal is tied to the item's own revision, so only a newer one shows again; each kind of card has a lasting "don't ask again"; and acting on a card leaves a plain state line (kept, started, couldn't start).
- **A one-line pointer** from tips or a recap ("a profile has something to show") that opens the profile surface. It is only a pointer.
- The learner announces what it wrote with a visible "learned" row, the same way a memory write is shown, and tells the agent through a hidden, ambient note that is not narrated unless relevant. Anything it made is marked "learned by Namzu" with the date and the number of observations behind it, and keeps that mark through edits until a person rewrites it.

## Proposals

A drafted automation reaches the person as a card with **Save** and **Dismiss**, and both can be undone. The draft is by outcome, not by replay: for each step it finds what changed (a file, a message, a setting) and uses the most direct reliable means, a script first, a model step only for judgement, driving the screen last. A saved automation passes a static check (no secrets, only allowed tools, a dry run) before it is live, and while a revision is being checked the previous one stays live. A proposal is never started by content found in what was observed, there is a cap on how many wait at once, and one that waits too long becomes "not now".

## Shadow runs and permissions

A shadow run runs in isolation from the person's real working tree and never touches it; only an automation the person has promoted may. Each app a run may touch has a level: **read** (see only), **click** (clicks and scrolling, no typing), **full** (typing, keys, drag, menus). A run starts at read for every app, only the person raises it, and some classes are capped (a terminal is never typed into through the screen; a browser is driven through its own tool). The request for access itself is never "always allowed". A run nobody is watching never asks: it refuses with one standard sentence, tells the model a retry will fail, and parks a "needs you" item for the next time the person looks.

## Handing it to a Pal

Namzu offers the hand-off when the status reaches `ready for a Pal`, in the card, with what it would do and what it would need. The Pal sets up what the work needs on its own computer.

**The Pal gets its own identity.** A person's browser sessions and cookies are never copied to a Pal: a copy is their whole identity, bypasses their second factor, ties the Pal's actions to them in every audit trail and breaks when the session does. Instead the profile holds credential references. Access is granted to the Pal itself (a delegated mailbox or an OAuth grant limited to what the work needs), or the person signs in once in the Pal's browser through the live takeover view, and the Pal keeps its own session. This keeps the existing rule that credentials are references and that login and second factors are the person's.

The Pal says when it has taken the work over, shows each run in the agents list, and can be attached to and read from another session. Sends and changes keep the approval level of the profile.

## Training a model

When a profile is `ready for its own model`, Namzu says what it would train, on what (only the profile's consented data), how long it would take and what it needs. It checks the computer first. If this computer is enough, training runs here after the person agrees to the time and cost. If it is not, Namzu does not guess: it writes a plain request describing the resources (a machine with a suitable GPU, or a budget on a provider the person chooses) so the person can arrange them. The trained model belongs to the profile, is stored locally and is run in shadow against held-out work before it is allowed to act. It is promoted only by the person's yes. Namzu claims only what it has measured; training a model is a research track and may stay narrow, for the repeated, low-risk choices an automation makes, rather than a general model.

## Organisations

An organisation can set a policy that limits what a profile may observe or do, require that a profile's data stays on the computer, set retention, or turn the capability off. It cannot hide the capability from the person: the person is always told what is observed, can pause it, and can see and delete what a profile holds. Observing a person's work needs their agreement as well as the organisation's.

## Names

*Profile*, *automation*, *schedule*, *Pal* and *run* are the words. Not *routine*, *workflow* or *resident* (removed). The learning module's own names stay as they are.

## Order of work

1. Remove the resident feature and make the learning module independent of it.
2. Durable background sessions with attach and logs, so a run can be watched from another session.
3. Automations as typed, editable steps, bound to the existing schedule kinds.
4. Profiles with the consent ledger, explicit "show me" recording with its dialog and indicator, and the status surfaces above, including `namzu doctor`. Continuous observation comes only after this is in people's hands and measured.
5. Shadow runs and the agreement measure per automation, then the suggestion cards.
6. Hand-off to a Pal with its own identity.
7. Supervised autonomy with limits, then the optional model.

Each step ships on its own and is useful on its own.

## Decisions taken

- A work context is a **profile**; other uses of the word are qualified where they meet it.
- A Pal serving a profile gets **its own delegated identity**; sessions and cookies are never copied.
- The status of a profile is **derived from facts** and shown in `namzu doctor` and in a surface that is not the conversation.
- **Nothing is on by default, and an update never turns anything on.**
- **Screenshots are a separate source** with their own notice and indicator.

## Open

- Continuous observation has no shipped precedent to follow: what is observed and how a repeated task is noticed, what each consent covers, how derived drafts and trained weights are treated when consent is withdrawn, and whose profile owns a routine on a shared computer.
- How redaction is verified before observed content reaches a draft or a training set.
- Minting, scoping and revoking a Pal's own delegated identity, and proving its version before hand-over.
- A budget for the learner's own model calls, and what it does when a free quota runs out.
- How the agreement threshold is chosen and whether the person can set it per automation.
- Which maintained package or service does on-device training, and what the smallest useful model is.
- How an organisation's policy is delivered to a computer and how the person sees it.
