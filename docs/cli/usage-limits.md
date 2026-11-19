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
| Everything else (a subscription that sends no numbers, Google, Bedrock, a local server) | One quiet line: "<Provider>: usage limits are not reported for this sign-in." | None. |

A **plan** name such as "Team" is shown only when the vendor gives one; it is never taken from an email address or an organisation. A window that has reset since the last reading shows no percent ("Reset since the last reply"). A reading older than five minutes says how old it is ("as of 12 min ago").

## How often a vendor is asked

- Numbers that ride on responses cost no request, and are sent to the window after each turn when they changed.
- A provider that has to be asked is asked only when the popover opens, and at most once a minute, by the window and again by the host. Nothing polls in the background, and a failed read keeps the last reading.
- A spend estimate is read from files when the popover opens.

## The indicator

The ring or pie turns amber from 75 percent and red from 90 percent of the worst measured thing: the conversation's context, an account window, a credit against its limit, or a spend against a budget. A window the vendor refused for reads 100 percent. From 90 percent of a window one quiet line appears under the box ("5-hour limit is at 96%, resets at 3:00 PM"). Reset words are in the person's own clock: "Resets at 3:00 PM" within a day, "Resets Sat 2:00 PM" beyond it.

Desktop never blocks a message or refuses a request because of these numbers. The vendor's own refusal is shown as before.

## What is kept

Account data lives in memory in the Namzu host and the window. It is not written to a log (nothing logs a value), a file, a prompt or telemetry; a restart forgets it. A **budget** the person sets for a provider is stored in the window's local storage and never sent anywhere.

## For provider authors

`LLMProvider.readLimits(signal?)` is an optional method returning `ProviderLimits` (`windows`, `credit`, `plan`, `asOf`), or `undefined` for "not reported". A driver whose vendor puts the numbers on responses answers from the last one with no request; one that must ask makes at most one small request per call. A driver without the method reads as "not reported". `@namzu/anthropic`, `@namzu/openrouter` and `@namzu/deepseek` export their parsers (`parseUnifiedLimits`, `parseKeyLimits`, `parseBalance`), which return `undefined` on any shape they do not recognise.

The host's feed is `namzu/limits` (a notification) and `namzu/limits/refresh` (a request), recorded in the desktop contract; see [Desktop](desktop.md#optional-operator-wire-methods).
