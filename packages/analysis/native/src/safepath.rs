//! Writing files named by hostile input into a directory without escaping it.
//!
//! A module name read from an embedded payload is attacker-controlled. Nothing
//! in this file trusts one: a name is reduced to plain path components or
//! refused, and the output directory is created by us, empty, so there is no
//! pre-existing link to follow.

use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::error::{OpError, OpResult};

/// Prefixes Bun gives the virtual file system of a compiled executable.
const KNOWN_PREFIXES: &[&str] = &[
    "/$bunfs/root/",
    "B:/~BUN/root/",
    "B:\\~BUN\\root\\",
    "/$bunfs/",
    "B:/~BUN/",
];

/// Names the client uses for its own files in an output directory (the
/// provenance record). A payload may not occupy one.
pub const RESERVED_PREFIX: &str = ".namzu-";

const MAX_COMPONENT: usize = 200;
const MAX_PATH: usize = 1024;

const WINDOWS_DEVICES: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Reduce a module name to relative path components, or say why not.
pub fn safe_components(name: &str) -> Result<Vec<String>, String> {
    if name.is_empty() {
        return Err("empty name".into());
    }
    if name.contains('\0') {
        return Err("name contains a NUL byte".into());
    }
    if name.chars().any(|c| c.is_control()) {
        return Err("name contains a control character".into());
    }
    let mut rest = name;
    for prefix in KNOWN_PREFIXES {
        if let Some(r) = rest.strip_prefix(prefix) {
            rest = r;
            break;
        }
    }
    if rest.starts_with('/') || rest.starts_with('\\') {
        return Err("absolute path".into());
    }
    let mut out = Vec::new();
    for part in rest.split(['/', '\\']) {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err("path traversal (`..`)".into());
        }
        if part.contains(':') {
            return Err("component contains `:` (drive letter or stream)".into());
        }
        if part.to_ascii_lowercase().starts_with(RESERVED_PREFIX) {
            return Err(format!("`{RESERVED_PREFIX}*` names are reserved"));
        }
        if part.len() > MAX_COMPONENT {
            return Err("component too long".into());
        }
        if part.ends_with('.') || part.ends_with(' ') {
            return Err("component ends with a dot or space".into());
        }
        let stem = part.split('.').next().unwrap_or("").to_ascii_lowercase();
        if WINDOWS_DEVICES.contains(&stem.as_str()) {
            return Err("reserved device name".into());
        }
        out.push(part.to_string());
    }
    if out.is_empty() {
        return Err("name has no path components".into());
    }
    if out.iter().map(|c| c.len() + 1).sum::<usize>() > MAX_PATH {
        return Err("path too long".into());
    }
    Ok(out)
}

/// A new or empty directory that modules are written into.
pub struct OutDir {
    root: PathBuf,
    seen: HashSet<String>,
}

impl OutDir {
    /// The directory must not exist, or be an empty real directory (not a link).
    pub fn prepare(path: &str) -> OpResult<OutDir> {
        if path.is_empty() || path.contains('\0') {
            return Err(OpError::invalid_params(
                "outDir must be a non-empty string without NUL",
            ));
        }
        let p = Path::new(path);
        let io =
            |e: std::io::Error| OpError::new("io_error", format!("outDir {}: {}", p.display(), e));
        match fs::symlink_metadata(p) {
            Ok(meta) => {
                if !meta.is_dir() {
                    return Err(OpError::new(
                        "out_dir_invalid",
                        format!("outDir {} exists and is not a directory", p.display()),
                    ));
                }
                if fs::read_dir(p).map_err(io)?.next().is_some() {
                    return Err(OpError::new(
                        "out_dir_invalid",
                        format!("outDir {} is not empty", p.display()),
                    ));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir_all(p).map_err(io)?;
            }
            Err(e) => return Err(io(e)),
        }
        let root = fs::canonicalize(p).map_err(io)?;
        Ok(OutDir {
            root,
            seen: HashSet::new(),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Write `bytes` at `components` under the root. Refuses a path already
    /// written (case-insensitively, so the result is the same on every OS).
    pub fn write(&mut self, components: &[String], bytes: &[u8]) -> Result<PathBuf, String> {
        let key = components.join("/").to_lowercase();
        if !self.seen.insert(key) {
            return Err("collides with another module of the same path".into());
        }
        let mut dir = self.root.clone();
        for c in &components[..components.len() - 1] {
            dir.push(c);
            match fs::create_dir(&dir) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    // We created every directory ourselves; anything else
                    // here is a file written earlier under the same name.
                    let meta = fs::symlink_metadata(&dir).map_err(|e| e.to_string())?;
                    if !meta.is_dir() {
                        return Err("a parent of this path is a file".into());
                    }
                }
                Err(e) => return Err(e.to_string()),
            }
        }
        let file_path = dir.join(&components[components.len() - 1]);
        if !file_path.starts_with(&self.root) {
            return Err("path escapes the output directory".into());
        }
        // `create_new` is O_EXCL: it never follows a link and never overwrites.
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&file_path)
            .map_err(|e| e.to_string())?;
        f.write_all(bytes).map_err(|e| e.to_string())?;
        Ok(file_path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_bun_prefixes() {
        assert_eq!(
            safe_components("/$bunfs/root/src/a.js").unwrap(),
            vec!["src", "a.js"]
        );
        assert_eq!(safe_components("B:/~BUN/root/a.js").unwrap(), vec!["a.js"]);
    }

    #[test]
    fn refuses_hostile_names() {
        for bad in [
            "../x",
            "/$bunfs/root/../../etc/passwd",
            "a/../../b",
            "/etc/passwd",
            "C:\\Windows\\x",
            "a\0b",
            "a\\..\\b",
            "CON.js",
            "dir/aux",
            "",
            "///",
            "x.",
            "a\nb",
            ".namzu-provenance.json",
            "sub/.NAMZU-x",
        ] {
            assert!(safe_components(bad).is_err(), "{bad:?} must be refused");
        }
    }

    #[test]
    fn writes_inside_root_and_refuses_collisions() {
        let tmp = tempfile::tempdir().unwrap();
        let mut out = OutDir::prepare(tmp.path().join("o").to_str().unwrap()).unwrap();
        let p = out.write(&["a".into(), "b.js".into()], b"x").unwrap();
        assert!(p.starts_with(out.root()));
        assert!(out.write(&["A".into(), "B.js".into()], b"y").is_err());
        assert!(out.write(&["a".into()], b"y").is_err());
    }

    #[test]
    fn refuses_non_empty_out_dir() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("f"), b"1").unwrap();
        assert!(OutDir::prepare(tmp.path().to_str().unwrap()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlink_out_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("real");
        fs::create_dir(&real).unwrap();
        let link = tmp.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(OutDir::prepare(link.to_str().unwrap()).is_err());
    }
}
