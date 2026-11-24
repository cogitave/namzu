//! The identity of a control: what lets a caller find it again after the
//! window was read a second time.
//!
//! A control is named by the platform's runtime id first, else by its
//! automation id and kind, else by its kind, a hash of its name and the path
//! of its ancestors. The hash and the path are the same as the PowerShell
//! helper wrote, so a fingerprint taken by one backend resolves in the other.

use crate::protocol::{Fingerprint, NotFoundCode, Resolution, ResolveVia};
use std::collections::HashMap;

/// FNV-1a over the UTF-16 code units of `s`, as eight lowercase hex digits.
/// UTF-16 and not UTF-8 because the first implementation hashed a .NET
/// string, and a hash that differs per backend would break `resolve`.
pub fn name_hash(s: &str) -> String {
    let mut h: u32 = 2_166_136_261;
    for unit in s.encode_utf16() {
        h ^= u32::from(unit);
        h = h.wrapping_mul(16_777_619);
    }
    format!("{h:08x}")
}

/// `Button:1a2b3c4d`: the kind and the name hash, the unit a path is made of.
pub fn tag(role: &str, name: &str) -> String {
    format!("{role}:{}", name_hash(name))
}

/// A runtime id as the dotted decimal form the protocol carries.
pub fn runtime_id_string(rid: &[i32]) -> String {
    rid.iter()
        .map(|n| n.to_string())
        .collect::<Vec<_>>()
        .join(".")
}

/// One control as the platform reported it, before it has an identity.
#[derive(Debug, Clone)]
pub struct IdentityInput<'a> {
    /// Index of the parent in the same list, -1 for the window itself.
    pub parent: i32,
    pub role: &'a str,
    pub name: &'a str,
    pub automation_id: &'a str,
    pub runtime_id: &'a [i32],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub runtime_id: String,
    pub automation_id: String,
    pub role: String,
    pub name_hash: String,
    pub parent_path: String,
    pub ordinal: u32,
}

impl Identity {
    /// The wire form; `process_start` is when the owning process started (ms).
    pub fn to_fingerprint(&self, process_start: u64) -> Fingerprint {
        Fingerprint {
            runtime_id: self.runtime_id.clone(),
            automation_id: self.automation_id.clone(),
            role: self.role.clone(),
            name_hash: self.name_hash.clone(),
            parent_path: self.parent_path.clone(),
            ordinal: self.ordinal,
            process_start,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrderError {
    pub index: usize,
    pub parent: i32,
}

impl std::fmt::Display for OrderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "node {} names parent {}, which is not an earlier node",
            self.index, self.parent
        )
    }
}

impl std::error::Error for OrderError {}

/// Gives every control of a depth-first list its identity. A parent must come
/// before its children, as a tree walk produces them.
pub fn assign(nodes: &[IdentityInput<'_>]) -> Result<Vec<Identity>, OrderError> {
    let mut out: Vec<Identity> = Vec::with_capacity(nodes.len());
    let mut tags: Vec<String> = Vec::with_capacity(nodes.len());
    // How many children of each parent already carry a given tag.
    let mut seen: HashMap<(i32, String), u32> = HashMap::new();
    for (i, n) in nodes.iter().enumerate() {
        let t = tag(n.role, n.name);
        let (parent_path, ordinal) = if n.parent < 0 {
            (String::new(), 0)
        } else {
            let p = n.parent as usize;
            if p >= i {
                return Err(OrderError {
                    index: i,
                    parent: n.parent,
                });
            }
            let ptag = &tags[p];
            let ppath = &out[p].parent_path;
            let path = if ppath.is_empty() {
                ptag.clone()
            } else {
                format!("{ppath}/{ptag}")
            };
            let count = seen.entry((n.parent, t.clone())).or_insert(0);
            let ord = *count;
            *count += 1;
            (path, ord)
        };
        out.push(Identity {
            runtime_id: runtime_id_string(n.runtime_id),
            automation_id: n.automation_id.to_owned(),
            role: n.role.to_owned(),
            name_hash: name_hash(n.name),
            parent_path,
            ordinal,
        });
        tags.push(t);
    }
    Ok(out)
}

/// A control from a fresh read, to be compared with a fingerprint.
#[derive(Debug, Clone)]
pub struct Candidate {
    pub index: u32,
    pub identity: Identity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Match {
    Found { index: u32, via: ResolveVia },
    NotFound,
    Ambiguous { candidates: u32 },
}

fn narrow(hits: Vec<&Candidate>, keep: impl Fn(&Candidate) -> bool) -> Vec<&Candidate> {
    if hits.len() <= 1 {
        return hits;
    }
    let by: Vec<&Candidate> = hits.iter().copied().filter(|c| keep(c)).collect();
    if by.is_empty() { hits } else { by }
}

fn decide(hits: &[&Candidate], via: ResolveVia) -> Option<Match> {
    match hits.len() {
        0 => None,
        1 => Some(Match::Found {
            index: hits[0].index,
            via,
        }),
        n => Some(Match::Ambiguous {
            candidates: n as u32,
        }),
    }
}

/// Finds the control `fp` named among `candidates`: by runtime id when it
/// still matches, else by automation id and kind (narrowed by path, then
/// ordinal), else by kind, name hash and path (narrowed by ordinal).
pub fn resolve(fp: &Fingerprint, candidates: &[Candidate]) -> Match {
    if !fp.runtime_id.is_empty() {
        let hits: Vec<&Candidate> = candidates
            .iter()
            .filter(|c| c.identity.runtime_id == fp.runtime_id)
            .collect();
        if let Some(m) = decide(&hits, ResolveVia::RuntimeId) {
            return m;
        }
    }
    if !fp.automation_id.is_empty() {
        let hits: Vec<&Candidate> = candidates
            .iter()
            .filter(|c| c.identity.automation_id == fp.automation_id && c.identity.role == fp.role)
            .collect();
        let hits = narrow(hits, |c| c.identity.parent_path == fp.parent_path);
        let hits = narrow(hits, |c| c.identity.ordinal == fp.ordinal);
        if let Some(m) = decide(&hits, ResolveVia::AutomationId) {
            return m;
        }
    }
    let hits: Vec<&Candidate> = candidates
        .iter()
        .filter(|c| {
            c.identity.role == fp.role
                && c.identity.name_hash == fp.name_hash
                && c.identity.parent_path == fp.parent_path
        })
        .collect();
    let hits = narrow(hits, |c| c.identity.ordinal == fp.ordinal);
    decide(&hits, ResolveVia::Name).unwrap_or(Match::NotFound)
}

/// False only when both starts are known and differ: a different run of the
/// program, whose controls a fingerprint no longer names.
pub fn same_process_run(expected: u64, now: u64) -> bool {
    expected == 0 || now == 0 || expected == now
}

impl Match {
    /// The wire answer, once the read that produced the candidates has `revision`.
    pub fn into_resolution(self, revision: u64) -> Resolution {
        match self {
            Match::Found { index, via } => Resolution::Found {
                index,
                via,
                revision,
            },
            Match::NotFound => Resolution::Missing {
                code: NotFoundCode::NotFound,
                candidates: None,
            },
            Match::Ambiguous { candidates } => Resolution::Missing {
                code: NotFoundCode::Ambiguous,
                candidates: Some(candidates),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_hash_is_fnv1a_over_utf16() {
        assert_eq!(name_hash(""), "811c9dc5");
        assert_eq!(name_hash("a"), "e40c292c");
        // U+1F600 is two UTF-16 units; hashing UTF-8 bytes would differ.
        assert_ne!(name_hash("\u{1F600}"), name_hash("\u{FFFD}"));
    }

    #[test]
    fn ordinals_count_per_parent_and_tag() {
        let rid: [i32; 0] = [];
        let n = |parent, role, name| IdentityInput {
            parent,
            role,
            name,
            automation_id: "",
            runtime_id: &rid,
        };
        let ids = assign(&[
            n(-1, "Window", "w"),
            n(0, "Button", "ok"),
            n(0, "Button", "ok"),
            n(0, "Button", "cancel"),
            n(2, "Text", "t"),
        ])
        .unwrap();
        assert_eq!(ids[1].ordinal, 0);
        assert_eq!(ids[2].ordinal, 1);
        assert_eq!(ids[3].ordinal, 0);
        assert_eq!(ids[0].parent_path, "");
        assert_eq!(ids[1].parent_path, tag("Window", "w"));
        assert_eq!(
            ids[4].parent_path,
            format!("{}/{}", tag("Window", "w"), tag("Button", "ok"))
        );
    }

    #[test]
    fn a_parent_after_its_child_is_refused() {
        let rid: [i32; 0] = [];
        let bad = [IdentityInput {
            parent: 3,
            role: "Button",
            name: "",
            automation_id: "",
            runtime_id: &rid,
        }];
        assert!(assign(&bad).is_err());
    }

    #[test]
    fn process_runs() {
        assert!(same_process_run(0, 5));
        assert!(same_process_run(5, 0));
        assert!(same_process_run(5, 5));
        assert!(!same_process_run(5, 6));
    }
}
