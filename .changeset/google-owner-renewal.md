---
"@namzu/cli": major
---

Stop bundling OAuth application credentials for borrowed Google sessions. Expired sessions now require renewal in their owning CLI, unless GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET are explicitly configured for the application that issued the refresh token. Fresh owner sessions and API-key access continue to work.
