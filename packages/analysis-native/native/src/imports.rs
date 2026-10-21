//! `imports` and `exports`: libraries and the symbols that cross them.
//!
//! ELF: `DT_NEEDED` libraries and undefined dynamic symbols (with the GNU
//! symbol version when the file has one). PE: the import and delay-load
//! tables and the export table. Mach-O: `LC_LOAD_DYLIB` and friends, and the
//! bind information.

use object::read::{ExportTarget, ImportLibraryFlags, NameOrOrdinal};
use object::{File, Object};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::ctx::Ctx;
use crate::demangle::demangle;
use crate::error::OpResult;
use crate::target::Target;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Params {
    pub path: String,
    pub slice: Option<usize>,
    pub contains: Option<String>,
    /// Keep only symbols of this library (imports only).
    pub library: Option<String>,
    pub offset: Option<usize>,
    pub limit: Option<usize>,
}

fn name_of(n: NameOrOrdinal<&[u8]>) -> (String, Option<u16>) {
    match n {
        NameOrOrdinal::Name(b) => (String::from_utf8_lossy(b).into_owned(), None),
        NameOrOrdinal::Ordinal(o) => (format!("#{o}"), Some(o)),
    }
}

fn libraries(file: &File<'_>) -> Vec<Value> {
    let Ok(iter) = file.import_libraries() else {
        return Vec::new();
    };
    iter.filter_map(Result::ok)
        .map(|l| {
            let (kind, extra) = match l.flags() {
                ImportLibraryFlags::Pe { delay } => (
                    if delay { "delay-load" } else { "import-table" },
                    Value::Null,
                ),
                ImportLibraryFlags::MachO { ordinal, cmd, .. } => (
                    "dylib",
                    json!({ "ordinal": ordinal, "command": format!("{cmd:?}") }),
                ),
                _ => ("needed", Value::Null),
            };
            json!({ "name": String::from_utf8_lossy(l.name()), "kind": kind, "detail": extra })
        })
        .collect()
}

pub fn run_imports(data: &[u8], p: Params, ctx: &mut Ctx) -> OpResult<Value> {
    let t = Target::parse(data, p.slice);
    let file = t.require_file()?;
    let offset = p.offset.unwrap_or(0);
    let limit = p.limit.unwrap_or(500).clamp(1, 20_000);
    let needle = p.contains.as_deref().filter(|s| !s.is_empty());
    let mut budget = ctx.list_budget();
    let mut items = Vec::new();
    let mut total = 0usize;
    let mut next = None;
    let mut cut = false;
    let list = match file.imports() {
        Ok(l) => l,
        Err(e) => {
            return Ok(json!({
                "libraries": libraries(file),
                "imports": [],
                "total": 0,
                "truncated": false,
                "note": format!("the import table could not be read: {e}"),
            }));
        }
    };
    for imp in list.filter_map(Result::ok) {
        ctx.tick()?;
        let (name, ordinal) = name_of(imp.name());
        let lib = String::from_utf8_lossy(imp.library()).into_owned();
        if p.library
            .as_deref()
            .is_some_and(|l| !lib.eq_ignore_ascii_case(l))
        {
            continue;
        }
        let demangled = demangle(&name);
        if let Some(n) = needle
            && !(name.contains(n) || demangled.as_ref().is_some_and(|(d, _)| d.contains(n)))
        {
            continue;
        }
        let index = total;
        total += 1;
        if index < offset || cut {
            continue;
        }
        let v = json!({
            "name": demangled.as_ref().map(|(d, _)| d.as_str()).unwrap_or(&name),
            "raw": name,
            "library": if lib.is_empty() { Value::Null } else { json!(lib) },
            "ordinal": ordinal,
            "weak": imp.is_weak(),
        });
        if items.len() >= limit || !budget.take(&v) {
            cut = true;
            next.get_or_insert(index);
            continue;
        }
        items.push(v);
    }
    Ok(json!({
        "libraries": libraries(file),
        "imports": items,
        "total": total,
        "offset": offset,
        "truncated": cut,
        "nextOffset": next,
    }))
}

pub fn run_exports(data: &[u8], p: Params, ctx: &mut Ctx) -> OpResult<Value> {
    let t = Target::parse(data, p.slice);
    let file = t.require_file()?;
    let offset = p.offset.unwrap_or(0);
    let limit = p.limit.unwrap_or(500).clamp(1, 20_000);
    let needle = p.contains.as_deref().filter(|s| !s.is_empty());
    let mut budget = ctx.list_budget();
    let mut items = Vec::new();
    let mut total = 0usize;
    let mut next = None;
    let mut cut = false;
    let list = match file.exports() {
        Ok(l) => l,
        Err(e) => {
            return Ok(json!({
                "exports": [],
                "total": 0,
                "truncated": false,
                "note": format!("the export table could not be read: {e}"),
            }));
        }
    };
    for exp in list.filter_map(Result::ok) {
        ctx.tick()?;
        let (name, ordinal) = name_of(exp.name());
        let demangled = demangle(&name);
        if let Some(n) = needle
            && !(name.contains(n) || demangled.as_ref().is_some_and(|(d, _)| d.contains(n)))
        {
            continue;
        }
        let (address, forward) = match exp.target() {
            ExportTarget::Address { address } => (Some(address), None),
            ExportTarget::Reexport { library, name } => {
                let (n, _) = name_of(name);
                (
                    None,
                    Some(format!("{}!{}", String::from_utf8_lossy(library), n)),
                )
            }
            _ => (None, None),
        };
        let index = total;
        total += 1;
        if index < offset || cut {
            continue;
        }
        let v = json!({
            "name": demangled.as_ref().map(|(d, _)| d.as_str()).unwrap_or(&name),
            "raw": name,
            "ordinal": ordinal,
            "address": address,
            "forwardedTo": forward,
            "weak": exp.is_weak(),
        });
        if items.len() >= limit || !budget.take(&v) {
            cut = true;
            next.get_or_insert(index);
            continue;
        }
        items.push(v);
    }
    Ok(json!({
        "exports": items,
        "total": total,
        "offset": offset,
        "truncated": cut,
        "nextOffset": next,
    }))
}
