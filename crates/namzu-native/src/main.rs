//! `namzu-native`: the native Windows helper. Reads requests on stdin, writes
//! replies on stdout, ends when stdin closes or on `quit`.

use std::io::{self, BufReader};
use std::process::ExitCode;

fn main() -> ExitCode {
    let stdin = BufReader::new(io::stdin().lock());
    let stdout = io::stdout();
    match namzu_native::run(
        stdin,
        stdout,
        namzu_native::BuildInfo::current(),
        namzu_native::native_backend(),
    ) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("namzu-native: {e}");
            ExitCode::FAILURE
        }
    }
}
