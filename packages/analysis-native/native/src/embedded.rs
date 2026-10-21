//! Payloads that ship inside an executable: detection and `extract_embedded`.
//!
//! Supported: Bun standalone executables (`.bun`) and Node.js single
//! executable applications (`NODE_SEA_BLOB`) in ELF, PE and Mach-O. Go build
//! information is detected only. Nothing is executed or loaded.

use object::{File, Object, ObjectSection};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::bun;
use crate::ctx::{Budget, Ctx};
use crate::error::{OpError, OpResult};
use crate::info::hex;
use crate::safepath::{OutDir, safe_components};
use crate::sea;
use crate::target::Target;

const BUN_SECTIONS: &[&str] = &[".bun", "__bun", "bun"];
const GO_SECTIONS: &[&str] = &[
    ".go.buildinfo",
    "__go_buildinfo",
    ".gopclntab",
    "__gopclntab",
];

fn bun_section<'a>(file: &File<'a>) -> Option<&'a [u8]> {
    file.sections()
        .find(|s| {
            s.name().is_ok_and(|n| BUN_SECTIONS.contains(&n))
                && s.segment_name().ok().flatten().is_none_or(|g| g == "__BUN")
        })
        .and_then(|s| s.data().ok())
}

/// Loaders whose modules are source or text and are written by default.
fn is_source_loader(loader: u8) -> bool {
    matches!(loader, 0..=4 | 6 | 7 | 12 | 13 | 16 | 17)
}

/// What payloads a file carries, for `binary_info`.
pub fn detect(t: &Target<'_>, file: &File<'_>) -> Vec<Value> {
    let mut found = Vec::new();
    if let Some(sec) = bun_section(file) {
        match bun::parse(sec) {
            Ok(p) => {
                let js = p.modules.iter().filter(|m| m.loader == 1).count();
                let bc = p.modules.iter().filter(|m| !m.bytecode.is_empty()).count();
                found.push(json!({
                    "kind": "bun",
                    "valid": true,
                    "layout": bun::LAYOUT,
                    "bunVersion": bun::find_version(t.bytes()),
                    "modules": p.modules.len(),
                    "javascriptModules": js,
                    "bytecodeModules": bc,
                    "extractable": true,
                }));
            }
            Err(bun::Refusal(why)) => found.push(json!({
                "kind": "bun",
                "valid": false,
                "reason": why,
                "extractable": false,
            })),
        }
    }
    if let Some(blob) = sea::find_blob(file, t.bytes()) {
        let p = sea::parse(blob);
        found.push(json!({
            "kind": "node-sea",
            "blobSize": blob.len(),
            "flags": p.flags,
            "mainPath": p.main_path,
            "mainScriptSize": p.main_script.map(<[u8]>::len),
            "assets": p.assets.len(),
            "note": p.note,
            "extractable": true,
        }));
    }
    if file
        .sections()
        .any(|s| s.name().is_ok_and(|n| GO_SECTIONS.contains(&n)))
    {
        found.push(json!({
            "kind": "go-buildinfo",
            "extractable": false,
            "note": "Go build metadata is present; it is reported, not extracted",
        }));
    }
    found
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Params {
    pub path: String,
    pub slice: Option<usize>,
    /// Where to write modules. Absent means list only.
    pub out_dir: Option<String>,
    /// `bun` or `node-sea`; default is whichever is found first.
    pub kind: Option<String>,
    /// `source` (default) skips binary assets; `all` writes every module.
    pub include: Option<String>,
    pub include_bytecode: Option<bool>,
    pub include_sourcemaps: Option<bool>,
    pub max_total_bytes: Option<u64>,
    pub offset: Option<usize>,
    pub limit: Option<usize>,
}

struct Item {
    name: String,
    size: usize,
    loader: Option<&'static str>,
    bytecode_size: usize,
    written: Option<String>,
    skipped: Option<String>,
}

impl Item {
    fn json(&self) -> Value {
        json!({
            "name": self.name,
            "size": self.size,
            "loader": self.loader,
            "bytecodeSize": self.bytecode_size,
            "path": self.written,
            "skipped": self.skipped,
        })
    }
}

struct Sink {
    out: Option<OutDir>,
    written: usize,
    bytes: u64,
    max_bytes: u64,
}

impl Sink {
    /// Write one file, or say why not. Returns the relative path written.
    fn put(
        &mut self,
        rel: &str,
        comps: Vec<String>,
        data: &[u8],
    ) -> Result<Option<String>, String> {
        let Some(out) = self.out.as_mut() else {
            return Ok(None);
        };
        if self.bytes.saturating_add(data.len() as u64) > self.max_bytes {
            return Err(format!(
                "writing it would pass the {} byte total limit",
                self.max_bytes
            ));
        }
        out.write(&comps, data)?;
        self.written += 1;
        self.bytes += data.len() as u64;
        Ok(Some(rel.to_string()))
    }
}

fn sha256(data: &[u8], ctx: &mut Ctx) -> OpResult<String> {
    let mut h = Sha256::new();
    for chunk in data.chunks(8 << 20) {
        ctx.check()?;
        h.update(chunk);
    }
    Ok(hex(&h.finalize()))
}

pub fn extract(data: &[u8], p: Params, ctx: &mut Ctx) -> OpResult<Value> {
    let t = Target::parse(data, p.slice);
    let file = t.require_file()?;
    let want = p.kind.as_deref();
    if let Some(k) = want
        && k != "bun"
        && k != "node-sea"
    {
        return Err(OpError::invalid_params("kind must be `bun` or `node-sea`"));
    }
    let include_all = match p.include.as_deref() {
        None | Some("source") => false,
        Some("all") => true,
        Some(_) => return Err(OpError::invalid_params("include must be `source` or `all`")),
    };
    let bun_sec = if want != Some("node-sea") {
        bun_section(file)
    } else {
        None
    };
    let sea_blob = if want != Some("bun") && bun_sec.is_none() {
        sea::find_blob(file, t.bytes())
    } else {
        None
    };
    if bun_sec.is_none() && sea_blob.is_none() {
        return Err(OpError::new(
            "no_embedded_payload",
            format!(
                "no supported embedded payload in this {} file (looked for a Bun `.bun` section and a Node.js `NODE_SEA_BLOB`)",
                t.format()
            ),
        ));
    }
    let out = match &p.out_dir {
        Some(d) => Some(OutDir::prepare(d)?),
        None => None,
    };
    let out_root = out.as_ref().map(|o| o.root().display().to_string());
    let mut sink = Sink {
        out,
        written: 0,
        bytes: 0,
        max_bytes: p.max_total_bytes.unwrap_or(1 << 30),
    };
    let mut items: Vec<Item> = Vec::new();
    let mut result = json!({ "format": t.format(), "outDir": out_root });
    let digest = sha256(data, ctx)?;

    let kind;
    if let Some(sec) = bun_sec {
        kind = "bun";
        let payload = bun::parse(sec).map_err(|bun::Refusal(why)| {
            OpError::new("extract_refused", format!("Bun payload refused: {why}"))
        })?;
        let m = result.as_object_mut().expect("object");
        m.insert("layout".into(), json!(bun::LAYOUT));
        m.insert("bunVersion".into(), json!(bun::find_version(t.bytes())));
        m.insert("entryPointId".into(), json!(payload.entry_point_id));
        m.insert("payloadByteCount".into(), json!(payload.byte_count));
        if let Some(e) = payload.modules.get(payload.entry_point_id as usize) {
            m.insert("entryPoint".into(), json!(e.name));
        }
        let with_bytecode = p.include_bytecode.unwrap_or(false);
        let with_maps = p.include_sourcemaps.unwrap_or(false);
        for module in &payload.modules {
            ctx.tick()?;
            let mut item = Item {
                name: module.name.clone(),
                size: module.contents.len(),
                loader: Some(bun::loader_name(module.loader)),
                bytecode_size: module.bytecode.len(),
                written: None,
                skipped: None,
            };
            if !include_all && !is_source_loader(module.loader) {
                item.skipped = Some(format!(
                    "binary asset (loader {}); pass include: \"all\" to write it",
                    bun::loader_name(module.loader)
                ));
            } else {
                match safe_components(&module.name) {
                    Err(why) => item.skipped = Some(format!("unsafe name: {why}")),
                    Ok(comps) => {
                        let rel = comps.join("/");
                        match sink.put(&rel, comps.clone(), module.contents) {
                            Ok(w) => item.written = w,
                            Err(why) => item.skipped = Some(why),
                        }
                        if item.skipped.is_none() {
                            if with_bytecode && !module.bytecode.is_empty() {
                                let mut c = comps.clone();
                                if let Some(last) = c.last_mut() {
                                    last.push_str(".jsc");
                                }
                                let r = c.join("/");
                                if let Err(why) = sink.put(&r, c, module.bytecode) {
                                    item.skipped = Some(format!("bytecode not written: {why}"));
                                }
                            }
                            if with_maps && !module.sourcemap.is_empty() {
                                let mut c = comps.clone();
                                if let Some(last) = c.last_mut() {
                                    last.push_str(".map");
                                }
                                let r = c.join("/");
                                if let Err(why) = sink.put(&r, c, module.sourcemap) {
                                    item.skipped = Some(format!("sourcemap not written: {why}"));
                                }
                            }
                        }
                    }
                }
            }
            items.push(item);
        }
    } else if let Some(blob) = sea_blob {
        kind = "node-sea";
        let parsed = sea::parse(blob);
        let m = result.as_object_mut().expect("object");
        m.insert("flags".into(), json!(parsed.flags));
        m.insert("mainPath".into(), json!(parsed.main_path));
        m.insert("note".into(), json!(parsed.note));
        let mut add = |name: String, rel: Vec<String>, bytes: &[u8], items: &mut Vec<Item>| {
            let mut item = Item {
                name,
                size: bytes.len(),
                loader: None,
                bytecode_size: 0,
                written: None,
                skipped: None,
            };
            match sink.put(&rel.join("/"), rel, bytes) {
                Ok(w) => item.written = w,
                Err(why) => item.skipped = Some(why),
            }
            items.push(item);
        };
        add(
            "NODE_SEA_BLOB".into(),
            vec!["sea-blob.bin".into()],
            blob,
            &mut items,
        );
        if let Some(script) = parsed.main_script {
            let comps = parsed
                .main_path
                .as_deref()
                .and_then(|n| safe_components(n).ok())
                .map(|c| {
                    let mut v = vec!["main".to_string()];
                    v.extend(c);
                    v
                })
                .unwrap_or_else(|| vec!["main".into(), "main.js".into()]);
            add(
                parsed.main_path.clone().unwrap_or_else(|| "main".into()),
                comps,
                script,
                &mut items,
            );
        }
        for (key, val) in &parsed.assets {
            ctx.tick()?;
            match safe_components(key) {
                Ok(c) => {
                    let mut v = vec!["assets".to_string()];
                    v.extend(c);
                    add(key.clone(), v, val, &mut items);
                }
                Err(why) => items.push(Item {
                    name: key.clone(),
                    size: val.len(),
                    loader: None,
                    bytecode_size: 0,
                    written: None,
                    skipped: Some(format!("unsafe name: {why}")),
                }),
            }
        }
    } else {
        unreachable!("checked above");
    }

    let skipped = items.iter().filter(|i| i.skipped.is_some()).count();
    let offset = p.offset.unwrap_or(0);
    let limit = p.limit.unwrap_or(5000).min(100_000);
    let mut budget: Budget = ctx.list_budget();
    let mut listed = Vec::new();
    let mut next = offset.min(items.len());
    for item in items.iter().skip(offset).take(limit) {
        let v = item.json();
        if !budget.take(&v) {
            break;
        }
        listed.push(v);
        next += 1;
    }
    let m = result.as_object_mut().expect("object");
    m.insert("kind".into(), json!(kind));
    m.insert(
        "provenance".into(),
        json!({ "sourceSha256": digest, "sourceSize": data.len(), "format": t.format() }),
    );
    m.insert("moduleCount".into(), json!(items.len()));
    m.insert("written".into(), json!(sink.written));
    m.insert("writtenBytes".into(), json!(sink.bytes));
    m.insert("skipped".into(), json!(skipped));
    m.insert("modules".into(), Value::Array(listed));
    m.insert("truncated".into(), json!(next < items.len()));
    if next < items.len() {
        m.insert("nextOffset".into(), json!(next));
    }
    Ok(result)
}
