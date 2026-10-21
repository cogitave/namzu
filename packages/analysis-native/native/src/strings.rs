//! `strings`: printable runs, ASCII and UTF-16LE, with where they live.
//!
//! The scan covers the whole file, not only loaded sections, because payloads
//! appended to an executable are what an analyst is usually after. Each hit
//! carries its file offset, and the section and virtual address when the
//! offset falls inside a section.
//!
//! UTF-16LE means code units in the printable ASCII range, each followed by a
//! zero byte, which is how Windows strings are stored in practice.

use serde::Deserialize;
use serde_json::{Value, json};

use crate::ctx::Ctx;
use crate::error::{OpError, OpResult};
use crate::info::{SectionRec, sections};
use crate::target::Target;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Params {
    pub path: String,
    pub slice: Option<usize>,
    pub min_length: Option<usize>,
    /// Any of `ascii`, `utf16le`. Default both.
    pub encodings: Option<Vec<String>>,
    pub contains: Option<String>,
    /// Keep only strings inside this section.
    pub section: Option<String>,
    /// Longest text returned per string; the real length is always reported.
    pub max_string_length: Option<usize>,
    /// Skip this many matches.
    pub offset: Option<usize>,
    /// File offset to start scanning at (the `nextCursor` of an earlier call).
    pub cursor: Option<u64>,
    pub limit: Option<usize>,
}

fn printable(b: u8) -> bool {
    (0x20..0x7f).contains(&b) || b == b'\t'
}

#[derive(Debug, Clone, Copy)]
struct Hit {
    offset: usize,
    /// Characters in the run.
    chars: usize,
    utf16: bool,
}

/// Scans `data[from..]` for ASCII runs, lazily, in offset order.
struct AsciiScan<'a> {
    data: &'a [u8],
    at: usize,
    min: usize,
}

impl Iterator for AsciiScan<'_> {
    type Item = Hit;
    fn next(&mut self) -> Option<Hit> {
        let d = self.data;
        while self.at < d.len() {
            if printable(d[self.at]) {
                let start = self.at;
                let mut i = start;
                while i < d.len() && printable(d[i]) {
                    i += 1;
                }
                self.at = i;
                if i - start >= self.min {
                    return Some(Hit {
                        offset: start,
                        chars: i - start,
                        utf16: false,
                    });
                }
            } else {
                self.at += 1;
            }
        }
        None
    }
}

/// Scans for UTF-16LE runs of ASCII-range code units.
struct Utf16Scan<'a> {
    data: &'a [u8],
    at: usize,
    min: usize,
}

impl Iterator for Utf16Scan<'_> {
    type Item = Hit;
    fn next(&mut self) -> Option<Hit> {
        let d = self.data;
        while self.at + 1 < d.len() {
            if printable(d[self.at]) && d[self.at + 1] == 0 {
                let start = self.at;
                let mut i = start;
                while i + 1 < d.len() && printable(d[i]) && d[i + 1] == 0 {
                    i += 2;
                }
                self.at = i;
                if (i - start) / 2 >= self.min {
                    return Some(Hit {
                        offset: start,
                        chars: (i - start) / 2,
                        utf16: true,
                    });
                }
            } else {
                self.at += 1;
            }
        }
        None
    }
}

fn locate(secs: &[SectionRec], offset: u64) -> Option<&SectionRec> {
    secs.iter().find(|s| {
        s.file_offset
            .is_some_and(|o| offset >= o && offset < o + s.file_size)
    })
}

pub fn run(data: &[u8], p: Params, ctx: &mut Ctx) -> OpResult<Value> {
    let min = p.min_length.unwrap_or(4);
    if !(2..=4096).contains(&min) {
        return Err(OpError::invalid_params(
            "minLength must be between 2 and 4096",
        ));
    }
    let encodings = p
        .encodings
        .clone()
        .unwrap_or_else(|| vec!["ascii".into(), "utf16le".into()]);
    let mut want_ascii = false;
    let mut want_utf16 = false;
    for e in &encodings {
        match e.as_str() {
            "ascii" => want_ascii = true,
            "utf16le" => want_utf16 = true,
            other => {
                return Err(OpError::invalid_params(format!(
                    "unknown encoding `{other}`; use `ascii` or `utf16le`"
                )));
            }
        }
    }
    let t = Target::parse(data, p.slice);
    // Strings work on any file, parsed or not; sections only add context.
    let secs = t.file.as_ref().map(|f| sections(&t, f)).unwrap_or_default();
    let cursor = p.cursor.unwrap_or(0).min(data.len() as u64) as usize;
    let limit = p.limit.unwrap_or(500).clamp(1, 20_000);
    let skip = p.offset.unwrap_or(0);
    let max_len = p.max_string_length.unwrap_or(1024).clamp(16, 65_536);
    let needle = p.contains.as_deref().filter(|s| !s.is_empty());
    let mut budget = ctx.list_budget();

    let mut ascii = AsciiScan {
        data,
        at: cursor,
        min,
    }
    .filter(|_| want_ascii)
    .peekable();
    // A UTF-16 run may start one byte before `cursor` only by accident; align
    // to the cursor itself.
    let mut wide = Utf16Scan {
        data,
        at: cursor,
        min,
    }
    .filter(|_| want_utf16)
    .peekable();

    let mut items: Vec<Value> = Vec::new();
    let mut matched = 0usize;
    let mut next_cursor: Option<u64> = None;
    let mut done = true;
    loop {
        ctx.tick()?;
        let hit = match (ascii.peek().copied(), wide.peek().copied()) {
            (None, None) => break,
            (Some(a), None) => {
                ascii.next();
                a
            }
            (None, Some(w)) => {
                wide.next();
                w
            }
            (Some(a), Some(w)) => {
                if a.offset <= w.offset {
                    ascii.next();
                    a
                } else {
                    wide.next();
                    w
                }
            }
        };
        let sec = locate(&secs, hit.offset as u64);
        if let Some(name) = p.section.as_deref()
            && sec.map(|s| s.name.as_str()) != Some(name)
        {
            continue;
        }
        let width = if hit.utf16 { 2 } else { 1 };
        let bytes = &data[hit.offset..hit.offset + hit.chars * width];
        let text: String = if hit.utf16 {
            bytes.chunks_exact(2).map(|c| c[0] as char).collect()
        } else {
            bytes.iter().map(|b| *b as char).collect()
        };
        if let Some(n) = needle
            && !text.contains(n)
        {
            continue;
        }
        let index = matched;
        matched += 1;
        if index < skip {
            continue;
        }
        let v = json!({
            "text": if text.len() > max_len { &text[..max_len] } else { &text[..] },
            "length": hit.chars,
            "truncated": text.len() > max_len,
            "encoding": if hit.utf16 { "utf16le" } else { "ascii" },
            "fileOffset": hit.offset,
            "section": sec.map(|s| s.name.as_str()),
            "address": sec.map(|s| s.address + (hit.offset as u64 - s.file_offset.unwrap_or(0))),
        });
        if items.len() >= limit || !budget.take(&v) {
            next_cursor = Some(hit.offset as u64);
            done = false;
            break;
        }
        items.push(v);
    }
    Ok(json!({
        "strings": items,
        "complete": done,
        "nextCursor": next_cursor,
        "nextOffset": if done { Value::Null } else { json!(skip + items.len()) },
        "total": if done && cursor == 0 && skip == 0 { json!(matched) } else { Value::Null },
        "scannedBytes": data.len() - cursor,
    }))
}
