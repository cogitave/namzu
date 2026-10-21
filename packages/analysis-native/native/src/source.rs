//! Opening a caller-named file for analysis.
//!
//! The target is hostile input and is only ever read: it is never executed,
//! loaded as a library, or written to. A path must name a regular file, and
//! that is checked on the opened descriptor, not on the path alone, so a
//! symlink swapped in after the check cannot turn into a device or a FIFO.

use std::fs::{File, OpenOptions};
use std::ops::Deref;
use std::path::Path;

use memmap2::Mmap;

use crate::ctx::Limits;
use crate::error::{OpError, OpResult};

/// The bytes of a target file.
pub enum Source {
    Mapped(Mmap),
    Empty,
}

impl Deref for Source {
    type Target = [u8];

    fn deref(&self) -> &[u8] {
        match self {
            Source::Mapped(m) => m,
            Source::Empty => &[],
        }
    }
}

/// `O_NONBLOCK`, so that opening a FIFO that slipped in after the first
/// `metadata` check returns at once instead of waiting for a writer.
#[cfg(target_os = "linux")]
const O_NONBLOCK: i32 = 0o4000;
#[cfg(target_os = "macos")]
const O_NONBLOCK: i32 = 0x0004;

fn open_read_only(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(O_NONBLOCK);
    }
    options.open(path)
}

/// Map a file read-only.
///
/// `unsafe` is unavoidable here: the operating system gives no safe way to map
/// a file. The mapping is read-only and private. The one hazard is another
/// process truncating the file while it is mapped, which can end this process
/// with SIGBUS; the client treats a sidecar exit as a failed request and starts
/// a new process, so a hostile truncation costs a request, not memory safety
/// of the host. Every other use of the bytes is bounds-checked safe Rust.
#[allow(unsafe_code)]
fn map(file: &File) -> std::io::Result<Mmap> {
    // SAFETY: see the function comment; the mapping is read-only.
    unsafe { Mmap::map(file) }
}

/// Open `path` if it is a regular file no larger than the limit.
pub fn open_regular(path: &str, limits: &Limits) -> OpResult<Source> {
    if path.is_empty() || path.contains('\0') {
        return Err(OpError::invalid_params(
            "path must be a non-empty string without NUL",
        ));
    }
    let path = Path::new(path);
    let describe = |e: std::io::Error| {
        OpError::new(
            "file_error",
            format!("cannot open {}: {}", path.display(), e),
        )
    };
    // `metadata` follows symlinks: a link to a regular file is accepted, a
    // link to a device, directory or FIFO is not.
    let before = std::fs::metadata(path).map_err(describe)?;
    if !before.is_file() {
        return Err(OpError::new(
            "not_regular_file",
            format!("{} is not a regular file", path.display()),
        ));
    }
    let file = open_read_only(path).map_err(describe)?;
    let meta = file.metadata().map_err(describe)?;
    if !meta.is_file() {
        return Err(OpError::new(
            "not_regular_file",
            format!("{} is not a regular file", path.display()),
        ));
    }
    let size = meta.len();
    if size > limits.max_file_bytes {
        return Err(OpError::new(
            "too_large",
            format!(
                "{} is {} bytes, over the {} byte limit",
                path.display(),
                size,
                limits.max_file_bytes
            ),
        ));
    }
    if size == 0 {
        return Ok(Source::Empty);
    }
    map(&file).map(Source::Mapped).map_err(describe)
}
