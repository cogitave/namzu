//! Unit tests over synthetic fixtures built in the test, including hostile ones.

use std::io::Cursor;
use std::path::{Path, PathBuf};

use object::write::{Object, Symbol, SymbolSection};
use object::{
    Architecture, BinaryFormat, Endianness, SectionKind, SymbolFlags, SymbolKind, SymbolScope,
};
use serde_json::{Value, json};

use crate::{Limits, bun, handle_line, sea, serve};

// ---------------------------------------------------------------- helpers

fn call(op: &str, params: Value) -> Value {
    call_with(op, params, None, None)
}

fn call_with(op: &str, params: Value, deadline: Option<u64>, max_bytes: Option<u64>) -> Value {
    let mut req = json!({ "id": 7, "op": op, "params": params });
    if let Some(d) = deadline {
        req["deadlineMs"] = json!(d);
    }
    if let Some(m) = max_bytes {
        req["maxBytes"] = json!(m);
    }
    let line = handle_line(req.to_string().as_bytes(), &Limits::default());
    serde_json::from_str(&line).expect("response is JSON")
}

fn ok(v: &Value) -> &Value {
    assert_eq!(v["ok"], json!(true), "expected success, got {v}");
    &v["result"]
}

fn err_code(v: &Value) -> &str {
    assert_eq!(v["ok"], json!(false), "expected failure, got {v}");
    v["error"]["code"].as_str().unwrap()
}

fn put(dir: &Path, name: &str, bytes: &[u8]) -> String {
    let p = dir.join(name);
    std::fs::write(&p, bytes).unwrap();
    p.display().to_string()
}

/// An ELF relocatable object with the given extra sections.
fn elf_object(extra: &[(&str, SectionKind, Vec<u8>)], with_symbols: bool) -> Vec<u8> {
    let mut o = Object::new(BinaryFormat::Elf, Architecture::X86_64, Endianness::Little);
    let text = o.add_section(vec![], b".text".to_vec(), SectionKind::Text);
    o.append_section_data(text, &[0x90; 32], 16);
    let ro = o.add_section(vec![], b".rodata".to_vec(), SectionKind::ReadOnlyData);
    let mut ro_data = b"hello, rodata string\0\0\0".to_vec();
    ro_data.extend("wide text".encode_utf16().flat_map(u16::to_le_bytes));
    ro_data.extend_from_slice(&[0, 0]);
    o.append_section_data(ro, &ro_data, 1);
    for (name, kind, data) in extra {
        let s = o.add_section(vec![], name.as_bytes().to_vec(), *kind);
        o.append_section_data(s, data, 1);
    }
    if with_symbols {
        for (i, name) in [
            "main",
            "_ZN3foo3barEi",
            "_ZN4core3fmt5Write9write_fmt17h0123456789abcdefE",
            "helper_fn",
        ]
        .iter()
        .enumerate()
        {
            o.add_symbol(Symbol {
                name: name.as_bytes().to_vec(),
                value: (i * 4) as u64,
                size: 4,
                kind: SymbolKind::Text,
                scope: SymbolScope::Dynamic,
                weak: false,
                section: SymbolSection::Section(text),
                flags: SymbolFlags::None,
            });
        }
        o.add_symbol(Symbol {
            name: b"puts".to_vec(),
            value: 0,
            size: 0,
            kind: SymbolKind::Text,
            scope: SymbolScope::Unknown,
            weak: false,
            section: SymbolSection::Undefined,
            flags: SymbolFlags::None,
        });
    }
    o.write().unwrap()
}

fn macho_object(arch: Architecture, sections: &[(&str, &str, Vec<u8>)]) -> Vec<u8> {
    let mut o = Object::new(BinaryFormat::MachO, arch, Endianness::Little);
    let text = o.add_section(b"__TEXT".to_vec(), b"__text".to_vec(), SectionKind::Text);
    o.append_section_data(text, &[0x90; 16], 16);
    for (seg, name, data) in sections {
        let s = o.add_section(
            seg.as_bytes().to_vec(),
            name.as_bytes().to_vec(),
            SectionKind::Data,
        );
        o.append_section_data(s, data, 1);
    }
    o.write().unwrap()
}

/// A universal Mach-O (32-bit fat header, big endian) wrapping `slices`.
fn fat_macho(slices: &[(u32, Vec<u8>)]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&0xcafe_babeu32.to_be_bytes());
    out.extend_from_slice(&(slices.len() as u32).to_be_bytes());
    let mut offset = 0x1000u32;
    let mut body = Vec::new();
    for (cputype, data) in slices {
        out.extend_from_slice(&cputype.to_be_bytes());
        out.extend_from_slice(&0u32.to_be_bytes());
        out.extend_from_slice(&offset.to_be_bytes());
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        out.extend_from_slice(&12u32.to_be_bytes());
        let pad = offset as usize - 0x1000 - body.len();
        body.extend(std::iter::repeat_n(0u8, pad));
        body.extend_from_slice(data);
        offset = (0x1000 + body.len()).next_multiple_of(0x1000) as u32;
    }
    out.resize(0x1000, 0);
    out.extend_from_slice(&body);
    out
}

fn note_record(name: &[u8], desc: &[u8]) -> Vec<u8> {
    let mut v = Vec::new();
    let namesz = name.len() as u32 + 1;
    v.extend_from_slice(&namesz.to_le_bytes());
    v.extend_from_slice(&(desc.len() as u32).to_le_bytes());
    v.extend_from_slice(&0u32.to_le_bytes());
    v.extend_from_slice(name);
    v.push(0);
    while v.len() % 4 != 0 {
        v.push(0);
    }
    v.extend_from_slice(desc);
    while v.len() % 4 != 0 {
        v.push(0);
    }
    v
}

/// A minimal PE32+ image. `sections` are `(name, data)`; if `rsrc_blob` is
/// given a `.rsrc` section is added carrying a `NODE_SEA_BLOB` resource laid
/// out the way postject writes it: `RT_RCDATA / "NODE_SEA_BLOB" / lang 0`.
fn pe_image(sections: &[(&str, Vec<u8>)], rsrc_blob: Option<&[u8]>) -> Vec<u8> {
    let mut secs: Vec<(String, Vec<u8>)> = sections
        .iter()
        .map(|(n, d)| (n.to_string(), d.clone()))
        .collect();
    let rsrc_index = secs.len();
    if let Some(blob) = rsrc_blob {
        let mut r = vec![0u8; 0x80];
        let table = |r: &mut Vec<u8>, at: usize, named: u16, ids: u16| {
            r[at + 12..at + 14].copy_from_slice(&named.to_le_bytes());
            r[at + 14..at + 16].copy_from_slice(&ids.to_le_bytes());
        };
        table(&mut r, 0, 0, 1);
        r[16..20].copy_from_slice(&10u32.to_le_bytes());
        r[20..24].copy_from_slice(&(0x8000_0000u32 | 0x18).to_le_bytes());
        table(&mut r, 0x18, 1, 0);
        r[0x28..0x2c].copy_from_slice(&(0x8000_0000u32 | 0x58).to_le_bytes());
        r[0x2c..0x30].copy_from_slice(&(0x8000_0000u32 | 0x30).to_le_bytes());
        table(&mut r, 0x30, 0, 1);
        r[0x40..0x44].copy_from_slice(&0u32.to_le_bytes());
        r[0x44..0x48].copy_from_slice(&0x48u32.to_le_bytes());
        // data entry at 0x48: rva filled below, size, codepage, reserved
        r[0x4c..0x50].copy_from_slice(&(blob.len() as u32).to_le_bytes());
        r[0x58..0x5a].copy_from_slice(&13u16.to_le_bytes());
        for (i, b) in b"NODE_SEA_BLOB".iter().enumerate() {
            r[0x5a + i * 2] = *b;
        }
        r.extend_from_slice(blob);
        secs.push((".rsrc".to_string(), r));
    }
    let file_align = 0x200usize;
    let sect_align = 0x1000usize;
    let headers = 0x400usize;
    let mut rvas = Vec::new();
    let mut raw_offsets = Vec::new();
    let mut rva = sect_align;
    let mut raw = headers;
    for (_, d) in &secs {
        rvas.push(rva);
        raw_offsets.push(raw);
        rva += d.len().next_multiple_of(sect_align).max(sect_align);
        raw += d.len().next_multiple_of(file_align);
    }
    if rsrc_blob.is_some() {
        let at = raw_offsets[rsrc_index];
        let _ = at;
        let (name, data) = &mut secs[rsrc_index];
        assert_eq!(name, ".rsrc");
        let data_rva = (rvas[rsrc_index] + 0x80) as u32;
        data[0x48..0x4c].copy_from_slice(&data_rva.to_le_bytes());
    }
    let mut f = vec![0u8; raw];
    f[0] = b'M';
    f[1] = b'Z';
    f[0x3c..0x40].copy_from_slice(&0x40u32.to_le_bytes());
    f[0x40..0x44].copy_from_slice(b"PE\0\0");
    let coff = 0x44;
    f[coff..coff + 2].copy_from_slice(&0x8664u16.to_le_bytes());
    f[coff + 2..coff + 4].copy_from_slice(&(secs.len() as u16).to_le_bytes());
    f[coff + 4..coff + 8].copy_from_slice(&0x5f5e_1000u32.to_le_bytes());
    f[coff + 16..coff + 18].copy_from_slice(&240u16.to_le_bytes());
    f[coff + 18..coff + 20].copy_from_slice(&0x22u16.to_le_bytes());
    let opt = coff + 20;
    f[opt..opt + 2].copy_from_slice(&0x20bu16.to_le_bytes());
    f[opt + 24..opt + 32].copy_from_slice(&0x1_4000_0000u64.to_le_bytes());
    f[opt + 32..opt + 36].copy_from_slice(&(sect_align as u32).to_le_bytes());
    f[opt + 36..opt + 40].copy_from_slice(&(file_align as u32).to_le_bytes());
    f[opt + 56..opt + 60].copy_from_slice(&(rva as u32).to_le_bytes());
    f[opt + 60..opt + 64].copy_from_slice(&(headers as u32).to_le_bytes());
    f[opt + 68..opt + 70].copy_from_slice(&3u16.to_le_bytes());
    f[opt + 108..opt + 112].copy_from_slice(&16u32.to_le_bytes());
    if rsrc_blob.is_some() {
        let dd = opt + 112 + 2 * 8;
        f[dd..dd + 4].copy_from_slice(&(rvas[rsrc_index] as u32).to_le_bytes());
        f[dd + 4..dd + 8].copy_from_slice(&(secs[rsrc_index].1.len() as u32).to_le_bytes());
    }
    let sh = opt + 240;
    for (i, (name, data)) in secs.iter().enumerate() {
        let h = sh + i * 40;
        let n = name.as_bytes();
        f[h..h + n.len().min(8)].copy_from_slice(&n[..n.len().min(8)]);
        f[h + 8..h + 12].copy_from_slice(&(data.len() as u32).to_le_bytes());
        f[h + 12..h + 16].copy_from_slice(&(rvas[i] as u32).to_le_bytes());
        f[h + 16..h + 20]
            .copy_from_slice(&(data.len().next_multiple_of(file_align) as u32).to_le_bytes());
        f[h + 20..h + 24].copy_from_slice(&(raw_offsets[i] as u32).to_le_bytes());
        f[h + 36..h + 40].copy_from_slice(&0x4000_0040u32.to_le_bytes());
        let end = raw_offsets[i] + data.len().next_multiple_of(file_align);
        f.resize(f.len().max(end), 0);
        f[raw_offsets[i]..raw_offsets[i] + data.len()].copy_from_slice(data);
    }
    f
}

// --------------------------------------------------------------- protocol

#[test]
fn hello_lists_every_op() {
    let v = call("hello", json!({}));
    let r = ok(&v);
    let ops: Vec<&str> = r["ops"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o.as_str().unwrap())
        .collect();
    for op in [
        "hello",
        "binary_info",
        "symbols",
        "imports",
        "exports",
        "strings",
        "extract_embedded",
    ] {
        assert!(ops.contains(&op), "{op} missing from {ops:?}");
    }
    assert_eq!(r["protocol"], json!(1));
    assert!(r["formats"].as_array().unwrap().contains(&json!("elf")));
}

#[test]
fn malformed_requests_get_errors_and_the_server_keeps_going() {
    let long = "x".repeat(2 << 20);
    let input = format!(
        "this is not json\n[1,2,3]\n{{\"id\":1}}\n{{\"id\":2,\"op\":\"nope\"}}\n\n{{\"id\":3,\"op\":\"symbols\",\"params\":{{\"path\":5}}}}\n{long}\n{{\"id\":4,\"op\":\"hello\"}}\n{{\"id\":5,\"op\":\"hello\",\"deadlineMs\":\"soon\"}}\n"
    );
    let mut out = Vec::new();
    serve(Cursor::new(input.into_bytes()), &mut out, Limits::default()).unwrap();
    let lines: Vec<Value> = String::from_utf8(out)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).expect("every output line is JSON"))
        .collect();
    let codes: Vec<String> = lines
        .iter()
        .map(|l| {
            if l["ok"] == json!(true) {
                "ok".to_string()
            } else {
                l["error"]["code"].as_str().unwrap().to_string()
            }
        })
        .collect();
    assert_eq!(
        codes,
        [
            "bad_request",
            "bad_request",
            "bad_request",
            "unknown_op",
            "invalid_params",
            "request_too_large",
            "ok",
            "bad_request"
        ]
    );
    assert_eq!(lines[3]["id"], json!(2));
    assert_eq!(lines[6]["id"], json!(4));
}

#[test]
fn unknown_params_are_refused() {
    let v = call("binary_info", json!({ "path": "/x", "bogus": 1 }));
    assert_eq!(err_code(&v), "invalid_params");
}

// ------------------------------------------------------------ file checks

#[test]
fn refuses_non_regular_and_missing_paths() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().display().to_string();
    assert_eq!(
        err_code(&call("binary_info", json!({ "path": dir }))),
        "not_regular_file"
    );
    let missing = tmp.path().join("missing").display().to_string();
    assert_eq!(
        err_code(&call("binary_info", json!({ "path": missing }))),
        "file_error"
    );
    assert_eq!(
        err_code(&call("binary_info", json!({ "path": "" }))),
        "invalid_params"
    );
    assert_eq!(
        err_code(&call("binary_info", json!({ "path": "a\u{0}b" }))),
        "invalid_params"
    );
    #[cfg(unix)]
    {
        assert_eq!(
            err_code(&call("binary_info", json!({ "path": "/dev/zero" }))),
            "not_regular_file"
        );
        let link = tmp.path().join("to-dev");
        std::os::unix::fs::symlink("/dev/zero", &link).unwrap();
        assert_eq!(
            err_code(&call(
                "binary_info",
                json!({ "path": link.display().to_string() })
            )),
            "not_regular_file"
        );
    }
}

#[test]
fn file_size_limit_is_enforced() {
    let tmp = tempfile::tempdir().unwrap();
    let p = put(tmp.path(), "big", &[0u8; 100]);
    let limits = Limits {
        max_file_bytes: 10,
        ..Limits::default()
    };
    let req = json!({ "id": 1, "op": "binary_info", "params": { "path": p } });
    let out = handle_line(req.to_string().as_bytes(), &limits);
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(err_code(&v), "too_large");
}

#[test]
fn an_empty_and_an_unrecognised_file_are_reported_not_crashed_on() {
    let tmp = tempfile::tempdir().unwrap();
    let empty = put(tmp.path(), "empty", b"");
    let v = call("binary_info", json!({ "path": empty }));
    assert_eq!(ok(&v)["format"], json!("unknown"));
    assert_eq!(
        err_code(&call("symbols", json!({ "path": empty }))),
        "unsupported_format"
    );
    // strings need no format.
    let text = put(tmp.path(), "text", b"plain text file\n");
    let v = call("strings", json!({ "path": text }));
    assert_eq!(ok(&v)["strings"][0]["text"], json!("plain text file"));
}

// ----------------------------------------------------------- binary_info

#[test]
fn binary_info_describes_the_test_executable() {
    let exe = std::env::current_exe().unwrap().display().to_string();
    let v = call("binary_info", json!({ "path": exe }));
    let r = ok(&v);
    let expect = if cfg!(target_os = "windows") {
        "pe"
    } else if cfg!(target_os = "macos") {
        "macho"
    } else {
        "elf"
    };
    assert_eq!(r["format"], json!(expect));
    assert_eq!(
        r["kind"]
            .as_str()
            .map(|k| k == "executable" || k == "shared"),
        Some(true)
    );
    assert!(r["sections"].as_array().unwrap().len() > 3);
    assert!(r["entry"].as_u64().unwrap() > 0);
    #[cfg(target_arch = "x86_64")]
    assert_eq!(r["arch"], json!("x86_64"));
    #[cfg(target_arch = "aarch64")]
    assert_eq!(r["arch"], json!("aarch64"));
}

#[test]
fn binary_info_on_a_synthetic_elf() {
    let tmp = tempfile::tempdir().unwrap();
    let p = put(tmp.path(), "a.o", &elf_object(&[], true));
    let v = call("binary_info", json!({ "path": p }));
    let r = ok(&v);
    assert_eq!(r["format"], json!("elf"));
    assert_eq!(r["kind"], json!("relocatable"));
    assert_eq!(r["bits"], json!(64));
    assert_eq!(r["endianness"], json!("little"));
    assert_eq!(r["stripped"], json!(false));
    let names: Vec<&str> = r["sections"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["name"].as_str().unwrap())
        .collect();
    assert!(
        names.contains(&".text") && names.contains(&".rodata"),
        "{names:?}"
    );
    let stripped = put(tmp.path(), "b.o", &elf_object(&[], false));
    let v = call("binary_info", json!({ "path": stripped }));
    assert_eq!(ok(&v)["stripped"], json!(true));
}

#[test]
fn binary_info_lists_the_slices_of_a_fat_macho() {
    let tmp = tempfile::tempdir().unwrap();
    let a = macho_object(Architecture::X86_64, &[]);
    let b = macho_object(Architecture::Aarch64, &[("__DATA", "__x", b"y".to_vec())]);
    let p = put(
        tmp.path(),
        "fat",
        &fat_macho(&[(0x0100_0007, a), (0x0100_000c, b)]),
    );
    let v = call("binary_info", json!({ "path": p }));
    let r = ok(&v);
    assert_eq!(r["format"], json!("macho-fat"));
    let arches: Vec<&str> = r["slices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["arch"].as_str().unwrap())
        .collect();
    assert_eq!(arches, ["x86_64", "aarch64"]);
    assert_eq!(r["arch"], json!("x86_64"));
    // Choosing the second slice reports its sections, at offsets into the whole file.
    let v = call("binary_info", json!({ "path": p, "slice": 1 }));
    let r = ok(&v);
    assert_eq!(r["arch"], json!("aarch64"));
    let x = r["sections"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == "__x")
        .unwrap();
    assert!(x["fileOffset"].as_u64().unwrap() >= 0x1000);
    let v = call("binary_info", json!({ "path": p, "slice": 9 }));
    assert_eq!(ok(&v)["parsed"], json!(false));
}

#[test]
fn binary_info_on_a_synthetic_pe() {
    let tmp = tempfile::tempdir().unwrap();
    let p = put(
        tmp.path(),
        "a.exe",
        &pe_image(&[(".text", vec![0xc3; 64])], None),
    );
    let v = call("binary_info", json!({ "path": p }));
    let r = ok(&v);
    assert_eq!(r["format"], json!("pe"));
    assert_eq!(r["arch"], json!("x86_64"));
    assert_eq!(r["peTimestamp"], json!(0x5f5e_1000u32));
    assert_eq!(r["isDll"], json!(false));
}

// --------------------------------------------------------------- symbols

#[test]
fn symbols_demangle_filter_and_page() {
    let tmp = tempfile::tempdir().unwrap();
    let p = put(tmp.path(), "a.o", &elf_object(&[], true));
    let v = call("symbols", json!({ "path": p }));
    let r = ok(&v);
    let by_raw = |raw: &str| {
        r["symbols"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["raw"] == raw)
            .unwrap()
            .clone()
    };
    assert_eq!(by_raw("_ZN3foo3barEi")["name"], json!("foo::bar(int)"));
    assert_eq!(by_raw("_ZN3foo3barEi")["language"], json!("cpp"));
    assert_eq!(
        by_raw("_ZN4core3fmt5Write9write_fmt17h0123456789abcdefE")["language"],
        json!("rust")
    );
    assert_eq!(by_raw("main")["name"], json!("main"));
    assert_eq!(by_raw("puts")["undefined"], json!(true));

    // Filter matches the demangled form.
    let v = call("symbols", json!({ "path": p, "contains": "foo::bar" }));
    assert_eq!(ok(&v)["total"], json!(1));
    // Raw form kept when demangling is off.
    let v = call(
        "symbols",
        json!({ "path": p, "demangle": false, "contains": "foo::bar" }),
    );
    assert_eq!(ok(&v)["total"], json!(0));
    // defined only.
    let v = call("symbols", json!({ "path": p, "definedOnly": true }));
    assert!(
        ok(&v)["symbols"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s["undefined"] == false)
    );

    // Paging walks every symbol exactly once.
    let total = r["total"].as_u64().unwrap() as usize;
    let mut seen = Vec::new();
    let mut offset = 0;
    loop {
        let v = call(
            "symbols",
            json!({ "path": p, "limit": 2, "offset": offset }),
        );
        let page = ok(&v);
        seen.extend(
            page["symbols"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| s["raw"].as_str().unwrap().to_string()),
        );
        match page["nextOffset"].as_u64() {
            Some(n) => offset = n as usize,
            None => break,
        }
    }
    assert_eq!(seen.len(), total);
    let mut dedup = seen.clone();
    dedup.sort();
    dedup.dedup();
    assert_eq!(dedup.len(), seen.len());
}

// --------------------------------------------------------------- imports

#[test]
fn imports_and_exports_report_undefined_and_defined_symbols() {
    let exe = std::env::current_exe().unwrap().display().to_string();
    let v = call("imports", json!({ "path": exe, "limit": 5 }));
    let r = ok(&v);
    assert!(r["total"].as_u64().unwrap() > 0);
    assert!(!r["libraries"].as_array().unwrap().is_empty());
    let v = call("exports", json!({ "path": exe, "limit": 5 }));
    let _ = ok(&v);
}

#[test]
fn imports_on_a_synthetic_elf_object() {
    let tmp = tempfile::tempdir().unwrap();
    let p = put(tmp.path(), "a.o", &elf_object(&[], true));
    // A relocatable object has no dynamic table: the call succeeds and is empty.
    let v = call("imports", json!({ "path": p }));
    assert_eq!(ok(&v)["total"], json!(0));
}

// --------------------------------------------------------------- strings

#[test]
fn strings_finds_ascii_and_utf16_with_locations() {
    let tmp = tempfile::tempdir().unwrap();
    let p = put(tmp.path(), "a.o", &elf_object(&[], true));
    let v = call("strings", json!({ "path": p, "minLength": 6 }));
    let r = ok(&v);
    let all = r["strings"].as_array().unwrap();
    let ascii = all
        .iter()
        .find(|s| s["text"] == "hello, rodata string")
        .expect("ascii string");
    assert_eq!(ascii["encoding"], json!("ascii"));
    assert_eq!(ascii["section"], json!(".rodata"));
    let wide = all
        .iter()
        .find(|s| s["text"] == "wide text")
        .expect("utf16 string");
    assert_eq!(wide["encoding"], json!("utf16le"));
    assert_eq!(wide["length"], json!(9));
    assert_eq!(wide["section"], json!(".rodata"));
    // Offsets are non-decreasing across both encodings.
    let offs: Vec<u64> = all
        .iter()
        .map(|s| s["fileOffset"].as_u64().unwrap())
        .collect();
    assert!(offs.windows(2).all(|w| w[0] <= w[1]));
    // Filters.
    let v = call(
        "strings",
        json!({ "path": p, "contains": "rodata", "encodings": ["ascii"] }),
    );
    assert!(
        ok(&v)["strings"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s["text"].as_str().unwrap().contains("rodata"))
    );
    let v = call(
        "strings",
        json!({ "path": p, "encodings": ["utf16le"], "minLength": 4 }),
    );
    assert!(
        ok(&v)["strings"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s["encoding"] == "utf16le")
    );
    let v = call("strings", json!({ "path": p, "section": ".text" }));
    assert!(ok(&v)["strings"].as_array().unwrap().is_empty());
    assert_eq!(
        err_code(&call(
            "strings",
            json!({ "path": p, "encodings": ["latin1"] })
        )),
        "invalid_params"
    );
    assert_eq!(
        err_code(&call("strings", json!({ "path": p, "minLength": 1 }))),
        "invalid_params"
    );
}

#[test]
fn strings_pages_by_cursor_without_gaps_or_repeats() {
    let tmp = tempfile::tempdir().unwrap();
    let mut data = Vec::new();
    for i in 0..50 {
        data.extend_from_slice(format!("string-number-{i:03}").as_bytes());
        data.push(0);
    }
    let p = put(tmp.path(), "many", &data);
    let mut seen = Vec::new();
    let mut cursor = 0u64;
    loop {
        let v = call(
            "strings",
            json!({ "path": p, "limit": 7, "cursor": cursor }),
        );
        let r = ok(&v);
        seen.extend(
            r["strings"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| s["text"].as_str().unwrap().to_string()),
        );
        match r["nextCursor"].as_u64() {
            Some(c) => cursor = c,
            None => break,
        }
    }
    assert_eq!(seen.len(), 50);
    assert_eq!(seen[0], "string-number-000");
    assert_eq!(seen[49], "string-number-049");
    // Offset paging agrees.
    let v = call("strings", json!({ "path": p, "offset": 48, "limit": 10 }));
    assert_eq!(ok(&v)["strings"].as_array().unwrap().len(), 2);
}

#[test]
fn a_long_string_is_cut_in_the_output_but_not_in_the_count() {
    let tmp = tempfile::tempdir().unwrap();
    let p = put(tmp.path(), "long", &[b'a'; 5000]);
    let v = call("strings", json!({ "path": p, "maxStringLength": 32 }));
    let s = &ok(&v)["strings"][0];
    assert_eq!(s["text"].as_str().unwrap().len(), 32);
    assert_eq!(s["length"], json!(5000));
    assert_eq!(s["truncated"], json!(true));
}

#[test]
fn max_bytes_bounds_the_response() {
    let tmp = tempfile::tempdir().unwrap();
    let mut data = Vec::new();
    for i in 0..5000 {
        data.extend_from_slice(format!("a-reasonably-long-string-{i:05}\0").as_bytes());
    }
    let p = put(tmp.path(), "many", &data);
    let req = json!({ "id": 1, "op": "strings", "maxBytes": 2048, "params": { "path": p, "limit": 20000 } });
    let out = handle_line(req.to_string().as_bytes(), &Limits::default());
    assert!(out.len() < 4096, "response was {} bytes", out.len());
    let v: Value = serde_json::from_str(&out).unwrap();
    let r = ok(&v);
    assert_eq!(r["complete"], json!(false));
    assert!(r["nextCursor"].as_u64().is_some());
}

#[test]
fn an_expired_deadline_stops_a_long_scan() {
    let tmp = tempfile::tempdir().unwrap();
    let p = put(tmp.path(), "many", &vec![b'z'; 1 << 20]);
    let v = call_with("strings", json!({ "path": p }), Some(0), None);
    assert_eq!(err_code(&v), "deadline_exceeded");
    let v = call_with("symbols", json!({ "path": p }), Some(0), None);
    assert_eq!(err_code(&v), "deadline_exceeded");
}

// ------------------------------------------------------------- embedded

fn bun_elf(mods: &[(&str, &[u8], u8)]) -> Vec<u8> {
    elf_object(
        &[(".bun", SectionKind::Data, bun::build_payload(mods))],
        true,
    )
}

fn listing(v: &Value) -> Vec<(String, Option<String>, Option<String>)> {
    ok(v)["modules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| {
            (
                m["name"].as_str().unwrap().to_string(),
                m["path"].as_str().map(str::to_string),
                m["skipped"].as_str().map(str::to_string),
            )
        })
        .collect()
}

#[test]
fn bun_payload_is_detected_listed_and_written() {
    let tmp = tempfile::tempdir().unwrap();
    let p = put(
        tmp.path(),
        "app",
        &bun_elf(&[
            ("/$bunfs/root/cli.js", b"console.log('cli')", 1),
            ("/$bunfs/root/lib/util.js", b"export const x = 1", 1),
            ("/$bunfs/root/data.json", b"{\"a\":1}", 6),
            ("/$bunfs/root/addon.node", b"\x7fELF-not-really", 9),
        ]),
    );
    let v = call("binary_info", json!({ "path": p }));
    let emb = &ok(&v)["embedded"][0];
    assert_eq!(emb["kind"], json!("bun"));
    assert_eq!(emb["valid"], json!(true));
    assert_eq!(emb["modules"], json!(4));
    assert_eq!(emb["javascriptModules"], json!(2));

    // List only: nothing written.
    let v = call("extract_embedded", json!({ "path": p }));
    assert_eq!(ok(&v)["written"], json!(0));
    assert_eq!(ok(&v)["outDir"], Value::Null);

    let out = tmp.path().join("out");
    let v = call(
        "extract_embedded",
        json!({ "path": p, "outDir": out.display().to_string() }),
    );
    let r = ok(&v);
    assert_eq!(r["kind"], json!("bun"));
    assert_eq!(r["written"], json!(3));
    assert_eq!(r["skipped"], json!(1));
    assert_eq!(
        r["provenance"]["sourceSize"].as_u64().unwrap(),
        std::fs::metadata(&p).unwrap().len()
    );
    assert_eq!(r["provenance"]["sourceSha256"].as_str().unwrap().len(), 64);
    assert_eq!(
        std::fs::read(out.join("cli.js")).unwrap(),
        b"console.log('cli')"
    );
    assert_eq!(
        std::fs::read(out.join("lib/util.js")).unwrap(),
        b"export const x = 1"
    );
    assert!(!out.join("addon.node").exists());
    let l = listing(&v);
    assert!(l.iter().any(
        |(n, _, s)| n.ends_with("addon.node") && s.as_deref().unwrap().contains("binary asset")
    ));

    // `include: all` writes the asset too.
    let out2 = tmp.path().join("out2");
    let v = call(
        "extract_embedded",
        json!({ "path": p, "outDir": out2.display().to_string(), "include": "all" }),
    );
    assert_eq!(ok(&v)["written"], json!(4));
}

#[test]
fn hostile_module_names_are_never_written_outside_the_directory() {
    let tmp = tempfile::tempdir().unwrap();
    let work = tmp.path().join("work");
    std::fs::create_dir(&work).unwrap();
    let p = put(
        &work,
        "app",
        &bun_elf(&[
            ("/$bunfs/root/../../evil1.js", b"x", 1),
            ("../evil2.js", b"x", 1),
            ("/etc/evil3.js", b"x", 1),
            ("/$bunfs/root/a\0b.js", b"x", 1),
            ("C:\\evil4.js", b"x", 1),
            ("/$bunfs/root/ok.js", b"fine", 1),
            ("/$bunfs/root/OK.js", b"collides", 1),
            ("/$bunfs/root/dir", b"file first", 1),
            ("/$bunfs/root/dir/inner.js", b"under a file", 1),
            ("", b"empty", 1),
        ]),
    );
    let out = tmp.path().join("out");
    let before: Vec<_> = std::fs::read_dir(tmp.path())
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    let v = call(
        "extract_embedded",
        json!({ "path": p, "outDir": out.display().to_string() }),
    );
    let r = ok(&v);
    assert_eq!(r["written"], json!(2), "ok.js and dir only: {r}");
    let l = listing(&v);
    for (name, path, skipped) in &l {
        if name.contains("evil") || name.is_empty() || name.contains('\0') {
            assert!(
                path.is_none() && skipped.is_some(),
                "{name:?} must be skipped"
            );
        }
    }
    // Nothing appeared next to the output directory or above it.
    let mut after: Vec<_> = std::fs::read_dir(tmp.path())
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    let mut before = before;
    before.push("out".into());
    before.sort();
    after.sort();
    assert_eq!(before, after);
    assert!(!tmp.path().join("evil1.js").exists());
    assert!(!tmp.path().join("evil2.js").exists());
    assert!(!work.join("evil1.js").exists());
    // Every file written is inside `out`.
    fn walk(dir: &Path, acc: &mut Vec<PathBuf>) {
        for e in std::fs::read_dir(dir).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                walk(&p, acc);
            } else {
                acc.push(p);
            }
        }
    }
    let mut files = Vec::new();
    walk(&out, &mut files);
    assert_eq!(files.len(), 2);
}

#[test]
fn bun_payload_corruptions_are_refused_with_the_layout_named() {
    let tmp = tempfile::tempdir().unwrap();
    let good = bun::build_payload(&[
        ("/$bunfs/root/a.js", b"1", 1),
        ("/$bunfs/root/b.js", b"2", 1),
    ]);
    let refuse = |name: &str, payload: Vec<u8>| {
        let elf = elf_object(&[(".bun", SectionKind::Data, payload)], false);
        let p = put(tmp.path(), name, &elf);
        let out = tmp.path().join(format!("{name}-out"));
        let v = call(
            "extract_embedded",
            json!({ "path": p, "outDir": out.display().to_string() }),
        );
        assert_eq!(err_code(&v), "extract_refused", "{name}: {v}");
        let msg = v["error"]["message"].as_str().unwrap();
        assert!(
            msg.contains("bun-standalone-52"),
            "{name}: message must name the layout: {msg}"
        );
        assert!(
            !out.exists() || std::fs::read_dir(&out).unwrap().next().is_none(),
            "{name}: wrote files"
        );
        let info = call("binary_info", json!({ "path": p }));
        assert_eq!(ok(&info)["embedded"][0]["valid"], json!(false), "{name}");
        msg.to_string()
    };
    // Cut anywhere: lengths and trailer no longer line up.
    for cut in [4, 8, 20, good.len() / 2, good.len() - 1, good.len() - 17] {
        refuse(&format!("cut{cut}"), good[..cut].to_vec());
    }
    // A length prefix larger than the section.
    let mut big = good.clone();
    big[..8].copy_from_slice(&u64::MAX.to_le_bytes());
    refuse("bigprefix", big);
    // Wrong trailer.
    let mut bad = good.clone();
    let n = bad.len();
    bad[n - 3] ^= 0xff;
    assert!(refuse("trailer", bad).contains("trailer"));
    // Module table pointing outside the payload.
    let mut off = good.clone();
    let end = off.len() - bun::TRAILER.len();
    off[8 + (end - 8 - 32) + 8..8 + (end - 8 - 32) + 12]
        .copy_from_slice(&0xffff_fff0u32.to_le_bytes());
    refuse("tableoff", off);
    // Table length not a multiple of the record size.
    let mut len = good.clone();
    let base = 8 + (len.len() - 8 - bun::TRAILER.len() - 32);
    len[base + 12..base + 16].copy_from_slice(&53u32.to_le_bytes());
    refuse("tablelen", len);
    // A module whose contents range lies outside the payload.
    let mut oob = good.clone();
    let base = 8 + (oob.len() - 8 - bun::TRAILER.len() - 32);
    let table = u32::from_le_bytes(oob[base + 8..base + 12].try_into().unwrap()) as usize;
    oob[8 + table + 12..8 + table + 16].copy_from_slice(&0x7fff_ffffu32.to_le_bytes());
    refuse("contentsrange", oob);
}

#[test]
fn an_older_bun_layout_is_named_not_misread() {
    // 36-byte records with the 28-byte offsets block, as Bun 1.1/1.2 wrote.
    let tmp = tempfile::tempdir().unwrap();
    let mut data = vec![0u8; 36 * 2];
    data.extend_from_slice(&[0u8; 8]);
    let mut offsets = Vec::new();
    offsets.extend_from_slice(&(data.len() as u64).to_le_bytes());
    offsets.extend_from_slice(&0u32.to_le_bytes());
    offsets.extend_from_slice(&72u32.to_le_bytes());
    offsets.extend_from_slice(&0u32.to_le_bytes());
    offsets.extend_from_slice(&0u32.to_le_bytes());
    offsets.extend_from_slice(&0u32.to_le_bytes());
    data.extend_from_slice(&offsets);
    data.extend_from_slice(bun::TRAILER);
    let mut section = (data.len() as u64).to_le_bytes().to_vec();
    section.extend_from_slice(&data);
    let p = put(
        tmp.path(),
        "old",
        &elf_object(&[(".bun", SectionKind::Data, section)], false),
    );
    let v = call(
        "extract_embedded",
        json!({ "path": p, "outDir": tmp.path().join("o").display().to_string() }),
    );
    assert_eq!(err_code(&v), "extract_refused");
    assert!(
        v["error"]["message"].as_str().unwrap().contains("36-byte"),
        "{v}"
    );
}

#[test]
fn extraction_limits_and_output_directory_rules() {
    let tmp = tempfile::tempdir().unwrap();
    let p = put(
        tmp.path(),
        "app",
        &bun_elf(&[
            ("/$bunfs/root/a.js", &[b'a'; 100], 1),
            ("/$bunfs/root/b.js", &[b'b'; 100], 1),
        ]),
    );
    // Total byte limit: the second module is skipped with a reason.
    let out = tmp.path().join("limited");
    let v = call(
        "extract_embedded",
        json!({ "path": p, "outDir": out.display().to_string(), "maxTotalBytes": 150 }),
    );
    let r = ok(&v);
    assert_eq!(r["written"], json!(1));
    assert_eq!(r["skipped"], json!(1));
    // Existing non-empty directory.
    let full = tmp.path().join("full");
    std::fs::create_dir(&full).unwrap();
    std::fs::write(full.join("f"), b"x").unwrap();
    let v = call(
        "extract_embedded",
        json!({ "path": p, "outDir": full.display().to_string() }),
    );
    assert_eq!(err_code(&v), "out_dir_invalid");
    // A file where the directory should be.
    let file = put(tmp.path(), "afile", b"x");
    let v = call("extract_embedded", json!({ "path": p, "outDir": file }));
    assert_eq!(err_code(&v), "out_dir_invalid");
    // An empty existing directory is fine.
    let empty = tmp.path().join("empty");
    std::fs::create_dir(&empty).unwrap();
    let v = call(
        "extract_embedded",
        json!({ "path": p, "outDir": empty.display().to_string() }),
    );
    assert_eq!(ok(&v)["written"], json!(2));
    // No payload at all.
    let plain = put(tmp.path(), "plain.o", &elf_object(&[], false));
    let v = call("extract_embedded", json!({ "path": plain }));
    assert_eq!(err_code(&v), "no_embedded_payload");
    let v = call("extract_embedded", json!({ "path": p, "kind": "zip" }));
    assert_eq!(err_code(&v), "invalid_params");
}

#[test]
fn listing_is_paged() {
    let tmp = tempfile::tempdir().unwrap();
    let names: Vec<String> = (0..10).map(|i| format!("/$bunfs/root/m{i}.js")).collect();
    let mods: Vec<(&str, &[u8], u8)> = names.iter().map(|n| (n.as_str(), &b"x"[..], 1u8)).collect();
    let p = put(tmp.path(), "app", &bun_elf(&mods));
    let v = call(
        "extract_embedded",
        json!({ "path": p, "limit": 4, "offset": 8 }),
    );
    let r = ok(&v);
    assert_eq!(r["modules"].as_array().unwrap().len(), 2);
    assert_eq!(r["moduleCount"], json!(10));
    assert_eq!(r["truncated"], json!(false));
    let v = call("extract_embedded", json!({ "path": p, "limit": 4 }));
    assert_eq!(ok(&v)["nextOffset"], json!(4));
}

fn sea_note_elf(blob: &[u8]) -> Vec<u8> {
    elf_object(
        &[(
            ".note.node",
            SectionKind::Note,
            note_record(b"NODE_SEA_BLOB", blob),
        )],
        false,
    )
}

#[test]
fn node_sea_in_elf_macho_and_pe() {
    let tmp = tempfile::tempdir().unwrap();
    let blob = sea::build_blob(
        "main.js",
        b"console.log('sea')",
        8,
        &[("data/a.txt", b"asset a"), ("../up.txt", b"x")],
    );
    let cases: Vec<(&str, Vec<u8>, &str)> = vec![
        ("elf", sea_note_elf(&blob), "elf"),
        (
            "macho",
            macho_object(
                Architecture::X86_64,
                &[("NODE_SEA", "__NODE_SEA_BLOB", blob.clone())],
            ),
            "macho",
        ),
        (
            "pe",
            pe_image(&[(".text", vec![0xc3; 16])], Some(&blob)),
            "pe",
        ),
    ];
    for (name, bytes, format) in cases {
        let p = put(tmp.path(), name, &bytes);
        let info = call("binary_info", json!({ "path": p }));
        let emb = &ok(&info)["embedded"][0];
        assert_eq!(emb["kind"], json!("node-sea"), "{name}: {info}");
        assert_eq!(
            emb["blobSize"].as_u64().unwrap() as usize,
            blob.len(),
            "{name}"
        );
        let out = tmp.path().join(format!("{name}-out"));
        let v = call(
            "extract_embedded",
            json!({ "path": p, "outDir": out.display().to_string() }),
        );
        let r = ok(&v);
        assert_eq!(r["format"], json!(format));
        assert_eq!(r["kind"], json!("node-sea"));
        assert_eq!(
            std::fs::read(out.join("sea-blob.bin")).unwrap(),
            blob,
            "{name}"
        );
        assert_eq!(
            std::fs::read(out.join("main/main.js")).unwrap(),
            b"console.log('sea')",
            "{name}"
        );
        assert_eq!(
            std::fs::read(out.join("assets/data/a.txt")).unwrap(),
            b"asset a",
            "{name}"
        );
        // The traversal asset is reported and not written.
        assert!(
            listing(&v)
                .iter()
                .any(|(n, p, s)| n == "../up.txt" && p.is_none() && s.is_some()),
            "{name}"
        );
        assert!(!tmp.path().join("up.txt").exists());
        assert!(!out.join("up.txt").exists());
    }
}

#[test]
fn an_unparseable_sea_blob_still_yields_the_raw_blob() {
    let tmp = tempfile::tempdir().unwrap();
    let p = put(tmp.path(), "x", &sea_note_elf(b"not a sea blob at all"));
    let out = tmp.path().join("o");
    let v = call(
        "extract_embedded",
        json!({ "path": p, "outDir": out.display().to_string() }),
    );
    let r = ok(&v);
    assert_eq!(r["written"], json!(1));
    assert!(r["note"].as_str().unwrap().contains("magic"));
}

// -------------------------------------------------------------- hostility

#[test]
fn truncated_and_corrupted_files_never_panic() {
    let tmp = tempfile::tempdir().unwrap();
    let sources: Vec<(&str, Vec<u8>)> = vec![
        ("elf", bun_elf(&[("/$bunfs/root/a.js", b"1", 1)])),
        (
            "macho",
            macho_object(
                Architecture::Aarch64,
                &[(
                    "NODE_SEA",
                    "__NODE_SEA_BLOB",
                    sea::build_blob("m.js", b"x", 0, &[]),
                )],
            ),
        ),
        (
            "pe",
            pe_image(
                &[(".text", vec![0xc3; 64])],
                Some(&sea::build_blob("m.js", b"x", 0, &[])),
            ),
        ),
        (
            "fat",
            fat_macho(&[(0x0100_0007, macho_object(Architecture::X86_64, &[]))]),
        ),
    ];
    let ops = [
        "binary_info",
        "symbols",
        "imports",
        "exports",
        "strings",
        "extract_embedded",
    ];
    let mut seed = 0x1234_5678_9abc_def0u64;
    let mut next = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    for (name, bytes) in &sources {
        // Every truncation point (stepped for the larger fixtures).
        let step = (bytes.len() / 300).max(1);
        for cut in (0..bytes.len()).step_by(step) {
            let p = put(tmp.path(), "t", &bytes[..cut]);
            for op in ops {
                let v = call(op, json!({ "path": p }));
                assert!(v.get("ok").is_some(), "{name} cut {cut} {op}");
                assert_ne!(
                    v["error"]["code"],
                    json!("internal"),
                    "{name} cut {cut} {op}: {v}"
                );
            }
        }
        // Random byte flips.
        for round in 0..150 {
            let mut b = bytes.clone();
            for _ in 0..(1 + round % 6) {
                let i = (next() as usize) % b.len();
                b[i] = next() as u8;
            }
            let p = put(tmp.path(), "c", &b);
            for op in ops {
                let params = if op == "extract_embedded" {
                    json!({ "path": p })
                } else {
                    json!({ "path": p, "limit": 50 })
                };
                let v = call(op, params);
                assert_ne!(
                    v["error"]["code"],
                    json!("internal"),
                    "{name} flip {round} {op}: {v}"
                );
            }
        }
    }
}

/// A Bun section whose `count` module records all point at the same
/// `name_len` bytes at the start of the payload (the amplification shape).
fn overlapping_bun_section(count: usize, name_len: usize) -> Vec<u8> {
    let mut data = vec![b'a'; name_len];
    let mut rec = Vec::new();
    for p in [(0u32, name_len as u32), (0, name_len as u32)] {
        rec.extend_from_slice(&p.0.to_le_bytes());
        rec.extend_from_slice(&p.1.to_le_bytes());
    }
    for _ in 0..4 {
        rec.extend_from_slice(&[0u8; 8]);
    }
    rec.extend_from_slice(&[0, 1, 0, 0]);
    assert_eq!(rec.len(), 52);
    let table_off = data.len() as u32;
    for _ in 0..count {
        data.extend_from_slice(&rec);
    }
    let table_len = (count * 52) as u32;
    let mut offsets = Vec::new();
    offsets.extend_from_slice(&(data.len() as u64).to_le_bytes());
    offsets.extend_from_slice(&table_off.to_le_bytes());
    offsets.extend_from_slice(&table_len.to_le_bytes());
    offsets.extend_from_slice(&[0u8; 16]);
    data.extend_from_slice(&offsets);
    data.extend_from_slice(bun::TRAILER);
    let mut section = (data.len() as u64).to_le_bytes().to_vec();
    section.extend_from_slice(&data);
    section
}

#[test]
fn a_table_of_overlapping_names_is_refused_instead_of_amplified() {
    let tmp = tempfile::tempdir().unwrap();
    // Too many modules: refused before any record is read.
    let many = elf_object(
        &[(
            ".bun",
            SectionKind::Data,
            overlapping_bun_section(bun::MAX_MODULES + 1, 4),
        )],
        false,
    );
    let p = put(tmp.path(), "many", &many);
    let v = call("extract_embedded", json!({ "path": p }));
    assert_eq!(err_code(&v), "extract_refused");
    assert!(v["error"]["message"].as_str().unwrap().contains("limit"));
    // Within the count, but the names add up to far more than the file holds.
    let fat = elf_object(
        &[(
            ".bun",
            SectionKind::Data,
            overlapping_bun_section(bun::MAX_MODULES, 4096),
        )],
        false,
    );
    let p = put(tmp.path(), "fat", &fat);
    let v = call("extract_embedded", json!({ "path": p }));
    assert_eq!(err_code(&v), "extract_refused");
    assert!(
        v["error"]["message"]
            .as_str()
            .unwrap()
            .contains("module names add up")
    );
    // binary_info reports the same payload as invalid rather than allocating.
    let v = call("binary_info", json!({ "path": p }));
    assert_eq!(ok(&v)["embedded"][0]["valid"], json!(false));
}

#[test]
fn a_large_table_within_the_limits_is_paged_and_honours_the_deadline() {
    let tmp = tempfile::tempdir().unwrap();
    let big = elf_object(
        &[(
            ".bun",
            SectionKind::Data,
            overlapping_bun_section(bun::MAX_MODULES, 64),
        )],
        false,
    );
    let p = put(tmp.path(), "big", &big);
    let v = call(
        "extract_embedded",
        json!({ "path": p, "offset": 99_990, "limit": 5 }),
    );
    let r = ok(&v);
    assert_eq!(r["moduleCount"], json!(bun::MAX_MODULES));
    assert_eq!(r["modules"].as_array().unwrap().len(), 5);
    assert_eq!(r["truncated"], json!(true));
    let v = call_with("extract_embedded", json!({ "path": p }), Some(0), None);
    assert_eq!(err_code(&v), "deadline_exceeded");
}

#[test]
fn reserved_namzu_names_are_never_written() {
    let tmp = tempfile::tempdir().unwrap();
    let p = put(
        tmp.path(),
        "app",
        &bun_elf(&[
            ("/$bunfs/root/.namzu-provenance.json", b"{}", 1),
            ("/$bunfs/root/sub/.namzu-x", b"1", 1),
            ("/$bunfs/root/fine.js", b"2", 1),
        ]),
    );
    let out = tmp.path().join("out");
    let v = call(
        "extract_embedded",
        json!({ "path": p, "outDir": out.display().to_string() }),
    );
    let names: Vec<_> = listing(&v).into_iter().map(|m| m.2.is_some()).collect();
    assert_eq!(names, vec![true, true, false]);
    assert!(!out.join(".namzu-provenance.json").exists());
    assert!(out.join("fine.js").exists());
}

#[test]
fn structured_corruption_of_embedded_tables_never_panics() {
    let tmp = tempfile::tempdir().unwrap();
    let mut seed = 0x9e37_79b9_7f4a_7c15u64;
    let mut next = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    let check = |label: &str, bytes: &[u8]| {
        let p = put(tmp.path(), "s", bytes);
        for op in ["binary_info", "extract_embedded", "strings"] {
            let v = call(op, json!({ "path": p }));
            assert_ne!(v["error"]["code"], json!("internal"), "{label} {op}: {v}");
        }
    };
    // Bun: random u32 offsets and lengths in every pointer of a few records.
    let good = bun::build_payload(&[("/$bunfs/root/a.js", b"1", 1), ("/b.js", b"22", 1)]);
    for round in 0..300 {
        let mut b = good.clone();
        let tail = b.len() - 8 - bun::TRAILER.len() - 32;
        let table_off = u32::from_le_bytes(b[8 + tail + 8..8 + tail + 12].try_into().unwrap());
        for _ in 0..(1 + round % 5) {
            let rec = (next() % 2) as usize * 52 + 8 + table_off as usize;
            let field = (next() % 6) as usize * 8 + (next() % 2) as usize * 4;
            let v = match next() % 4 {
                0 => u32::MAX,
                1 => 0x8000_0000,
                2 => (next() & 0xffff) as u32,
                _ => next() as u32,
            };
            if rec + field + 4 <= b.len() {
                b[rec + field..rec + field + 4].copy_from_slice(&v.to_le_bytes());
            }
        }
        check(
            &format!("bun round {round}"),
            &elf_object(&[(".bun", SectionKind::Data, b)], false),
        );
    }
    // Bun: huge module counts and an offsets block pointing everywhere.
    for count in [0usize, 1, 1000, bun::MAX_MODULES, bun::MAX_MODULES + 1] {
        check(
            &format!("bun count {count}"),
            &elf_object(
                &[(
                    ".bun",
                    SectionKind::Data,
                    overlapping_bun_section(count, 16),
                )],
                false,
            ),
        );
    }
    // SEA: asset counts from zero to u64::MAX over a short blob.
    for count in [0u64, 1, 99_999, 100_000, 100_001, u64::MAX] {
        let mut blob = sea::build_blob("m.js", b"x", 8, &[]);
        let n = blob.len();
        blob[n - 8..].copy_from_slice(&count.to_le_bytes());
        check(
            &format!("sea count {count}"),
            &macho_object(
                Architecture::Aarch64,
                &[("NODE_SEA", "__NODE_SEA_BLOB", blob)],
            ),
        );
    }
    // Fat Mach-O: arch entries whose offset and size are extreme.
    let slice = macho_object(Architecture::X86_64, &[]);
    let fat = fat_macho(&[(0x0100_0007, slice)]);
    for round in 0..200 {
        let mut b = fat.clone();
        for _ in 0..(1 + round % 3) {
            let i = 8 + (next() as usize % 20);
            if i + 4 <= b.len() {
                let v = if next() % 2 == 0 {
                    u32::MAX
                } else {
                    next() as u32
                };
                b[i..i + 4].copy_from_slice(&v.to_le_bytes());
            }
        }
        check(&format!("fat round {round}"), &b);
    }
}
