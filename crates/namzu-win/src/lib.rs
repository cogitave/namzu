//! The `namzu-win` helper: reads `namzu-win/1` requests, one JSON object per
//! line, and answers each with one line.
//!
//! This is the loop and the dispatch. `hello`, `cancel` and `quit` are
//! answered here. Every other op goes to a [`Backend`], which answers through
//! a [`Responder`] when it has the answer, so a slow op (reading a window,
//! waiting for it to change) does not hold up the next line. The backend of a
//! Windows build calls the platform; any other build answers `unsupported`,
//! which is what a caller reading `hello`'s `caps` already knows. The loop
//! itself needs no Windows and is tested everywhere.

pub mod backend;
pub mod exec;
#[cfg(windows)]
mod win;

use backend::{Backend, Responder, Sink};
use namzu_win_core::protocol::{
    self, ErrorCode, HelloReply, PROTOCOL, ReplyBody, Request, WireError,
};
use std::io::{BufRead, Write};
use std::sync::Arc;

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

/// The backend this build has: the Windows calls on Windows, none elsewhere.
pub fn native_backend() -> Arc<dyn Backend> {
    #[cfg(windows)]
    {
        Arc::new(win::WinBackend::new())
    }
    #[cfg(not(windows))]
    {
        Arc::new(backend::Unsupported)
    }
}

pub struct Session {
    info: BuildInfo,
    backend: Arc<dyn Backend>,
    sink: Arc<Sink>,
}

impl Session {
    pub fn new(mut info: BuildInfo, backend: Arc<dyn Backend>, sink: Arc<Sink>) -> Session {
        backend.describe(&mut info);
        Session {
            info,
            backend,
            sink,
        }
    }

    /// Handles one request line. The reply is written to the sink, now for
    /// `hello`, `cancel` and `quit` and a decode failure, later for the rest.
    pub fn handle_line(&mut self, line: &str) -> Flow {
        let (id, request) = match protocol::decode_request(line) {
            Ok(decoded) => decoded,
            Err(e) => {
                // A line that never named an id is answered with id 0: the
                // caller's ids start at 1, so 0 reads as "no request".
                self.sink
                    .line(&protocol::encode_reply(e.id.unwrap_or(0), &Err(e.error)));
                return Flow::Continue;
            }
        };
        match request {
            Request::Hello(h) => {
                let reply = if h.protocol != PROTOCOL {
                    Err(WireError::new(
                        ErrorCode::ProtocolMismatch,
                        format!("this helper speaks {PROTOCOL}, not {}", h.protocol),
                    ))
                } else {
                    let i = &self.info;
                    Ok(ReplyBody::Hello(HelloReply {
                        version: i.version.clone(),
                        build_hash: i.build_hash.clone(),
                        arch: i.arch.clone(),
                        os_build: i.os_build.clone(),
                        signer: i.signer.clone(),
                        caps: i.caps.clone(),
                        dpi_awareness: i.dpi_awareness.clone(),
                    }))
                };
                self.sink.line(&protocol::encode_reply(id, &reply));
                Flow::Continue
            }
            Request::Quit => {
                self.sink
                    .line(&protocol::encode_reply(id, &Ok(ReplyBody::Ack)));
                Flow::Quit
            }
            Request::Cancel(c) => {
                self.backend.cancel(c.target);
                self.sink
                    .line(&protocol::encode_reply(id, &Ok(ReplyBody::Ack)));
                Flow::Continue
            }
            other => {
                self.backend
                    .start(other, Responder::new(id, Arc::clone(&self.sink)));
                Flow::Continue
            }
        }
    }
}

/// Runs the protocol over a reader and a writer until `quit` or end of input.
/// Diagnostics belong on stderr; stdout carries replies only.
pub fn run(
    input: impl BufRead,
    output: impl Write + Send + 'static,
    info: BuildInfo,
    backend: Arc<dyn Backend>,
) -> std::io::Result<()> {
    let mut session = Session::new(info, backend, Arc::new(Sink::new(output)));
    let mut result = Ok(());
    for line in input.lines() {
        let line = match line {
            Ok(line) => line,
            Err(e) => {
                result = Err(e);
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        if session.handle_line(&line) == Flow::Quit {
            break;
        }
    }
    // Whether the caller said `quit`, closed the pipe or the pipe failed.
    session.backend.shutdown();
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use backend::Unsupported;
    use namzu_win_core::protocol::{Op, SeqReply, decode_reply};
    use std::sync::{Mutex, mpsc};

    /// A writer the test reads back.
    #[derive(Clone, Default)]
    struct Capture(Arc<Mutex<Vec<u8>>>);

    impl Write for Capture {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Capture {
        fn lines(&self) -> Vec<String> {
            String::from_utf8(self.0.lock().unwrap().clone())
                .unwrap()
                .lines()
                .map(str::to_owned)
                .collect()
        }
    }

    fn info() -> BuildInfo {
        BuildInfo {
            version: "9.9.9".into(),
            build_hash: "abc".into(),
            arch: "x86_64".into(),
            os_build: "1".into(),
            signer: None,
            caps: vec![],
            dpi_awareness: "unknown".into(),
        }
    }

    fn session(backend: Arc<dyn Backend>) -> (Session, Capture) {
        let out = Capture::default();
        let s = Session::new(info(), backend, Arc::new(Sink::new(out.clone())));
        (s, out)
    }

    #[test]
    fn hello_names_the_build() {
        let (mut s, out) = session(Arc::new(Unsupported));
        let flow = s
            .handle_line(r#"{"id":1,"op":"hello","protocol":"namzu-win/1","cliVersion":"55.0.0"}"#);
        assert_eq!(flow, Flow::Continue);
        let (id, reply) = decode_reply(Op::Hello, &out.lines()[0]).unwrap();
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
        let (mut s, out) = session(Arc::new(Unsupported));
        s.handle_line(r#"{"id":2,"op":"hello","protocol":"namzu-win/2","cliVersion":"1"}"#);
        let (_, reply) = decode_reply(Op::Hello, &out.lines()[0]).unwrap();
        assert_eq!(reply.unwrap_err().code, "protocol_mismatch");
    }

    #[test]
    fn an_op_without_an_implementation_says_so() {
        let (mut s, out) = session(Arc::new(Unsupported));
        assert_eq!(s.handle_line(r#"{"id":3,"op":"displays"}"#), Flow::Continue);
        let (id, reply) = decode_reply(Op::Displays, &out.lines()[0]).unwrap();
        assert_eq!(id, 3);
        let e = reply.unwrap_err();
        assert_eq!(e.code, "unsupported");
        assert!(e.message.contains("displays"));
    }

    #[test]
    fn a_bad_line_is_answered_and_the_loop_goes_on() {
        let (mut s, out) = session(Arc::new(Unsupported));
        assert_eq!(s.handle_line("not json"), Flow::Continue);
        let (id, reply) = decode_reply(Op::Quit, &out.lines()[0]).unwrap();
        assert_eq!(id, 0);
        assert_eq!(reply.unwrap_err().code, "bad_request");
    }

    #[test]
    fn run_stops_at_quit_and_skips_blank_lines() {
        let input = b"\n{\"id\":1,\"op\":\"quit\"}\n{\"id\":2,\"op\":\"displays\"}\n";
        let out = Capture::default();
        run(&input[..], out.clone(), info(), Arc::new(Unsupported)).unwrap();
        let lines = out.lines();
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains(r#""ok":true"#));
    }

    /// A backend that only counts how often it was shut down.
    #[derive(Default)]
    struct Counting(std::sync::atomic::AtomicU32);

    impl Backend for Counting {
        fn start(&self, _request: Request, responder: Responder) {
            responder.fail(ErrorCode::Unsupported, "no");
        }
        fn shutdown(&self) {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }

    #[test]
    fn the_backend_is_shut_down_once_however_the_loop_ends() {
        for input in [&b"{\"id\":1,\"op\":\"quit\"}\n"[..], &b""[..]] {
            let backend = Arc::new(Counting::default());
            run(input, Capture::default(), info(), backend.clone()).unwrap();
            assert_eq!(backend.0.load(std::sync::atomic::Ordering::SeqCst), 1);
        }
    }

    /// A backend that answers later, from another thread, and records cancels.
    struct Later {
        pending: Mutex<Vec<Responder>>,
        cancelled: Mutex<Vec<u64>>,
        started: mpsc::Sender<u64>,
    }

    impl Backend for Later {
        fn start(&self, _request: Request, responder: Responder) {
            let id = responder.id();
            self.pending.lock().unwrap().push(responder);
            let _ = self.started.send(id);
        }
        fn cancel(&self, target: u64) {
            self.cancelled.lock().unwrap().push(target);
        }
    }

    #[test]
    fn a_slow_op_does_not_hold_up_the_next_line() {
        let (tx, rx) = mpsc::channel();
        let later = Arc::new(Later {
            pending: Mutex::new(Vec::new()),
            cancelled: Mutex::new(Vec::new()),
            started: tx,
        });
        let (mut s, out) = session(later.clone());
        s.handle_line(r#"{"id":5,"op":"seq"}"#);
        assert_eq!(rx.recv().unwrap(), 5);
        // The first is still pending; hello and cancel are answered meanwhile.
        s.handle_line(r#"{"id":6,"op":"hello","protocol":"namzu-win/1","cliVersion":"1"}"#);
        s.handle_line(r#"{"id":7,"op":"cancel","target":5}"#);
        assert_eq!(out.lines().len(), 2);
        assert_eq!(*later.cancelled.lock().unwrap(), vec![5]);
        // Now the backend answers.
        let r = later.pending.lock().unwrap().pop().unwrap();
        r.ok(ReplyBody::Seq(SeqReply { seq: 41 }));
        let lines = out.lines();
        let (id, reply) = decode_reply(Op::Seq, &lines[2]).unwrap();
        assert_eq!(id, 5);
        assert!(matches!(
            reply.unwrap(),
            ReplyBody::Seq(SeqReply { seq: 41 })
        ));
    }

    #[test]
    fn a_request_dropped_without_an_answer_is_answered_internal() {
        let (tx, _rx) = mpsc::channel();
        let later = Arc::new(Later {
            pending: Mutex::new(Vec::new()),
            cancelled: Mutex::new(Vec::new()),
            started: tx,
        });
        let (mut s, out) = session(later.clone());
        s.handle_line(r#"{"id":8,"op":"seq"}"#);
        later.pending.lock().unwrap().clear();
        let (id, reply) = decode_reply(Op::Seq, &out.lines()[0]).unwrap();
        assert_eq!(id, 8);
        assert_eq!(reply.unwrap_err().code, "internal");
    }

    #[test]
    fn the_first_answer_of_a_shared_responder_wins() {
        let out = Capture::default();
        let shared =
            backend::SharedResponder::new(Responder::new(9, Arc::new(Sink::new(out.clone()))));
        assert!(shared.ok(ReplyBody::Ack));
        assert!(!shared.fail(ErrorCode::Timeout, "late"));
        assert_eq!(out.lines().len(), 1);
    }
}
