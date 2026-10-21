//! Parsing a target into an `object::File`, picking one slice of a fat Mach-O.

use object::read::macho::{FatArch, MachOFatFile32, MachOFatFile64};
use object::{Architecture, File, FileKind};
use serde::Serialize;

use crate::error::{OpError, OpResult};

/// One architecture inside a universal Mach-O.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SliceInfo {
    pub index: usize,
    pub arch: String,
    pub file_offset: u64,
    pub size: u64,
}

pub struct Target<'a> {
    /// The whole file.
    pub whole: &'a [u8],
    pub kind: Option<FileKind>,
    /// Every slice of a universal Mach-O; empty for any other format.
    pub slices: Vec<SliceInfo>,
    /// Which slice `file` was parsed from.
    pub slice: usize,
    /// Where the parsed bytes start inside `whole`. Added to every file offset
    /// reported, so offsets always mean offsets into the file on disk.
    pub base: u64,
    pub file: Option<File<'a>>,
    /// Why `file` is absent.
    pub parse_note: Option<String>,
}

pub fn arch_name(a: Architecture) -> String {
    match a {
        Architecture::X86_64 | Architecture::X86_64_X32 => "x86_64".into(),
        Architecture::I386 => "x86".into(),
        Architecture::Aarch64 | Architecture::Aarch64_Ilp32 => "aarch64".into(),
        Architecture::Arm => "arm".into(),
        Architecture::Riscv64 => "riscv64".into(),
        Architecture::Riscv32 => "riscv32".into(),
        Architecture::PowerPc64 => "ppc64".into(),
        Architecture::PowerPc => "ppc".into(),
        Architecture::Mips => "mips".into(),
        Architecture::Mips64 => "mips64".into(),
        Architecture::S390x => "s390x".into(),
        Architecture::LoongArch64 => "loongarch64".into(),
        Architecture::Wasm32 => "wasm32".into(),
        Architecture::Wasm64 => "wasm64".into(),
        Architecture::Unknown => "unknown".into(),
        other => format!("{other:?}").to_lowercase(),
    }
}

pub fn format_name(kind: Option<FileKind>) -> &'static str {
    match kind {
        Some(FileKind::Elf32 | FileKind::Elf64) => "elf",
        Some(FileKind::Pe32 | FileKind::Pe64) => "pe",
        Some(FileKind::MachO32 | FileKind::MachO64) => "macho",
        Some(FileKind::MachOFat32 | FileKind::MachOFat64) => "macho-fat",
        Some(FileKind::Coff | FileKind::CoffBig) => "coff",
        Some(FileKind::CoffImport) => "coff-import",
        Some(FileKind::Archive) => "archive",
        Some(FileKind::DyldCache) => "dyld-cache",
        Some(FileKind::Xcoff32 | FileKind::Xcoff64) => "xcoff",
        Some(_) => "other",
        None => "unknown",
    }
}

fn fat_slices<A: FatArch>(arches: &[A]) -> Vec<SliceInfo> {
    arches
        .iter()
        .enumerate()
        .map(|(index, a)| {
            let (file_offset, size) = a.file_range();
            SliceInfo {
                index,
                arch: arch_name(a.architecture()),
                file_offset,
                size,
            }
        })
        .collect()
}

impl<'a> Target<'a> {
    /// Classify and parse `data`. Never fails for an unrecognised file: the
    /// result then has no `file` and a `parse_note`, and `require_file` turns
    /// that into the error the ops report.
    pub fn parse(data: &'a [u8], slice: Option<usize>) -> Target<'a> {
        let kind = FileKind::parse(data).ok();
        let mut target = Target {
            whole: data,
            kind,
            slices: Vec::new(),
            slice: 0,
            base: 0,
            file: None,
            parse_note: None,
        };
        let mut bytes = data;
        match kind {
            Some(FileKind::MachOFat32) => match MachOFatFile32::parse(data) {
                Ok(f) => target.slices = fat_slices(f.arches()),
                Err(e) => target.parse_note = Some(e.to_string()),
            },
            Some(FileKind::MachOFat64) => match MachOFatFile64::parse(data) {
                Ok(f) => target.slices = fat_slices(f.arches()),
                Err(e) => target.parse_note = Some(e.to_string()),
            },
            _ => {}
        }
        if matches!(kind, Some(FileKind::MachOFat32 | FileKind::MachOFat64)) {
            let want = slice.unwrap_or(0);
            match target.slices.get(want) {
                Some(s) => {
                    let start = s.file_offset as usize;
                    match start
                        .checked_add(s.size as usize)
                        .and_then(|end| data.get(start..end))
                    {
                        Some(b) => {
                            bytes = b;
                            target.slice = want;
                            target.base = s.file_offset;
                        }
                        None => {
                            target.parse_note = Some(format!("slice {want} lies outside the file"));
                            return target;
                        }
                    }
                }
                None => {
                    target.parse_note = Some(format!(
                        "slice {want} does not exist; the file has {} slices",
                        target.slices.len()
                    ));
                    return target;
                }
            }
        }
        match kind {
            None => target.parse_note = Some("not a recognised executable format".into()),
            Some(FileKind::Archive | FileKind::DyldCache | FileKind::CoffImport) => {
                target.parse_note = Some(format!(
                    "{} files are recognised but not analysed",
                    format_name(kind)
                ));
            }
            Some(_) => match File::parse(bytes) {
                Ok(f) => target.file = Some(f),
                Err(e) => target.parse_note = Some(e.to_string()),
            },
        }
        target
    }

    pub fn require_file(&self) -> OpResult<&File<'a>> {
        self.file.as_ref().ok_or_else(|| {
            let note = self.parse_note.as_deref().unwrap_or("unreadable");
            if self.kind.is_some() {
                OpError::parse_error(format!("{} file cannot be read: {note}", self.format()))
            } else {
                OpError::unsupported_format(note.to_string())
            }
        })
    }

    pub fn format(&self) -> &'static str {
        format_name(self.kind)
    }

    /// The bytes `file` was parsed from.
    pub fn bytes(&self) -> &'a [u8] {
        let start = self.base as usize;
        let len = match self.slices.get(self.slice) {
            Some(s) if self.base > 0 || !self.slices.is_empty() => s.size as usize,
            _ => self.whole.len(),
        };
        &self.whole[start..start + len]
    }
}
