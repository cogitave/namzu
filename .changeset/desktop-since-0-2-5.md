---
'@namzu/desktop': patch
---

Namzu Desktop catches up with everything merged since 0.2.5, and carries the current engine.

- A window whose page crashes, hangs or fails to load recovers on its own: it reloads after 0.5, 2 and 10 seconds (at most three times a minute), then shows a card with Reload and Details. A damaged settings, layout or projects file no longer stops the app.
- The message box: Up and Down walk the messages you sent in the conversation, Ctrl/Cmd+Enter holds a message for after the reply, Stop shows a Stopping state until the turn ends, a too-long paste says what was left out, and closing an unsent conversation that holds words asks before discarding it.
- Each conversation shows one status mark, unread state is kept in one place, and Recents is grouped by day.
- Approvals: "Allow for this conversation", Esc answers No, and a standing yes never answers the asks that always need a person.
- One keyboard focus ring for every control, shown only when you move with the keyboard, and a dark-mode popover layer that sits between the page and raised surfaces instead of below them.
- The bundled engine is the current `@namzu/cli`: memory that keeps only durable preferences and is chosen and curated by a small model, faster provider discovery on Windows, the "where files go" guidance with the always-ask rule for top-level home and root entries, and the decision-model connect flow.
