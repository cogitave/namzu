//! The table that turns a ref back into a control.
//!
//! A snapshot names every control `r<revision>.<index>`. The helper keeps
//! what it needs to act on a control (on Windows, the live UI Automation
//! element) for the window's current read and the one before it, so an
//! `act` that races a re-read still lands on the control the caller saw.
//! `T` is that handle; this crate never looks inside it.

use std::collections::HashMap;

/// Writes the ref of control `index` in read `revision`.
pub fn format_ref(revision: u64, index: u32) -> String {
    format!("r{revision}.{index}")
}

/// Reads `r<revision>.<index>`; `None` for anything else, including leading
/// zeros, signs and spaces, so one control has one spelling.
pub fn parse_ref(s: &str) -> Option<(u64, u32)> {
    let rest = s.strip_prefix('r')?;
    let (rev, idx) = rest.split_once('.')?;
    let revision: u64 = canonical_number(rev)?;
    (revision <= crate::protocol::MAX_SAFE_INTEGER).then_some(())?;
    Some((revision, canonical_number(idx)?))
}

fn canonical_number<N: std::str::FromStr>(s: &str) -> Option<N> {
    let plain = !s.is_empty()
        && s.bytes().all(|b| b.is_ascii_digit())
        && (s.len() == 1 || !s.starts_with('0'));
    if plain { s.parse().ok() } else { None }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RefError {
    /// Not of the form `r<revision>.<index>`.
    Malformed,
    /// No read of that window is held (never read, or forgotten).
    UnknownWindow,
    /// The read the ref names is older than the two held: `stale_snapshot`.
    Stale { current: u64 },
    /// The read the ref names is newer than any this helper made.
    FromTheFuture { current: u64 },
    /// The read has no control at that index.
    OutOfRange { revision: u64, len: usize },
}

impl std::fmt::Display for RefError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RefError::Malformed => write!(f, "a ref looks like r<revision>.<index>"),
            RefError::UnknownWindow => write!(f, "the window has not been read"),
            RefError::Stale { current } => {
                write!(
                    f,
                    "the ref is from an older read; the window is at {current}"
                )
            }
            RefError::FromTheFuture { current } => {
                write!(
                    f,
                    "the ref is from a read not made; the window is at {current}"
                )
            }
            RefError::OutOfRange { revision, len } => {
                write!(f, "read {revision} has {len} controls")
            }
        }
    }
}

impl std::error::Error for RefError {}

#[derive(Debug)]
struct Read<T> {
    revision: u64,
    entries: Vec<T>,
}

#[derive(Debug)]
struct WindowReads<T> {
    last_revision: u64,
    current: Option<Read<T>>,
    previous: Option<Read<T>>,
}

#[derive(Debug)]
pub struct Lookup<'a, T> {
    pub entry: &'a T,
    /// False when the ref is from the read before the current one.
    pub is_current: bool,
}

#[derive(Debug)]
pub struct RefTable<T> {
    windows: HashMap<String, WindowReads<T>>,
}

impl<T> Default for RefTable<T> {
    fn default() -> Self {
        RefTable {
            windows: HashMap::new(),
        }
    }
}

impl<T> RefTable<T> {
    pub fn new() -> Self {
        Self::default()
    }

    /// Records a read of `window`: its controls in snapshot order. Returns the
    /// read's revision (1 for the first read of a window, then counting up).
    /// The read before the new one stays held; the one before that is dropped.
    pub fn publish(&mut self, window: &str, entries: Vec<T>) -> u64 {
        let w = self
            .windows
            .entry(window.to_owned())
            .or_insert_with(|| WindowReads {
                last_revision: 0,
                current: None,
                previous: None,
            });
        w.last_revision += 1;
        let revision = w.last_revision;
        w.previous = w.current.take();
        w.current = Some(Read { revision, entries });
        revision
    }

    /// The revision of the window's latest read.
    pub fn current_revision(&self, window: &str) -> Option<u64> {
        self.windows
            .get(window)
            .and_then(|w| w.current.as_ref())
            .map(|r| r.revision)
    }

    pub fn get(&self, window: &str, reference: &str) -> Result<Lookup<'_, T>, RefError> {
        let (revision, index) = parse_ref(reference).ok_or(RefError::Malformed)?;
        let w = self.windows.get(window).ok_or(RefError::UnknownWindow)?;
        let current = w.current.as_ref().ok_or(RefError::UnknownWindow)?;
        let (read, is_current) = if revision == current.revision {
            (current, true)
        } else if let Some(prev) = w.previous.as_ref().filter(|p| p.revision == revision) {
            (prev, false)
        } else if revision > current.revision {
            return Err(RefError::FromTheFuture {
                current: current.revision,
            });
        } else {
            return Err(RefError::Stale {
                current: current.revision,
            });
        };
        match read.entries.get(index as usize) {
            Some(entry) => Ok(Lookup { entry, is_current }),
            None => Err(RefError::OutOfRange {
                revision,
                len: read.entries.len(),
            }),
        }
    }

    /// Drops everything held for a window that closed.
    pub fn forget(&mut self, window: &str) -> bool {
        self.windows.remove(window).is_some()
    }

    pub fn windows(&self) -> usize {
        self.windows.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refs_have_one_spelling() {
        assert_eq!(format_ref(3, 17), "r3.17");
        assert_eq!(parse_ref("r3.17"), Some((3, 17)));
        for bad in [
            "", "r", "r3", "r3.", "r.3", "3.17", "r03.1", "r3.01", "r-1.2", "r3.1 ", "R3.1",
            "r3.1.2",
        ] {
            assert_eq!(parse_ref(bad), None, "{bad:?}");
        }
        assert_eq!(parse_ref("r0.0"), Some((0, 0)));
        assert_eq!(parse_ref("r99999999999999999999.0"), None);
    }

    #[test]
    fn the_current_and_the_previous_read_resolve_and_older_ones_are_stale() {
        let mut t: RefTable<&str> = RefTable::new();
        assert_eq!(t.publish("w", vec!["a0", "a1"]), 1);
        assert_eq!(t.publish("w", vec!["b0"]), 2);
        let hit = t.get("w", "r2.0").unwrap();
        assert_eq!((*hit.entry, hit.is_current), ("b0", true));
        let hit = t.get("w", "r1.1").unwrap();
        assert_eq!((*hit.entry, hit.is_current), ("a1", false));
        assert_eq!(t.publish("w", vec!["c0"]), 3);
        assert_eq!(
            t.get("w", "r1.0").unwrap_err(),
            RefError::Stale { current: 3 }
        );
        assert_eq!(
            t.get("w", "r4.0").unwrap_err(),
            RefError::FromTheFuture { current: 3 }
        );
        assert_eq!(
            t.get("w", "r3.5").unwrap_err(),
            RefError::OutOfRange {
                revision: 3,
                len: 1
            }
        );
    }

    #[test]
    fn windows_are_independent_and_can_be_forgotten() {
        let mut t: RefTable<u8> = RefTable::new();
        t.publish("a", vec![1]);
        t.publish("b", vec![2]);
        assert_eq!(t.publish("b", vec![3]), 2);
        assert_eq!(t.current_revision("a"), Some(1));
        assert!(t.forget("a"));
        assert_eq!(t.get("a", "r1.0").unwrap_err(), RefError::UnknownWindow);
        assert_eq!(t.get("b", "nonsense").unwrap_err(), RefError::Malformed);
        assert_eq!(t.windows(), 1);
    }
}
