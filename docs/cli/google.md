---
type: guide
title: Google accounts and model access
description: Reusing an installed Gemini CLI sign-in or an explicit Google API key in Namzu.
resource: packages/cli/src/integrations/providers/gemini-credentials.ts
---

# Google accounts and model access

Namzu's `google` provider uses `@namzu/google`. The SDK sends native model
requests; Namzu retains responsibility for tools, permissions, agents and
conversation state. It does not launch a second Gemini CLI agent loop.

## Existing Google sign-in

Sign in with Google in Gemini CLI, then start Namzu and choose **Google
(Gemini)** from `/model`. Discovery reads the owner's
`~/.gemini/oauth_creds.json`. On WSL it also checks the paired Windows account's
`.gemini/oauth_creds.json`, using the same Windows home resolution as the other
installed-account integrations. Installing Gemini CLI alone does not establish a session.

A usable owner credential appears as **Gemini session · this device**. A missing,
malformed or expired credential without a refresh token is not offered as a
signed-in account. `/doctor` reports the selected credential's owner path without
printing tokens.

Google account credentials use the Code Assist endpoint, not the API-key
endpoint. The driver resolves the existing Code Assist project with
`loadCodeAssist`. It does not enroll an account or select a billing tier. If
Google requires onboarding, complete it in Gemini CLI. Workspace accounts may
require `GOOGLE_CLOUD_PROJECT` or `GOOGLE_CLOUD_PROJECT_ID`; these refer to a Google
Cloud project, never Namzu's local workspace identity.

When `GEMINI_CLI_HOME` is non-empty, discovery instead reads
`$GEMINI_CLI_HOME/.gemini/oauth_creds.json`, matching Gemini CLI's credential
storage. That explicit owner replaces both default home candidates; a missing
or unusable session there does not select a different Linux or Windows account.
An empty value keeps the normal home lookup.

## Explicit API credentials

`GEMINI_API_KEY` takes precedence over `GOOGLE_API_KEY`; either explicit key takes
precedence over a borrowed Gemini CLI session. API credentials use Google's
Generative Language API and its model catalogue. They do not inherit a Google
account subscription's billing or quota. A key typed in the provider picker stays
in that Namzu session under the existing picker credential rules.

## Credential lifetime

Namzu reads the selected owner file before each credential request, so a later
logout or account replacement is observed. By default, renew expired sessions
in the owning CLI. Namzu can renew them in memory when both
`GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` are explicitly configured
for the OAuth application that issued the refresh token. No application secret
is bundled in Namzu. Refreshed credentials remain in memory: Namzu
does not overwrite Gemini CLI's file or copy the Google sign-in into its own
credential store. Concurrent requests share a refresh within one resolver; an
individual cancelled waiter does not cancel a sibling's refresh.

The Google refresh request is bounded by a 15-second deadline. Failures report
HTTP status and sign-in guidance without including Google's response body. Owner
files are read with a size limit and nonblocking file access.

## Model and effort selection

The default is `gemini-2.5-flash`. This is Namzu's conservative model choice, not a
claim about the newest model or every account's entitlement. API-key access can
list models from Google. Code Assist has no equivalent public model-list
contract; its bundled choices are model candidates and Google may refuse one
that the account cannot use. The model-specific effort menu advertises only
controls mapped by the driver; no generic effort scale is inferred for unknown
model IDs. See `packages/providers/google/README.md` for the SDK configuration.

## Protocol sources

The integration follows Google's [Gemini CLI authentication
instructions](https://geminicli.com/docs/get-started/authentication/) and the
public [Code Assist implementation](https://github.com/google-gemini/gemini-cli/tree/main/packages/core/src/code_assist).
OAuth application configuration must match the issuer of the borrowed refresh
token; unrelated application credentials cannot renew that session.

## Web search

Under `web.backend: auto`, a supported Gemini 3 API-key model uses native Google
Search grounding alongside function tools. The driver's `supportsGoogleSearch`
list defines the supported models; unknown models, Gemini 2.5 and Code Assist
sessions use common Exa search. Native Google cached search is not supported.
Grounded source URLs are retained in the answer and conversation history.
See [Web search](web-search.md) for selection, permission and fallback behavior.
