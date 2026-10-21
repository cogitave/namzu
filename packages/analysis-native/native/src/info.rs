//! `binary_info`: what a file is, and what is in it.

use object::read::pe::ImageOptionalHeader;
use object::{
    Endianness, File, Object, ObjectKind, ObjectSection, ObjectSegment, SectionFlags, SectionKind,
    SegmentFlags,
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::ctx::Ctx;
use crate::embedded;
use crate::error::OpResult;
use crate::target::{Target, arch_name};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Params {
    pub path: String,
    pub slice: Option<usize>,
}

/// A section with the numbers other ops need to map offsets to addresses.
#[derive(Debug, Clone)]
pub struct SectionRec {
    pub name: String,
    pub segment: Option<String>,
    pub address: u64,
    pub size: u64,
    /// Absolute offset into the file on disk.
    pub file_offset: Option<u64>,
    pub file_size: u64,
    pub kind: &'static str,
    pub flags: Vec<&'static str>,
    pub raw_flags: u64,
}

fn kind_name(k: SectionKind) -> &'static str {
    match k {
        SectionKind::Text => "code",
        SectionKind::Data => "data",
        SectionKind::ReadOnlyData | SectionKind::ReadOnlyDataWithRel => "rodata",
        SectionKind::ReadOnlyString => "strings",
        SectionKind::UninitializedData | SectionKind::UninitializedTls => "bss",
        SectionKind::Tls => "tls",
        SectionKind::Debug | SectionKind::DebugString => "debug",
        SectionKind::Note => "note",
        SectionKind::Metadata => "metadata",
        SectionKind::Linker => "linker",
        SectionKind::OtherString => "strings",
        _ => "other",
    }
}

fn section_flag_names(f: SectionFlags) -> (Vec<&'static str>, u64) {
    let mut out = Vec::new();
    let raw = match f {
        SectionFlags::Elf { sh_flags, .. } => {
            let v = sh_flags.0;
            if v & 1 != 0 {
                out.push("write");
            }
            if v & 2 != 0 {
                out.push("alloc");
            }
            if v & 4 != 0 {
                out.push("exec");
            }
            v
        }
        SectionFlags::Coff { characteristics } => {
            let v = u64::from(characteristics.0);
            if v & 0x4000_0000 != 0 {
                out.push("read");
            }
            if v & 0x8000_0000 != 0 {
                out.push("write");
            }
            if v & 0x2000_0000 != 0 {
                out.push("exec");
            }
            if v & 0x20 != 0 {
                out.push("code");
            }
            v
        }
        SectionFlags::MachO { flags, .. } => u64::from(flags.0),
        _ => 0,
    };
    (out, raw)
}

pub fn sections(t: &Target<'_>, file: &File<'_>) -> Vec<SectionRec> {
    file.sections()
        .map(|s| {
            let (flags, raw_flags) = section_flag_names(s.flags());
            let range = s.file_range();
            SectionRec {
                name: s.name().unwrap_or("").to_string(),
                segment: s.segment_name().ok().flatten().map(str::to_string),
                address: s.address(),
                size: s.size(),
                file_offset: range.map(|(o, _)| o + t.base),
                file_size: range.map(|(_, n)| n).unwrap_or(0),
                kind: kind_name(s.kind()),
                flags,
                raw_flags,
            }
        })
        .collect()
}

pub fn hex(b: &[u8]) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        let _ = write!(s, "{x:02x}");
    }
    s
}

fn guid(b: [u8; 16]) -> String {
    // The CodeView GUID is stored as a u32, two u16 and 8 bytes.
    format!(
        "{:08x}-{:04x}-{:04x}-{}-{}",
        u32::from_le_bytes([b[0], b[1], b[2], b[3]]),
        u16::from_le_bytes([b[4], b[5]]),
        u16::from_le_bytes([b[6], b[7]]),
        hex(&b[8..10]),
        hex(&b[10..16])
    )
}

fn segment_perms(f: SegmentFlags) -> (Vec<&'static str>, u64) {
    let mut out = Vec::new();
    let raw = match f {
        SegmentFlags::Elf { p_flags, .. } => {
            let v = u64::from(p_flags.0);
            if v & 4 != 0 {
                out.push("read");
            }
            if v & 2 != 0 {
                out.push("write");
            }
            if v & 1 != 0 {
                out.push("exec");
            }
            v
        }
        SegmentFlags::MachO { initprot, .. } => {
            let v = u64::from(initprot.0);
            if v & 1 != 0 {
                out.push("read");
            }
            if v & 2 != 0 {
                out.push("write");
            }
            if v & 4 != 0 {
                out.push("exec");
            }
            v
        }
        SegmentFlags::Coff { characteristics } => u64::from(characteristics.0),
        _ => 0,
    };
    (out, raw)
}

fn object_kind(k: ObjectKind) -> &'static str {
    match k {
        ObjectKind::Executable => "executable",
        ObjectKind::Dynamic => "shared",
        ObjectKind::Relocatable => "relocatable",
        ObjectKind::Core => "core",
        _ => "unknown",
    }
}

fn endian(e: Endianness) -> &'static str {
    match e {
        Endianness::Little => "little",
        Endianness::Big => "big",
    }
}

pub fn run(data: &[u8], p: Params, ctx: &mut Ctx) -> OpResult<Value> {
    let t = Target::parse(data, p.slice);
    ctx.check()?;
    let mut out = json!({
        "format": t.format(),
        "size": data.len(),
    });
    let m = out.as_object_mut().expect("object");
    if !t.slices.is_empty() {
        m.insert("slices".into(), serde_json::to_value(&t.slices)?);
        m.insert("slice".into(), json!(t.slice));
    }
    let Some(file) = t.file.as_ref() else {
        m.insert("parsed".into(), json!(false));
        if let Some(note) = &t.parse_note {
            m.insert("note".into(), json!(note));
        }
        m.insert("embedded".into(), json!([]));
        return Ok(out);
    };
    m.insert("parsed".into(), json!(true));
    m.insert("kind".into(), json!(object_kind(file.kind())));
    m.insert("arch".into(), json!(arch_name(file.architecture())));
    m.insert("bits".into(), json!(if file.is_64() { 64 } else { 32 }));
    m.insert("endianness".into(), json!(endian(file.endianness())));
    m.insert("entry".into(), json!(file.entry()));

    let secs: Vec<Value> = sections(&t, file)
        .into_iter()
        .map(|s| {
            json!({
                "name": s.name,
                "segment": s.segment,
                "address": s.address,
                "size": s.size,
                "fileOffset": s.file_offset,
                "fileSize": s.file_size,
                "kind": s.kind,
                "flags": s.flags,
                "rawFlags": s.raw_flags,
            })
        })
        .collect();
    m.insert("sectionCount".into(), json!(secs.len()));
    m.insert("sections".into(), Value::Array(secs));

    let segs: Vec<Value> = file
        .segments()
        .map(|s| {
            let (perms, raw) = segment_perms(s.flags());
            let range = s.file_range();
            json!({
                "name": s.name().ok().flatten(),
                "address": s.address(),
                "size": s.size(),
                "fileOffset": t.base + range.0,
                "fileSize": range.1,
                "permissions": perms,
                "rawFlags": raw,
            })
        })
        .collect();
    m.insert("segments".into(), Value::Array(segs));

    if let Ok(Some(id)) = file.build_id() {
        m.insert("buildId".into(), json!(hex(id)));
    }
    if let Ok(Some(uuid)) = file.mach_uuid() {
        m.insert("machoUuid".into(), json!(hex(&uuid)));
    }
    match file {
        File::Pe32(f) => pe_extras(m, f.nt_headers()),
        File::Pe64(f) => pe_extras(m, f.nt_headers()),
        _ => {}
    }
    if let Ok(Some(cv)) = file.pdb_info() {
        m.insert(
            "pdb".into(),
            json!({
                "path": String::from_utf8_lossy(cv.path()),
                "guid": guid(cv.guid()),
                "age": cv.age(),
            }),
        );
    }
    let has_symbols = file.symbols().next().is_some();
    m.insert("stripped".into(), json!(!has_symbols));
    m.insert(
        "dynamicSymbols".into(),
        json!(file.dynamic_symbols().next().is_some()),
    );
    m.insert("debugInfo".into(), json!(file.has_debug_symbols()));
    ctx.check()?;
    m.insert("embedded".into(), json!(embedded::detect(&t, file, ctx)?));
    Ok(out)
}

fn pe_extras<Pe: object::read::pe::ImageNtHeaders>(
    m: &mut serde_json::Map<String, Value>,
    nt: &Pe,
) {
    let h = nt.file_header();
    m.insert(
        "peTimestamp".into(),
        json!(h.time_date_stamp.get(object::LittleEndian)),
    );
    let ch = h.characteristics.get(object::LittleEndian);
    m.insert("isDll".into(), json!(ch.0 & 0x2000 != 0));
    m.insert(
        "subsystem".into(),
        json!(nt.optional_header().subsystem().0),
    );
}
