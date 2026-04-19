---
name: resume-session
description: Use this skill whenever the user resumes existing design, architectural, or planning work, or whenever a fresh agent takes over and must locate prior context. Triggers include references to "last time", "where we left off", "the <slug> session", "continue the refactor", any mention of a session ID like "ses_001", or ambiguity about what work is in flight. Always use this before starting new work that might already have an open session — creating a duplicate session loses context and fragments decisions.
---

# Resume Session

Locates the most relevant in-flight session under `docs.local/sessions/` and loads its context so work can continue without loss of prior decisions. The `progress.md` log inside the session is the primary source for "where did we leave off".

## When to trigger

<triggers>
- User refers to prior work by slug, topic, or "last time" / "where we left off".
- A fresh agent (after `/clear`, or a handoff) needs to know the current state.
- Before starting a new session on a topic that might already have one open.
- User mentions a session ID explicitly (e.g. "let's keep going on ses_001").
</triggers>

## Steps

<procedure>
1. Read `docs.local/sessions/README.md` — this is the index of all sessions with status and slug.

2. Filter candidates by status and topic:
   - Status `draft` or `in-progress` → active work.
   - Status `frozen` → historical; only resume if user explicitly asks.
   - Slug match → topic relevance.

3. Resolve:
   - Exactly one candidate → proceed to step 4.
   - Multiple candidates → list them for the user and ask which; do not guess.
   - No candidates → suggest `start-session` instead.

4. Load the session context in this order:

   <load_order>
     1. `progress.md` — **read this first.** The bottom entry is the current state and the next step.
     2. `README.md` — scope, decisions made so far, decisions deferred.
     3. `open-questions.md` — pending user input.
     4. `design.md` — only if design work is being resumed.
     5. `implementation-plan.md` — only if implementation is being resumed.
   </load_order>

5. Summarise for the user:
   - Session ID and status.
   - What was last done (from the latest `progress.md` entry).
   - Open questions blocking progress (from `open-questions.md`).
   - Immediate next step (from `progress.md` or `implementation-plan.md`).
</procedure>

## Progress discipline

<discipline>
When this skill resumes work in a session, the FIRST action after summarising must be to append a new entry to `progress.md`:

```md
### YYYY-MM-DD HH:MM — Resumed
- Loaded context from progress.md, README.md, open-questions.md
- Last known state: [one line]
- Next: [concrete action]
```

This marks the handoff explicitly and makes the next handoff (if it comes) equally clean.
</discipline>

## Output

- Session ID and current status.
- One-paragraph summary of decisions made so far.
- Open questions count and short titles.
- Concrete immediate next step.
