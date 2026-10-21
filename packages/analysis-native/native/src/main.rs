//! The sidecar executable. Protocol on stdout, diagnostics on stderr.

use std::io::{self, BufReader, BufWriter};

use namzu_analysis_native::{Limits, serve};

fn main() {
    let mut limits = Limits::default();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--version" => {
                println!("namzu-analysis-native {}", env!("CARGO_PKG_VERSION"));
                return;
            }
            "--max-file-bytes" => match args.next().and_then(|v| v.parse().ok()) {
                Some(n) => limits.max_file_bytes = n,
                None => fail("--max-file-bytes needs a number"),
            },
            "--max-request-bytes" => match args.next().and_then(|v| v.parse().ok()) {
                Some(n) => limits.max_request_bytes = n,
                None => fail("--max-request-bytes needs a number"),
            },
            other => fail(&format!("unknown argument {other}")),
        }
    }
    let stdin = io::stdin().lock();
    let stdout = io::stdout().lock();
    if let Err(e) = serve(BufReader::new(stdin), BufWriter::new(stdout), limits) {
        // A closed pipe is the normal end when the client goes away.
        if e.kind() != io::ErrorKind::BrokenPipe {
            eprintln!("namzu-analysis-native: {e}");
            std::process::exit(1);
        }
    }
}

fn fail(message: &str) -> ! {
    eprintln!("namzu-analysis-native: {message}");
    std::process::exit(2);
}
