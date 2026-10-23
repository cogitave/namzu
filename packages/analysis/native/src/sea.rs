//! Node.js single executable application (SEA) blobs.
//!
//! `postject` stores the blob under the name `NODE_SEA_BLOB`: an ELF note
//! (a `PT_NOTE` segment plus an `SHT_NOTE` section), a PE resource of that
//! type name, or a Mach-O section `NODE_SEA,__NODE_SEA_BLOB`. All three were
//! measured with postject output.
//!
//! The blob (Node 24, measured): `u32 magic 0x0143da20`, `u32 flags`, a `u8`
//! (1 when a main-script path follows), the path as `u64 length + bytes`, the
//! main script as `u64 length + bytes`, then optional sections the flags
//! announce. Node 22 has no path byte. Both are tried and the lengths are
//! checked against the blob; if neither fits only the raw blob is offered.

use object::read::elf::{ElfFile, FileHeader, ProgramHeader, SectionHeader};
use object::read::pe::{ImageNtHeaders, PeFile, ResourceDirectory, ResourceDirectoryEntryData};
use object::{File, Object, ObjectSection};

pub const NOTE_NAME: &[u8] = b"NODE_SEA_BLOB";
pub const MAGIC: u32 = 0x0143_da20;
const FLAG_SNAPSHOT: u32 = 2;
const FLAG_CODE_CACHE: u32 = 4;
const FLAG_ASSETS: u32 = 8;

fn elf_blob<'data, Elf: FileHeader, R: object::ReadRef<'data>>(
    f: &ElfFile<'data, Elf, R>,
) -> Option<&'data [u8]> {
    let endian = f.endian();
    let data = f.data();
    for ph in f.elf_program_headers() {
        if let Ok(Some(mut notes)) = ph.notes(endian, data) {
            while let Ok(Some(note)) = notes.next() {
                if note.name() == NOTE_NAME {
                    return Some(note.desc());
                }
            }
        }
    }
    for sh in f.elf_section_table().iter() {
        if let Ok(Some(mut notes)) = sh.notes(endian, data) {
            while let Ok(Some(note)) = notes.next() {
                if note.name() == NOTE_NAME {
                    return Some(note.desc());
                }
            }
        }
    }
    None
}

/// First data leaf under `entry`, at most `depth` tables down.
fn first_leaf<'data>(
    dir: ResourceDirectory<'data>,
    data: ResourceDirectoryEntryData<'data>,
    depth: usize,
) -> Option<&'data object::pe::ImageResourceDataEntry> {
    match data {
        ResourceDirectoryEntryData::Data(d) => Some(d),
        ResourceDirectoryEntryData::Table(t) if depth > 0 => {
            let first = t.entries.first()?;
            first_leaf(dir, first.data(dir).ok()?, depth - 1)
        }
        ResourceDirectoryEntryData::Table(_) => None,
    }
}

/// Search the resource tree for an entry named `NODE_SEA_BLOB` at any of the
/// first three levels. postject writes it as `RT_RCDATA / "NODE_SEA_BLOB" /
/// language 0`, so the name sits on the second level, not the first.
fn find_named<'data>(
    dir: ResourceDirectory<'data>,
    table: &object::read::pe::ResourceDirectoryTable<'data>,
    depth: usize,
) -> Option<&'data object::pe::ImageResourceDataEntry> {
    let want = utf16(NOTE_NAME);
    for entry in table.entries {
        let named = entry
            .name_or_id()
            .name()
            .and_then(|n| n.raw_data(dir).ok())
            .is_some_and(|raw| raw == want.as_slice());
        let data = entry.data(dir).ok()?;
        if named {
            return first_leaf(dir, data, 3);
        }
        if let ResourceDirectoryEntryData::Table(t) = data
            && depth > 0
            && let Some(found) = find_named(dir, &t, depth - 1)
        {
            return Some(found);
        }
    }
    None
}

fn pe_blob<'data, Pe: ImageNtHeaders>(
    f: &PeFile<'data, Pe>,
    whole: &'data [u8],
) -> Option<&'data [u8]> {
    let sections = f.section_table();
    let dir: ResourceDirectory<'data> = f
        .data_directories()
        .resource_directory(whole, &sections)
        .ok()??;
    let root = dir.root().ok()?;
    let d = find_named(dir, &root, 2)?;
    let rva = d.offset_to_data.get(object::LittleEndian);
    let size = d.size.get(object::LittleEndian) as usize;
    sections.pe_data_at(whole, rva)?.get(..size)
}

fn utf16(s: &[u8]) -> Vec<u8> {
    s.iter().flat_map(|b| [*b, 0]).collect()
}

/// The raw SEA blob inside a parsed file, if any. `bytes` is what `file` was
/// parsed from.
pub fn find_blob<'a>(file: &File<'a>, bytes: &'a [u8]) -> Option<&'a [u8]> {
    match file {
        File::Elf32(f) => elf_blob(f),
        File::Elf64(f) => elf_blob(f),
        File::Pe32(f) => pe_blob(f, bytes),
        File::Pe64(f) => pe_blob(f, bytes),
        File::MachO32(_) | File::MachO64(_) => file
            .sections()
            .find(|s| {
                matches!(s.name(), Ok("__NODE_SEA_BLOB" | "NODE_SEA_BLOB"))
                    && matches!(s.segment_name(), Ok(Some("NODE_SEA")) | Ok(None))
            })
            .and_then(|s| s.data().ok()),
        _ => None,
    }
}

/// What is inside a blob, as far as it could be read.
#[derive(Debug)]
pub struct Parsed<'a> {
    pub flags: u32,
    pub main_path: Option<String>,
    pub main_script: Option<&'a [u8]>,
    pub assets: Vec<(String, &'a [u8])>,
    /// Why the content could not be split, when it could not.
    pub note: Option<String>,
}

struct Cursor<'a> {
    b: &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    fn u32(&mut self) -> Option<u32> {
        let s = self.b.get(self.at..self.at.checked_add(4)?)?;
        self.at += 4;
        Some(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    }
    fn u8(&mut self) -> Option<u8> {
        let v = *self.b.get(self.at)?;
        self.at += 1;
        Some(v)
    }
    fn u64(&mut self) -> Option<u64> {
        let s = self.b.get(self.at..self.at.checked_add(8)?)?;
        self.at += 8;
        let mut a = [0u8; 8];
        a.copy_from_slice(s);
        Some(u64::from_le_bytes(a))
    }
    fn bytes(&mut self) -> Option<&'a [u8]> {
        let len = usize::try_from(self.u64()?).ok()?;
        let s = self.b.get(self.at..self.at.checked_add(len)?)?;
        self.at += len;
        Some(s)
    }
}

fn try_layout<'a>(blob: &'a [u8], with_path_byte: bool) -> Option<Parsed<'a>> {
    let mut c = Cursor { b: blob, at: 0 };
    if c.u32()? != MAGIC {
        return None;
    }
    let flags = c.u32()?;
    let mut main_path = None;
    if with_path_byte {
        if c.u8()? == 1 {
            main_path = Some(String::from_utf8_lossy(c.bytes()?).into_owned());
        }
    } else if flags & FLAG_SNAPSHOT != 0 {
        return None;
    }
    let main_script = c.bytes()?;
    let mut assets = Vec::new();
    if flags & FLAG_SNAPSHOT == 0 {
        if flags & FLAG_CODE_CACHE != 0 {
            // A V8 code cache follows; it is not source and is left in the raw blob.
        } else if flags & FLAG_ASSETS != 0 {
            let count = c.u64()?;
            if count > 100_000 {
                return None;
            }
            for _ in 0..count {
                let key = String::from_utf8_lossy(c.bytes()?).into_owned();
                let value = c.bytes()?;
                assets.push((key, value));
            }
        }
    }
    Some(Parsed {
        flags,
        main_path,
        main_script: Some(main_script),
        assets,
        note: None,
    })
}

pub fn parse(blob: &[u8]) -> Parsed<'_> {
    if let Some(p) = try_layout(blob, true).or_else(|| try_layout(blob, false)) {
        return p;
    }
    let magic = blob
        .get(..4)
        .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]));
    Parsed {
        flags: 0,
        main_path: None,
        main_script: None,
        assets: Vec::new(),
        note: Some(match magic {
            Some(MAGIC) => "the blob has the SEA magic but its layout is not one this reader understands; only the raw blob is written".into(),
            _ => "the blob does not start with the SEA magic 0x0143da20; only the raw blob is written".into(),
        }),
    }
}

/// Build a Node 24 style blob. Test helper.
#[cfg(test)]
pub fn build_blob(path: &str, code: &[u8], flags: u32, assets: &[(&str, &[u8])]) -> Vec<u8> {
    let mut v = MAGIC.to_le_bytes().to_vec();
    v.extend_from_slice(&flags.to_le_bytes());
    v.push(1);
    v.extend_from_slice(&(path.len() as u64).to_le_bytes());
    v.extend_from_slice(path.as_bytes());
    v.extend_from_slice(&(code.len() as u64).to_le_bytes());
    v.extend_from_slice(code);
    if flags & FLAG_ASSETS != 0 {
        v.extend_from_slice(&(assets.len() as u64).to_le_bytes());
        for (k, val) in assets {
            v.extend_from_slice(&(k.len() as u64).to_le_bytes());
            v.extend_from_slice(k.as_bytes());
            v.extend_from_slice(&(val.len() as u64).to_le_bytes());
            v.extend_from_slice(val);
        }
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_node_24_blob() {
        let blob = build_blob("main.js", b"console.log(1)", 0, &[]);
        let p = parse(&blob);
        assert_eq!(p.main_path.as_deref(), Some("main.js"));
        assert_eq!(p.main_script, Some(&b"console.log(1)"[..]));
        assert!(p.note.is_none());
    }

    #[test]
    fn parses_assets() {
        let blob = build_blob("m.js", b"x", FLAG_ASSETS, &[("a.txt", b"hello")]);
        let p = parse(&blob);
        assert_eq!(p.assets.len(), 1);
        assert_eq!(p.assets[0].0, "a.txt");
    }

    #[test]
    fn refuses_truncated_and_oversized_lengths() {
        let blob = build_blob("main.js", b"console.log(1)", 0, &[]);
        for cut in [3, 8, 12, 20, blob.len() - 1] {
            let p = parse(&blob[..cut]);
            assert!(p.main_script.is_none(), "cut at {cut}");
            assert!(p.note.is_some());
        }
        let mut huge = blob.clone();
        huge[9..17].copy_from_slice(&u64::MAX.to_le_bytes());
        assert!(parse(&huge).main_script.is_none());
    }
}
