# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, please email: **security@cogitave.com**

You should receive a response within 48 hours. We will work with you to understand the issue and address it promptly.

## Supported Versions

**The latest published major of each package is supported. Older majors are not.**

This is stated as a rule rather than a table on purpose. This section used to
list `0.x` as the only supported version, and every package in this repository
had long since left it — so the document told a reporter that nothing shipping
was covered, which is the opposite of what it exists to do and the version of
being out of date that costs a report rather than a correction.

Packages are versioned independently and released through Changesets, so
"latest major" is answered by the registry rather than by this file:

```
npm view @namzu/sdk version
```

Every package published from this repository is in scope — the runtime, the
operator application, the capability and observability packages, the eval
suites, and each service driver. If you are unsure whether something is in
scope, report it and we will tell you.

## Disclosure Policy

We follow a coordinated disclosure process. Once a fix is available, we will publish a security advisory and credit the reporter (unless they prefer to remain anonymous).
