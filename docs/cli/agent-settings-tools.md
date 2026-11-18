---
type: Reference
title: Settings tools for the model
description: get_settings and set_setting, the two deferred tools that let the model read the safe settings and change one with the person's yes on a card; the explicit allow-list, what is refused and why, who decides a value, and the Let Namzu change settings switch.
resource: packages/cli/src/config/agent-settings.ts
tags: [cli, desktop, settings, tools, permissions]
status: draft
generated: { by: process:claude-code, at: 2026-11-19T00:00:00Z }
---

# Settings tools for the model

Two tools let the model help with Settings without ever deciding for you. They are offered in Desktop
conversations and in the terminal app, as deferred tools: the tool listing gains two name lines
(`get_settings`, `set_setting`) and nothing else, and the model loads a schema only when it needs one.

* `get_settings` reads the settings the model may change, with the value in force, and a few facts it may
  only read: the default permission mode, whether bypass permissions mode is allowed, whether auto mode
  is removed, whether computer use is on, and the default model.
* `set_setting` changes one setting. It takes the setting's name (as `get_settings` lists it) and a value.

## Every change asks you

`set_setting` always needs a person. It is marked as a call that must be asked about every time, the same
mark a sandbox escape or a protected-path write carries, so a remembered "allow for this conversation",
auto mode and bypass mode never answer it, and a conversation nobody is watching refuses it.

In Desktop the card is the ordinary approval card: *Change Notification sound?*, then *Now* and
*Change to* in the words Settings uses (*None*, *System sound*), with Allow and Reject. It never shows a
key or the raw input, and it offers no "allow for this conversation". In the terminal app the approval
prompt shows `Change`, `From` and `To` the same way.

A change that would be refused anyway is refused before any card: a setting not on the list, a value the
setting does not take (the reply names what it takes), or a value something else decides. You are never
asked about a change that cannot happen.

## The allow-list

The list is in code, not "everything Settings can change": `AGENT_SETTINGS` in
`packages/cli/src/config/agent-settings.ts`. A setting joins it only when its descriptor (or Desktop's own
Settings row) already checks the values it takes.

| Name the model uses | Setting shown in Settings | Key | Owner |
|---|---|---|---|
| `archive_inactive_conversations` | Archive inactive conversations | `archiveInactive` | config file |
| `branch_prefix` | Branch prefix | `worktrees.branchPrefix` | config file |
| `label_conversations_by_status` | Label conversations by status | `statusMarks` | config file |
| `closing_summary` | Summary and next steps | `closingSummary` | config file |
| `output_style` | Output style | `outputStyle` | config file |
| `prompt_suggestions` | Prompt suggestions | `promptSuggestions` | config file |
| `permission_request_notifications` | Permission requests | `notifyPermission` | Desktop |
| `question_notifications` | Questions | `notifyQuestion` | Desktop |
| `finished_response_notifications` | Task complete | `notifyTaskComplete` | Desktop |
| `response_error_notifications` | Response errors | `notifyError` | Desktop |
| `draw_attention` | Draw attention when a conversation needs you | `attentionSignals` | Desktop |
| `notification_sound` | Notification sound | `notificationSound` | Desktop |
| `keep_awake_while_working` | Keep computer awake while Namzu works | `keepAwakeWhileWorking` | Desktop |
| `keep_awake_on_battery` | Keep awake on battery power | `keepAwakeOnBattery` | Desktop |

Text values (branch prefix, output style) are at most 600 characters and are shown to you whole on the
card. An empty output style removes it.

The Desktop rows exist only in the Desktop app. The terminal app offers the six config-file rows.

Everything else is refused with one sentence, "That setting can only be changed by you in Settings."
That covers every permission key, the sandbox, the browser and its sites, tool servers, hooks, plugins,
extensions, computer use, trusted folders, models and providers, API keys, telemetry and updates.

## Who decides a value

A value some other layer decides is refused, with who: *decided by your administrator*, *by an
environment variable*, *by this project's settings file*, *by this project's local settings file* or *by
the profile in use*. `get_settings` shows the same as `locked`. A project file can never turn the switch
below on.

## How a change is made

A config-file row goes through the writer Settings itself uses (`writeSetting`, after the same
`checkSetting` a Settings change gets), so Settings shows it at once and the value is checked by the
setting's own rules.

A Desktop row is owned by the app. The app tells the engine where its preferences file is
(`NAMZU_DESKTOP_SETTINGS_FILE`), which the engine only reads, and the engine asks the app to save a change
with one notification, `namzu/desktop/preference` with a key and a value. The app accepts only the keys in
the table above and checks the value again. Nothing comes back, so the tool reports that the change was
sent to the app.

## Let Namzu change settings

Settings, Agent, Memory: *Let Namzu change settings* (`agentSettings`, default on). Off, both tools are
left out of new conversations and the tool listing is exactly what it was. Only your own config file and
the managed file can set it; a project file's value is ignored with a warning.
