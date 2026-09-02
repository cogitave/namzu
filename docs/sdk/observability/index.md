# Observability

Logging and session export.

* [The log pipeline — sink seam, record shape, and the audit boundary](logging.md) - Where a host plugs its own destination in, what a record carries and what the LogAttributes allowlist does and does not guarantee, how a record is defended against log forging, and why the audit trail is a separate pipeline rather than a log level.
* [Session export — what leaves the machine, and the sentence that says so](session-export.md) - How a session's run events are exported, why the redaction chain drops rather than degrades when a redactor refuses or throws, and how the boot disclosure is derived from the event filter so it cannot disagree with what is actually sent.
