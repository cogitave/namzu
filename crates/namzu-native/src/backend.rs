//! What answers the ops that need the platform, and how a reply gets back.
//!
//! The loop reads one line at a time but an op may take a while (a read of a
//! window, a wait for it to change), so a request is handed to a [`Backend`]
//! with a [`Responder`] and the loop goes on reading. The responder writes
//! the reply line whenever the backend has it, from any thread. A request
//! that is dropped without an answer is answered with an `internal` error:
//! a caller waiting on an id never waits forever because of a bug here.

use namzu_native_core::protocol::{self, ErrorCode, ReplyBody, Request, WireError};
use std::io::Write;
use std::sync::{Arc, Mutex};

use crate::BuildInfo;

pub type Reply = Result<ReplyBody, WireError>;

/// The stdout of the helper: one writer, one line at a time.
pub struct Sink {
    out: Mutex<Box<dyn Write + Send>>,
}

impl Sink {
    pub fn new(out: impl Write + Send + 'static) -> Sink {
        Sink {
            out: Mutex::new(Box::new(out)),
        }
    }

    /// Writes `line` and a newline. A reader that went away is not an error
    /// worth stopping for: the loop ends when its input does.
    pub fn line(&self, line: &str) {
        let mut out = match self.out.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let _ = writeln!(out, "{line}");
        let _ = out.flush();
    }
}

/// The right to answer one request, once.
pub struct Responder {
    id: u64,
    sink: Option<Arc<Sink>>,
}

impl Responder {
    pub fn new(id: u64, sink: Arc<Sink>) -> Responder {
        Responder {
            id,
            sink: Some(sink),
        }
    }

    pub fn id(&self) -> u64 {
        self.id
    }

    pub fn send(mut self, reply: Reply) {
        if let Some(sink) = self.sink.take() {
            sink.line(&protocol::encode_reply(self.id, &reply));
        }
    }

    pub fn ok(self, body: ReplyBody) {
        self.send(Ok(body));
    }

    pub fn fail(self, code: ErrorCode, message: impl Into<String>) {
        self.send(Err(WireError::new(code, message)));
    }
}

impl Drop for Responder {
    fn drop(&mut self) {
        if let Some(sink) = self.sink.take() {
            let e = WireError::new(
                ErrorCode::Internal,
                "the helper ended this request without an answer",
            );
            sink.line(&protocol::encode_reply(self.id, &Err(e)));
        }
    }
}

/// A responder two places may try to answer (the work and the watchdog, or
/// the work and a cancel): the first answer is sent, the rest are ignored.
#[derive(Clone)]
pub struct SharedResponder(Arc<Mutex<Option<Responder>>>);

impl SharedResponder {
    pub fn new(responder: Responder) -> SharedResponder {
        SharedResponder(Arc::new(Mutex::new(Some(responder))))
    }

    /// True when this call sent the answer.
    pub fn send(&self, reply: Reply) -> bool {
        let taken = match self.0.lock() {
            Ok(mut guard) => guard.take(),
            Err(poisoned) => poisoned.into_inner().take(),
        };
        match taken {
            Some(responder) => {
                responder.send(reply);
                true
            }
            None => false,
        }
    }

    pub fn ok(&self, body: ReplyBody) -> bool {
        self.send(Ok(body))
    }

    pub fn fail(&self, code: ErrorCode, message: impl Into<String>) -> bool {
        self.send(Err(WireError::new(code, message)))
    }
}

/// Answers the ops beyond `hello`, `cancel` and `quit`.
pub trait Backend: Send + Sync {
    /// Fills in what only the platform knows (OS build, DPI awareness, `caps`).
    fn describe(&self, _info: &mut BuildInfo) {}
    /// Takes a request. Returns at once; the answer goes through `responder`.
    fn start(&self, request: Request, responder: Responder);
    /// Stops request `target` if it has not been answered; it is then
    /// answered `cancelled`. A request already answered is left alone.
    fn cancel(&self, _target: u64) {}
    /// The loop ended (`quit`, or the caller went away): undo what the backend
    /// holds on the caller's behalf. Runs once, on the loop's thread.
    fn shutdown(&self) {}
}

/// The backend of a build that cannot touch the platform (any non-Windows target).
pub struct Unsupported;

impl Backend for Unsupported {
    fn start(&self, request: Request, responder: Responder) {
        responder.fail(
            ErrorCode::Unsupported,
            format!("{} is not implemented in this build", request.op().name()),
        );
    }
}
