//! The built executable, driven over its stdin and stdout.

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

fn spawn() -> std::process::Child {
    Command::new(env!("CARGO_BIN_EXE_namzu-win"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("the helper starts")
}

#[test]
fn it_answers_hello_and_ends_on_quit() {
    let mut child = spawn();
    let mut stdin = child.stdin.take().unwrap();
    let mut out = BufReader::new(child.stdout.take().unwrap()).lines();
    writeln!(
        stdin,
        r#"{{"id":1,"op":"hello","protocol":"namzu-win/1","cliVersion":"1"}}"#
    )
    .unwrap();
    let hello: serde_json::Value = serde_json::from_str(&out.next().unwrap().unwrap()).unwrap();
    assert_eq!(hello["id"], 1);
    assert_eq!(hello["ok"], true);
    assert_eq!(hello["version"], env!("CARGO_PKG_VERSION"));
    writeln!(stdin, r#"{{"id":2,"op":"quit"}}"#).unwrap();
    let quit: serde_json::Value = serde_json::from_str(&out.next().unwrap().unwrap()).unwrap();
    assert_eq!(quit["ok"], true);
    assert!(child.wait().unwrap().success());
}

#[test]
fn it_ends_when_stdin_closes() {
    let mut child = spawn();
    drop(child.stdin.take());
    assert!(child.wait().unwrap().success());
}
