---
type: Reference
title: Usage limits in Desktop
description: What the usage limits popover shows for each provider, where each number comes from, how often a vendor is asked, and what is kept (nothing).
resource: packages/cli/src/commands/desktop-limits-feed.ts
tags: [cli, desktop, usage, providers]
status: stable
generated: { by: process:claude-code, at: 2026-11-17T00:00:00Z }
---

# Usage limits in Desktop

The indicator beside the model in Namzu Desktop opens **Your usage limits**. It shows, for each provider the conversation uses, only what that provider's vendor says about the account, and nothing it has to guess. A number the vendor did not give is "not reported", never a zero and never a bar.

## What is shown, per provider

| Provider and credential | Shown | Where it comes from |
| --- | --- | --- |
| Anthropic, signed in with a subscription | The 5-hour and weekly windows: percent used and when each resets | The rate-limit headers (`anthropic-ratelimit-unified-5h-*` and `-7d-*`: `utilization` as a fraction from 0 to 1, `reset` in epoch seconds, `status` of `allowed`, `allowed_warning` or `rejected`) on responses Namzu already makes. No request of its own. |
| OpenRouter | Credit used of the key's limit, or use alone for a key without a cap; a budget the vendor names in dollars is preferred | One `GET /key`, read as `data.limit`, `data.limit_remaining`, `data.usage` and `data.effective_budget` (checked against the vendor's public API reference). |
| DeepSeek | The account balance with its currency | One `GET /user/balance` to the vendor's own host, read as `balance_infos[].total_balance` (a decimal string) and `currency` (checked against the vendor's public API reference). The key is never sent to another host. |
| Any provider with an API key not listed above | A spend estimate over the last 30 days at list prices, labelled as an estimate; "of $X budget" when the person set a budget | The local record of the conversations on this machine ([Spend by day and model](cost.md)). Nothing is requested. |
| Everything else (a subscription that sends no numbers, Google, Bedrock, a local server) | Nothing: no row, no header and no sentence about what is missing | None. |

## What the popover looks like

One padded panel. With limits known it opens with **Your usage limits**, and the plan beside it ("Your usage limits · Team") when the vendor gave one. Each window is a row: its name and percent, a quiet line under the name, a thin bar. The quiet line is "Resets at 3:00 PM" within a day, "Resets Sat 2:00 PM" beyond it, and "Starts with your first message" for a window that has not begun (0 percent, no reset yet) or that reset since the last reading (the old number is never shown). A reading older than five minutes adds how old it is ("as of 12 min ago", then hours, then days, up to the 30 days a reading is kept); a window that has not begun carries no age. A provider with nothing to report has no row at all.

At the right of the title is **See all →**, which closes the popover and opens Settings at **Usage**. Below the limits, with a line between, is one **Context** row: the share of the conversation's memory used, a thin bar and **Details**, which opens the Session panel where the full breakdown is. With no limits known the popover is that one row.

## Settings, Usage

**Usage** is the section after Models in Settings (`settings/usage`, found by searching usage, limits, quota, resets, credit, spend or budget). It lists every provider that reported something, the conversation's provider first, each under its name with the plan beside it ("Anthropic · Team") when the vendor gave one. Under a name are the same rows as the popover: a window's name and percent, the reset line or "Starts with your first message", a thin bar and the age of an old reading, and the credit or spend lines. The two are drawn from one reading, so they never disagree. A provider that reports nothing has no heading and no sentence, and with nothing reported the section is just its title. Opening the section asks a vendor that has to be asked, at most once a minute like the popover.

A provider that has a spend estimate also has the optional **Spending budget** field, in US dollars: a positive number sets it, empty clears it, anything else is refused and the stored value stays. It used to sit under the spend row in the popover; it now lives only here, and a budget set before the move is read from the same place and kept.

A **plan** name such as "Team" is shown only when the vendor gives one; it is never taken from an email address or an organisation.

## How often a vendor is asked

- Numbers that ride on responses cost no request, and are sent to the window after each turn when they changed.
- A provider that has to be asked is asked only when the popover opens, and at most once a minute, by the window and again by the host. Nothing polls in the background, and a failed read keeps the last reading.
- A spend estimate is read from files when the popover opens.

## The indicator

The ring or pie turns amber from 75 percent and red from 90 percent of the worst measured thing: the conversation's context, an account window, a credit against its limit, or a spend against a budget. A window the vendor refused for reads 100 percent. From 90 percent of a window one quiet line appears under the box ("5-hour limit is at 96%, resets at 3:00 PM"). Reset words are in the person's own clock: "Resets at 3:00 PM" within a day, "Resets Sat 2:00 PM" beyond it.

Desktop never blocks a message or refuses a request because of these numbers. The vendor's own refusal is shown as before.

## What is kept

The host holds account data in memory and never writes it to a log, a prompt or telemetry. The window keeps the **last numbers the vendor gave** (windows, credit, plan and the time of the reading, never an estimate or a credential) in its interface state under the key `namzu.last-limits` (see [what Desktop keeps](desktop-state.md)), so the popover is not empty after a restart. They come back with their age, a window that has reset since is shown as a fresh one, a reading older than 30 days is dropped, and the first live reading of a provider replaces them. A **budget** the person sets for a provider (in Settings, Usage) is stored in the window's local storage under `namzu.limit-budgets` and never sent anywhere.

## For provider authors

`LLMProvider.readLimits(signal?)` is an optional method returning `ProviderLimits` (`windows`, `credit`, `plan`, `asOf`), or `undefined` for "not reported". A driver whose vendor puts the numbers on responses answers from the last one with no request; one that must ask makes at most one small request per call. A driver without the method reads as "not reported". `@namzu/anthropic`, `@namzu/openrouter` and `@namzu/deepseek` export their parsers (`parseUnifiedLimits`, `parseKeyLimits`, `parseBalance`), which return `undefined` on any shape they do not recognise.

The host's feed is `namzu/limits` (a notification) and `namzu/limits/refresh` (a request), recorded in the desktop contract; see [Desktop](desktop.md#optional-operator-wire-methods).
