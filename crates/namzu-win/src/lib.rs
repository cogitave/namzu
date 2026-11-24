//! The `namzu-win` helper: reads `namzu-win/1` requests, one JSON object per
//! line, and answers each with one line.
//!
//! This is the loop and the dispatch. The Windows calls (UI Automation, event
//! hooks, capture, input) sit behind it and arrive in later changes; until an
//! op has its implementation the helper answers `unsupported` and says so,
//! which is what a caller reading `hello`'s `caps` already knows. Nothing here
//! needs Windows, so the loop builds and is tested everywhere.

use namzu_win_core::protocol::{
    self, ErrorCode, HelloReply, PROTOCOL, ReplyBody, Request, WireError,
};
use std::io::{BufRead, Write};

/// What the loop does after answering one line.
#[derive(Debug, PartialEq, Eq)]
pub enum Flow {
    Continue,
    /// The caller asked the helper to end.
    Quit,
}

/// Facts about this build, reported by `hello`.
#[derive(Debug, Clone)]
pub struct BuildInfo {
    pub version: String,
    pub build_hash: String,
    pub arch: String,
    pub os_build: String,
    pub signer: Option<String>,
    pub caps: Vec<String>,
    pub dpi_awareness: String,
}

impl BuildInfo {
    /// This executable. `NAMZU_WIN_BUILD_HASH` is set by the release build;
    /// a local build reports `dev`.
    pub fn current() -> BuildInfo {
        BuildInfo {
            version: env!("CARGO_PKG_VERSION").to_owned(),
            build_hash: option_env!("NAMZU_WIN_BUILD_HASH")
                .unwrap_or("dev")
                .to_owned(),
            arch: std::env::consts::ARCH.to_owned(),
            os_build: "unknown".to_owned(),
            signer: None,
            caps: Vec::new(),
            dpi_awareness: "unknown".to_owned(),
        }
    }
}

pub struct Session {
    info: BuildInfo,
}

impl Session {
    pub fn new(info: BuildInfo) -> Session {
        Session { info }
    }

    /// Answers one request line. The reply line has no trailing newline.
    pub fn handle_line(&mut self, line: &str) -> (String, Flow) {
        let (id, request) = match protocol::decode_request(line) {
            Ok(decoded) => decoded,
            Err(e) => {
                // A line that never named an id is answered with id 0: the
                // caller's ids start at 1, so 0 reads as "no request".
                return (
                    protocol::encode_reply(e.id.unwrap_or(0), &Err(e.error)),
                    Flow::Continue,
                );
            }
        };
        let (reply, flow) = self.dispatch(&request);
        (protocol::encode_reply(id, &reply), flow)
    }

    fn dispatch(&mut self, request: &Request) -> (Result<ReplyBody, WireError>, Flow) {
        match request {
            Request::Hello(h) => {
                if h.protocol != PROTOCOL {
                    let e = WireError::new(
                        ErrorCode::ProtocolMismatch,
                        format!("this helper speaks {PROTOCOL}, not {}", h.protocol),
                    );
                    return (Err(e), Flow::Continue);
                }
                let i = &self.info;
                let body = HelloReply {
                    version: i.version.clone(),
                    build_hash: i.build_hash.clone(),
                    arch: i.arch.clone(),
                    os_build: i.os_build.clone(),
                    signer: i.signer.clone(),
                    caps: i.caps.clone(),
                    dpi_awareness: i.dpi_awareness.clone(),
                };
                (Ok(ReplyBody::Hello(body)), Flow::Continue)
            }
            Request::Quit => (Ok(ReplyBody::Ack), Flow::Quit),
            // Nothing runs concurrently yet, so there is nothing to cancel.
            Request::Cancel(_) => (Ok(ReplyBody::Ack), Flow::Continue),
            other => {
                let e = WireError::new(
                    ErrorCode::Unsupported,
                    format!("{} is not implemented in this build", other.op().name()),
                );
                (Err(e), Flow::Continue)
            }
        }
    }
}

/// Runs the protocol over a reader and a writer until `quit` or end of input.
/// Diagnostics belong on stderr; stdout carries replies only.
pub fn run(input: impl BufRead, mut output: impl Write, info: BuildInfo) -> std::io::Result<()> {
    let mut session = Session::new(info);
    for line in input.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let (reply, flow) = session.handle_line(&line);
        writeln!(output, "{reply}")?;
        output.flush()?;
        if flow == Flow::Quit {
            break;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use namzu_win_core::protocol::{Op, decode_reply};

    fn session() -> Session {
        Session::new(BuildInfo {
            version: "9.9.9".into(),
            build_hash: "abc".into(),
            arch: "x86_64".into(),
            os_build: "1".into(),
            signer: None,
            caps: vec![],
            dpi_awareness: "unknown".into(),
        })
    }

    #[test]
    fn hello_names_the_build() {
        let (line, flow) = session()
            .handle_line(r#"{"id":1,"op":"hello","protocol":"namzu-win/1","cliVersion":"55.0.0"}"#);
        assert_eq!(flow, Flow::Continue);
        let (id, reply) = decode_reply(Op::Hello, &line).unwrap();
        assert_eq!(id, 1);
        match reply.unwrap() {
            ReplyBody::Hello(h) => assert_eq!(
                (h.version.as_str(), h.build_hash.as_str()),
                ("9.9.9", "abc")
            ),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn another_protocol_is_refused() {
        let (line, _) = session()
            .handle_line(r#"{"id":2,"op":"hello","protocol":"namzu-win/2","cliVersion":"1"}"#);
        let (_, reply) = decode_reply(Op::Hello, &line).unwrap();
        assert_eq!(reply.unwrap_err().code, "protocol_mismatch");
    }

    #[test]
    fn an_op_without_an_implementation_says_so() {
        let (line, flow) = session().handle_line(r#"{"id":3,"op":"displays"}"#);
        assert_eq!(flow, Flow::Continue);
        let (id, reply) = decode_reply(Op::Displays, &line).unwrap();
        assert_eq!(id, 3);
        let e = reply.unwrap_err();
        assert_eq!(e.code, "unsupported");
        assert!(e.message.contains("displays"));
    }

    #[test]
    fn a_bad_line_is_answered_and_the_loop_goes_on() {
        let (line, flow) = session().handle_line("not json");
        assert_eq!(flow, Flow::Continue);
        let (id, reply) = decode_reply(Op::Quit, &line).unwrap();
        assert_eq!(id, 0);
        assert_eq!(reply.unwrap_err().code, "bad_request");
    }

    #[test]
    fn run_stops_at_quit_and_skips_blank_lines() {
        let input = b"\n{\"id\":1,\"op\":\"quit\"}\n{\"id\":2,\"op\":\"displays\"}\n";
        let mut out = Vec::new();
        run(&input[..], &mut out, BuildInfo::current()).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert_eq!(text.lines().count(), 1);
        assert!(text.contains(r#""ok":true"#));
    }
}
