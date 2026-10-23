//! `symbols`: static and dynamic symbol tables, demangled, paged.

use object::{Object, ObjectSection, ObjectSymbol, SymbolKind, SymbolSection};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::ctx::Ctx;
use crate::demangle::demangle;
use crate::error::{OpError, OpResult};
use crate::target::Target;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Params {
    pub path: String,
    pub slice: Option<usize>,
    /// `static`, `dynamic` or `all` (default).
    pub which: Option<String>,
    /// Keep names containing this text, in either the raw or demangled form.
    pub contains: Option<String>,
    /// `function`, `data`, `tls` or `other`.
    pub kind: Option<String>,
    pub defined_only: Option<bool>,
    pub demangle: Option<bool>,
    pub offset: Option<usize>,
    pub limit: Option<usize>,
}

fn class_of(k: SymbolKind) -> &'static str {
    match k {
        SymbolKind::Text => "function",
        SymbolKind::Data => "data",
        SymbolKind::Tls => "tls",
        _ => "other",
    }
}

/// Collects one page of matches while counting all of them.
struct Page<'p> {
    p: &'p Params,
    do_demangle: bool,
    defined_only: bool,
    needle: Option<&'p str>,
    offset: usize,
    limit: usize,
    budget: crate::ctx::Budget,
    items: Vec<Value>,
    total: usize,
    cut: bool,
    next: Option<usize>,
}

impl Page<'_> {
    fn add<'data, S: ObjectSymbol<'data>>(
        &mut self,
        ctx: &mut Ctx,
        file: &object::File<'data>,
        sym: &S,
        source: &str,
    ) -> OpResult<()> {
        ctx.tick()?;
        let Ok(raw) = sym.name() else { return Ok(()) };
        if raw.is_empty() || matches!(sym.kind(), SymbolKind::Section | SymbolKind::File) {
            return Ok(());
        }
        let class = class_of(sym.kind());
        if self.p.kind.as_deref().is_some_and(|k| k != class) {
            return Ok(());
        }
        if self.defined_only && sym.is_undefined() {
            return Ok(());
        }
        let demangled = if self.do_demangle {
            demangle(raw)
        } else {
            None
        };
        if let Some(n) = self.needle {
            let hit = raw.contains(n) || demangled.as_ref().is_some_and(|(d, _)| d.contains(n));
            if !hit {
                return Ok(());
            }
        }
        let index = self.total;
        self.total += 1;
        if index < self.offset || self.cut {
            return Ok(());
        }
        let section = match sym.section() {
            SymbolSection::Section(i) => file
                .section_by_index(i)
                .ok()
                .and_then(|s| s.name().ok().map(str::to_string)),
            _ => None,
        };
        let binding = if sym.is_weak() {
            "weak"
        } else if sym.is_local() {
            "local"
        } else if sym.is_global() {
            "global"
        } else {
            "unknown"
        };
        let v = json!({
            "name": demangled.as_ref().map(|(d, _)| d.as_str()).unwrap_or(raw),
            "raw": raw,
            "language": demangled.as_ref().map(|(_, l)| *l),
            "kind": class,
            "address": sym.address(),
            "size": sym.size(),
            "source": source,
            "undefined": sym.is_undefined(),
            "binding": binding,
            "section": section,
        });
        if self.items.len() >= self.limit || !self.budget.take(&v) {
            self.cut = true;
            self.next.get_or_insert(index);
            return Ok(());
        }
        self.items.push(v);
        Ok(())
    }
}

pub fn run(data: &[u8], p: Params, ctx: &mut Ctx) -> OpResult<Value> {
    let which = p.which.as_deref().unwrap_or("all");
    if !matches!(which, "all" | "static" | "dynamic") {
        return Err(OpError::invalid_params(
            "which must be `all`, `static` or `dynamic`",
        ));
    }
    if let Some(k) = p.kind.as_deref()
        && !matches!(k, "function" | "data" | "tls" | "other")
    {
        return Err(OpError::invalid_params(
            "kind must be `function`, `data`, `tls` or `other`",
        ));
    }
    let t = Target::parse(data, p.slice);
    let file = t.require_file()?;
    let mut page = Page {
        p: &p,
        do_demangle: p.demangle.unwrap_or(true),
        defined_only: p.defined_only.unwrap_or(false),
        needle: p.contains.as_deref().filter(|s| !s.is_empty()),
        offset: p.offset.unwrap_or(0),
        limit: p.limit.unwrap_or(500).clamp(1, 20_000),
        budget: ctx.list_budget(),
        items: Vec::new(),
        total: 0,
        cut: false,
        next: None,
    };
    if which != "dynamic" {
        for s in file.symbols() {
            page.add(ctx, file, &s, "static")?;
        }
    }
    if which != "static" {
        for s in file.dynamic_symbols() {
            page.add(ctx, file, &s, "dynamic")?;
        }
    }
    Ok(json!({
        "symbols": page.items,
        "total": page.total,
        "offset": page.offset,
        "truncated": page.cut,
        "nextOffset": page.next,
    }))
}
