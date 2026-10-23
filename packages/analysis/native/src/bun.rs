//! Reader for the payload `bun build --compile` appends to an executable.
//!
//! Measured layout (Bun 1.3.14 and 1.4.4, ELF `.bun` section, PE `.bun`, Mach-O
//! `__BUN,__bun`):
//!
//! ```text
//! u64 n                        length of what follows
//! [ module data ... ]
//! Offsets (32 bytes)           byte_count u64, modules {off u32, len u32},
//!                              entry_point_id u32, argv {off u32, len u32},
//!                              flags u32
//! "\n---- Bun! ----\n"         16-byte trailer; the last bytes of the n
//! ```
//!
//! A module record is 52 bytes: four `{off u32, len u32}` pointers (name,
//! contents, sourcemap, bytecode), two more (module info, bytecode origin
//! path), then the bytes `encoding, loader, module_format, side`.
//!
//! The layout carries no version number and has changed between Bun releases,
//! so every offset and length is checked against the payload and anything
//! that does not fit is refused with the layout it was measured against.

use std::borrow::Cow;

use crate::ctx::Ctx;
use crate::error::OpError;

pub const TRAILER: &[u8] = b"\n---- Bun! ----\n";
const OFFSETS_LEN: usize = 32;
const RECORD_LEN: usize = 52;
/// Older Bun (1.1 and 1.2) wrote 36-byte records and a 28-byte offsets block.
const OLD_RECORD_LEN: usize = 36;
const OLD_OFFSETS_LEN: usize = 28;
/// Most modules a payload may declare. Real compiled programs carry hundreds.
pub const MAX_MODULES: usize = 100_000;
const MAX_NAME: usize = 4096;
/// Most name bytes a payload may declare in total, counted per record: the
/// records may point at the same bytes, so this bounds what a table of
/// overlapping names makes the caller do, not what is in the file.
pub const MAX_NAME_BYTES: usize = 16 << 20;

pub const LAYOUT: &str =
    "bun-standalone-52 (module records of 52 bytes; measured on Bun 1.3.14 and 1.4.4)";

#[derive(Debug, Clone, Copy)]
pub struct Ptr {
    pub off: usize,
    pub len: usize,
}

#[derive(Debug)]
pub struct Module<'a> {
    /// Borrowed from the mapped bytes unless they are not valid UTF-8.
    pub name: Cow<'a, str>,
    pub contents: &'a [u8],
    pub sourcemap: &'a [u8],
    pub bytecode: &'a [u8],
    pub encoding: u8,
    pub loader: u8,
    pub format: u8,
    pub side: u8,
}

#[derive(Debug)]
pub struct Payload<'a> {
    pub byte_count: u64,
    pub entry_point_id: u32,
    pub flags: u32,
    pub modules: Vec<Module<'a>>,
}

/// Why a section was not read as a Bun payload.
#[derive(Debug, Clone)]
pub struct Refusal(pub String);

fn u32le(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}

fn u64le(b: &[u8], o: usize) -> u64 {
    let mut a = [0u8; 8];
    a.copy_from_slice(&b[o..o + 8]);
    u64::from_le_bytes(a)
}

fn ptr(b: &[u8], o: usize) -> Ptr {
    Ptr {
        off: u32le(b, o) as usize,
        len: u32le(b, o + 4) as usize,
    }
}

pub fn loader_name(loader: u8) -> &'static str {
    match loader {
        0 => "jsx",
        1 => "js",
        2 => "ts",
        3 => "tsx",
        4 => "css",
        5 => "file",
        6 => "json",
        7 => "toml",
        8 => "wasm",
        9 => "napi",
        10 => "base64",
        11 => "dataurl",
        12 => "text",
        13 => "bunsh",
        14 => "sqlite",
        15 => "sqlite_embedded",
        16 => "html",
        17 => "yaml",
        _ => "unknown",
    }
}

/// Why `parse` stopped: the layout was not understood, or the request ran out
/// of time.
#[derive(Debug)]
pub enum Failure {
    Refused(Refusal),
    Op(OpError),
}

impl From<Refusal> for Failure {
    fn from(r: Refusal) -> Self {
        Failure::Refused(r)
    }
}

impl From<OpError> for Failure {
    fn from(e: OpError) -> Self {
        Failure::Op(e)
    }
}

/// Parse the bytes of a `.bun` section.
pub fn parse<'a>(section: &'a [u8], ctx: &mut Ctx) -> Result<Payload<'a>, Failure> {
    ctx.check()?;
    let refuse = |why: String| {
        Failure::Refused(Refusal(format!("{why}. This reader understands {LAYOUT}.")))
    };
    if section.len() < 8 {
        return Err(refuse(format!(
            "the .bun section is {} bytes, too short for a length prefix",
            section.len()
        )));
    }
    let n = u64le(section, 0);
    let n = usize::try_from(n)
        .ok()
        .filter(|n| n.checked_add(8).is_some_and(|e| e <= section.len()))
        .ok_or_else(|| {
            refuse(format!(
                "the payload length prefix ({n}) is larger than the {} byte section",
                section.len()
            ))
        })?;
    let data: &'a [u8] = &section[8..8 + n];
    if !data.ends_with(TRAILER) {
        return Err(refuse(
            "the payload does not end with the `---- Bun! ----` trailer; its layout version is unknown"
                .into(),
        ));
    }
    if n < TRAILER.len() + OFFSETS_LEN {
        return Err(refuse(format!("the payload is only {n} bytes")));
    }
    let end = n - TRAILER.len();
    let o = &data[end - OFFSETS_LEN..end];
    let byte_count = u64le(o, 0);
    let modules = ptr(o, 8);
    let entry_point_id = u32le(o, 16);
    let flags = u32le(o, 28);
    let older = end >= OLD_OFFSETS_LEN && {
        let oo = &data[end - OLD_OFFSETS_LEN..end];
        let m = ptr(oo, 8);
        u64le(oo, 0) == (end - OLD_OFFSETS_LEN) as u64
            && m.len.is_multiple_of(OLD_RECORD_LEN)
            && m.off.checked_add(m.len).is_some_and(|e| e <= end)
    };
    if byte_count != (end - OFFSETS_LEN) as u64 || !modules.len.is_multiple_of(RECORD_LEN) {
        return Err(refuse(if older {
            format!(
                "layout detected: older Bun with {OLD_RECORD_LEN}-byte module records (Bun 1.1 or 1.2); not supported"
            )
        } else if byte_count != (end - OFFSETS_LEN) as u64 {
            format!(
                "the offsets block records {byte_count} payload bytes but {} precede it; the block is not where this layout puts it",
                end - OFFSETS_LEN
            )
        } else {
            format!(
                "the module table length {} is not a multiple of {RECORD_LEN}",
                modules.len
            )
        }));
    }
    let table_end = modules.off.checked_add(modules.len);
    if table_end.is_none_or(|e| e > end - OFFSETS_LEN) {
        return Err(refuse(format!(
            "the module table (offset {}, length {}) does not fit before the offsets block",
            modules.off, modules.len
        )));
    }
    let count = modules.len / RECORD_LEN;
    if count > MAX_MODULES {
        return Err(refuse(format!(
            "{count} modules is over the {MAX_MODULES} limit"
        )));
    }
    let limit = end - OFFSETS_LEN;
    let slice = |p: Ptr, what: &str, idx: usize| -> Result<&'a [u8], Failure> {
        match p.off.checked_add(p.len) {
            Some(e) if e <= limit => Ok(&data[p.off..e]),
            _ => Err(refuse(format!(
                "module {idx}: {what} range (offset {}, length {}) lies outside the payload",
                p.off, p.len
            ))),
        }
    };
    let mut mods = Vec::with_capacity(count);
    let mut name_bytes_total = 0usize;
    for i in 0..count {
        ctx.tick()?;
        let r = &data[modules.off + i * RECORD_LEN..modules.off + (i + 1) * RECORD_LEN];
        let name_bytes = slice(ptr(r, 0), "name", i)?;
        if name_bytes.len() > MAX_NAME {
            return Err(refuse(format!(
                "module {i}: name is {} bytes",
                name_bytes.len()
            )));
        }
        name_bytes_total += name_bytes.len();
        if name_bytes_total > MAX_NAME_BYTES {
            return Err(refuse(format!(
                "the module names add up to more than {MAX_NAME_BYTES} bytes by module {i}"
            )));
        }
        let name = String::from_utf8_lossy(name_bytes);
        mods.push(Module {
            name,
            contents: slice(ptr(r, 8), "contents", i)?,
            sourcemap: slice(ptr(r, 16), "sourcemap", i)?,
            bytecode: slice(ptr(r, 24), "bytecode", i)?,
            encoding: r[48],
            loader: r[49],
            format: r[50],
            side: r[51],
        });
    }
    Ok(Payload {
        byte_count,
        entry_point_id,
        flags,
        modules: mods,
    })
}

/// Find `Bun v<digits>.<digits>.<digits>` in the file, the way the runtime
/// stamps itself. Looks at the first few hits only.
pub fn find_version(file: &[u8]) -> Option<String> {
    for at in memchr::memmem::find_iter(file, b"Bun v").take(16) {
        let rest = &file[at + 5..file.len().min(at + 5 + 24)];
        let len = rest
            .iter()
            .take_while(|b| b.is_ascii_digit() || **b == b'.')
            .count();
        let v = std::str::from_utf8(&rest[..len]).ok()?;
        if v.matches('.').count() == 2 && v.split('.').all(|p| !p.is_empty()) {
            return Some(v.to_string());
        }
    }
    None
}

/// Build a payload in the measured layout. Test and fixture helper.
#[cfg(test)]
pub fn build_payload(mods: &[(&str, &[u8], u8)]) -> Vec<u8> {
    let mut data: Vec<u8> = Vec::new();
    let put = |data: &mut Vec<u8>, b: &[u8]| -> (u32, u32) {
        let off = data.len() as u32;
        data.extend_from_slice(b);
        (off, b.len() as u32)
    };
    let mut records: Vec<u8> = Vec::new();
    for (name, contents, loader) in mods {
        let n = put(&mut data, name.as_bytes());
        let c = put(&mut data, contents);
        let empty = (data.len() as u32, 0u32);
        for p in [n, c, empty, empty, empty, empty] {
            records.extend_from_slice(&p.0.to_le_bytes());
            records.extend_from_slice(&p.1.to_le_bytes());
        }
        records.extend_from_slice(&[0, *loader, 0, 0]);
    }
    let t = put(&mut data, &records);
    let mut offsets = Vec::new();
    offsets.extend_from_slice(&(data.len() as u64).to_le_bytes());
    offsets.extend_from_slice(&t.0.to_le_bytes());
    offsets.extend_from_slice(&t.1.to_le_bytes());
    offsets.extend_from_slice(&0u32.to_le_bytes());
    offsets.extend_from_slice(&0u32.to_le_bytes());
    offsets.extend_from_slice(&0u32.to_le_bytes());
    offsets.extend_from_slice(&0u32.to_le_bytes());
    assert_eq!(offsets.len(), OFFSETS_LEN);
    data.extend_from_slice(&offsets);
    data.extend_from_slice(TRAILER);
    let mut section = (data.len() as u64).to_le_bytes().to_vec();
    section.extend_from_slice(&data);
    section
}
