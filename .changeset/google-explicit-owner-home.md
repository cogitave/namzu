---
"@namzu/cli": patch
---

Honor GEMINI_CLI_HOME when reusing Gemini CLI Google sign-ins. Read the selected home’s .gemini/oauth_creds.json and avoid falling back to another Linux or Windows account when that explicitly selected owner is signed out. Empty values preserve the normal lookup.
