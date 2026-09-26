---
'@namzu/browser': major
---

The exported `classifyHumanRequired` no longer returns `http-auth` for a bare HTTP 401 or 407. Callers that relied on that result must supply the matching `wwwAuthenticate` or `proxyAuthenticate` signal, or handle `undefined` as access denied. The browser host now fails bare 401/407 page loads instead of asking a person to sign in. Pages with separately detected sign-in, CAPTCHA or bot-check signals still request a human handoff. Failed navigation attempts, history commands with no destination and same-document URL changes retain the current document's access result, including its challenge headers. A back-forward cache restore reuses the restored document's access result.
