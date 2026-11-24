//! What the Windows integration tests share: the helper as a child process,
//! driven over its standard input and output.
#![cfg(windows)]
#![allow(dead_code)]

use namzu_win_core::protocol::{self, Op, ReplyBody, Request, WireError};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, channel};

/// The helper as a child process.
pub struct Helper {
    pub child: Child,
    stdin: ChildStdin,
    lines: Receiver<String>,
    /// Replies that arrived while another id was awaited.
    parked: HashMap<u64, String>,
    next_id: u64,
}

impl Helper {
    pub fn start() -> Helper {
        let mut child = Command::new(env!("CARGO_BIN_EXE_namzu-win"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("start namzu-win");
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, lines) = channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        Helper {
            child,
            stdin,
            lines,
            parked: HashMap::new(),
            next_id: 1,
        }
    }

    /// Writes a request and returns its id without waiting for the answer.
    pub fn send(&mut self, request: &Request) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        writeln!(self.stdin, "{}", protocol::encode_request(id, request)).unwrap();
        self.stdin.flush().unwrap();
        id
    }

    pub fn await_reply(&mut self, id: u64, op: Op) -> Result<ReplyBody, WireError> {
        loop {
            let line = match self.parked.remove(&id) {
                Some(line) => line,
                None => {
                    let line = self.lines.recv().expect("the helper ended");
                    let value: serde_json::Value = serde_json::from_str(&line).unwrap();
                    let got = value["id"].as_u64().unwrap();
                    if got != id {
                        self.parked.insert(got, line);
                        continue;
                    }
                    line
                }
            };
            let (got, reply) = protocol::decode_reply(op, &line).expect("a reply the codec reads");
            assert_eq!(got, id);
            return reply;
        }
    }

    pub fn call(&mut self, request: Request) -> Result<ReplyBody, WireError> {
        let op = request.op();
        let id = self.send(&request);
        self.await_reply(id, op)
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.call(Request::Quit);
        let _ = self.child.wait();
    }
}

pub fn hello(h: &mut Helper) {
    let reply = h
        .call(Request::Hello(protocol::HelloRequest {
            protocol: protocol::PROTOCOL.to_owned(),
            cli_version: "test".to_owned(),
        }))
        .unwrap();
    let ReplyBody::Hello(hello) = reply else {
        panic!("{reply:?}")
    };
    assert_eq!(hello.dpi_awareness, "perMonitorV2");
    assert!(hello.os_build.parse::<u32>().is_ok(), "{}", hello.os_build);
    for cap in [
        "windows",
        "displays",
        "snapshot",
        "wait_change",
        "uia",
        "hooks",
    ] {
        assert!(hello.caps.iter().any(|c| c == cap), "missing cap {cap}");
    }
}
