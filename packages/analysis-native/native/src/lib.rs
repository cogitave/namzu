//! namzu-analysis-native: a read-only binary analysis sidecar.
//!
//! One JSON request per line on stdin, one JSON response per line on stdout.
//! See `docs/sdk/native-analysis.md` for the protocol.

#![deny(unsafe_code)]

pub mod bun;
pub mod ctx;
pub mod demangle;
pub mod embedded;
pub mod error;
pub mod imports;
pub mod info;
pub mod safepath;
pub mod sea;
pub mod source;
pub mod strings;
pub mod symbols;
pub mod target;

#[cfg(test)]
mod tests;

use std::io::{self, BufRead, Write};
use std::panic::{AssertUnwindSafe, catch_unwind};

use serde::de::DeserializeOwned;
use serde_json::{Value, json};

pub use ctx::{Ctx, Limits};
pub use error::{OpError, OpResult};

pub const PROTOCOL_VERSION: u32 = 1;
pub const OPS: &[&str] = &[
    "hello",
    "binary_info",
    "symbols",
    "imports",
    "exports",
    "strings",
    "extract_embedded",
];

fn hello(limits: &Limits) -> Value {
    json!({
        "name": "namzu-analysis-native",
        "version": env!("CARGO_PKG_VERSION"),
        "protocol": PROTOCOL_VERSION,
        "ops": OPS,
        "formats": ["elf", "pe", "macho", "macho-fat", "coff"],
        "embedded": ["bun", "node-sea"],
        "bunLayouts": [bun::LAYOUT],
        "limits": {
            "maxRequestBytes": limits.max_request_bytes,
            "maxFileBytes": limits.max_file_bytes,
            "defaultMaxBytes": limits.default_max_bytes,
            "maxMaxBytes": limits.max_max_bytes,
        },
    })
}

fn with_target<P, F>(
    params: Value,
    ctx: &mut Ctx,
    path_of: fn(&P) -> &str,
    run: F,
) -> OpResult<Value>
where
    P: DeserializeOwned,
    F: FnOnce(&[u8], P, &mut Ctx) -> OpResult<Value>,
{
    let p: P = serde_json::from_value(params)?;
    let src = source::open_regular(path_of(&p), &ctx.limits)?;
    run(&src, p, ctx)
}

/// Run one op. Everything a caller can get wrong comes back as an `OpError`.
pub fn dispatch(op: &str, params: Value, ctx: &mut Ctx) -> OpResult<Value> {
    ctx.check()?;
    match op {
        "hello" => Ok(hello(&ctx.limits)),
        "binary_info" => with_target::<info::Params, _>(params, ctx, |p| &p.path, info::run),
        "symbols" => with_target::<symbols::Params, _>(params, ctx, |p| &p.path, symbols::run),
        "imports" => {
            with_target::<imports::Params, _>(params, ctx, |p| &p.path, imports::run_imports)
        }
        "exports" => {
            with_target::<imports::Params, _>(params, ctx, |p| &p.path, imports::run_exports)
        }
        "strings" => with_target::<strings::Params, _>(params, ctx, |p| &p.path, strings::run),
        "extract_embedded" => {
            with_target::<embedded::Params, _>(params, ctx, |p| &p.path, embedded::extract)
        }
        other => Err(OpError::new(
            "unknown_op",
            format!("unknown op `{other}`; supported: {}", OPS.join(", ")),
        )),
    }
}

fn error_response(id: &Value, e: &OpError) -> Value {
    json!({ "id": id, "ok": false, "error": { "code": e.code, "message": e.message } })
}

/// Turn one request line into one response line (without the newline).
pub fn handle_line(line: &[u8], limits: &Limits) -> String {
    let request: Value = match serde_json::from_slice(line) {
        Ok(v) => v,
        Err(e) => {
            return error_response(
                &Value::Null,
                &OpError::new("bad_request", format!("request is not valid JSON: {e}")),
            )
            .to_string();
        }
    };
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let Some(obj) = request.as_object() else {
        return error_response(
            &id,
            &OpError::new("bad_request", "request must be a JSON object"),
        )
        .to_string();
    };
    let Some(op) = obj.get("op").and_then(Value::as_str) else {
        return error_response(
            &id,
            &OpError::new("bad_request", "request has no string `op`"),
        )
        .to_string();
    };
    let num = |k: &str| obj.get(k).and_then(Value::as_u64);
    for k in ["deadlineMs", "maxBytes"] {
        if obj
            .get(k)
            .is_some_and(|v| !v.is_null() && v.as_u64().is_none())
        {
            return error_response(
                &id,
                &OpError::new(
                    "bad_request",
                    format!("`{k}` must be a non-negative integer"),
                ),
            )
            .to_string();
        }
    }
    let params = obj.get("params").cloned().unwrap_or_else(|| json!({}));
    let mut ctx = Ctx::new(*limits, num("deadlineMs"), num("maxBytes"));
    let max_bytes = ctx.max_bytes;

    let outcome =
        catch_unwind(AssertUnwindSafe(|| dispatch(op, params, &mut ctx))).unwrap_or_else(|_| {
            Err(OpError::new(
                "internal",
                "the op panicked; the request was abandoned and the process continues",
            ))
        });
    match outcome {
        Ok(result) => {
            let out = json!({ "id": id, "ok": true, "result": result }).to_string();
            if out.len() > max_bytes + max_bytes / 8 + 4096 {
                error_response(
                    &id,
                    &OpError::new(
                        "output_too_large",
                        format!(
                            "the result is {} bytes, over the request's {max_bytes} byte limit; page it with offset/limit",
                            out.len()
                        ),
                    ),
                )
                .to_string()
            } else {
                out
            }
        }
        Err(e) => error_response(&id, &e).to_string(),
    }
}

enum Line {
    Eof,
    Ok,
    TooLong,
}

/// Read one `\n`-terminated line into `buf`, keeping at most `max` bytes. A
/// longer line is consumed to its end and reported, never buffered.
fn read_line_bounded<R: BufRead>(r: &mut R, buf: &mut Vec<u8>, max: usize) -> io::Result<Line> {
    let mut too_long = false;
    let mut any = false;
    loop {
        let chunk = match r.fill_buf() {
            Ok(c) => c,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        if chunk.is_empty() {
            return Ok(if !any {
                Line::Eof
            } else if too_long {
                Line::TooLong
            } else {
                Line::Ok
            });
        }
        any = true;
        let (take, found) = match memchr::memchr(b'\n', chunk) {
            Some(i) => (i + 1, true),
            None => (chunk.len(), false),
        };
        if !too_long {
            let body = if found { take - 1 } else { take };
            if buf.len() + body > max {
                too_long = true;
                buf.clear();
            } else {
                buf.extend_from_slice(&chunk[..body]);
            }
        }
        r.consume(take);
        if found {
            return Ok(if too_long { Line::TooLong } else { Line::Ok });
        }
    }
}

/// Serve requests until the input ends. Sequential: one response per request,
/// in order. Nothing but responses is written to `output`.
pub fn serve<R: BufRead, W: Write>(mut input: R, mut output: W, limits: Limits) -> io::Result<()> {
    let mut buf = Vec::new();
    loop {
        buf.clear();
        let response = match read_line_bounded(&mut input, &mut buf, limits.max_request_bytes)? {
            Line::Eof => return Ok(()),
            Line::TooLong => error_response(
                &Value::Null,
                &OpError::new(
                    "request_too_large",
                    format!("request line is over {} bytes", limits.max_request_bytes),
                ),
            )
            .to_string(),
            Line::Ok => {
                if buf.iter().all(u8::is_ascii_whitespace) {
                    continue;
                }
                handle_line(&buf, &limits)
            }
        };
        output.write_all(response.as_bytes())?;
        output.write_all(b"\n")?;
        output.flush()?;
    }
}
