//! Holds `namzu-native-core` to `conformance/namzu-native/*.json`, the same files the
//! TypeScript codec's tests read.

use namzu_native_core::dpi::{self, Monitor, Point};
use namzu_native_core::fingerprint::{self, Candidate, Identity, IdentityInput, Match};
use namzu_native_core::keys::{self, Key, KeyError, Modifier};
use namzu_native_core::protocol::{self, Fingerprint, Op, Rect, ResolveVia};
use namzu_native_core::refs;
use serde_json::{Map, Value};
use std::path::PathBuf;

fn load(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../conformance/namzu-native")
        .join(name);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn list<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v[key]
        .as_array()
        .unwrap_or_else(|| panic!("{key} is a list"))
}

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key]
        .as_str()
        .unwrap_or_else(|| panic!("{key} is a string"))
}

/// Equal as JSON, with numbers compared as numbers: `1` and `1.0` are one value.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, p)| y.get(k).is_some_and(|q| same(p, q)))
        }
        _ => a == b,
    }
}

fn op_of(name: &str) -> Op {
    Op::from_name(name).unwrap_or_else(|| panic!("unknown op {name}"))
}

#[test]
fn requests_decode_and_encode_back_to_the_same_object() {
    let v = load("protocol.json");
    for case in list(&v, "requests") {
        let name = text(case, "name");
        let wire = &case["wire"];
        let (id, request) =
            protocol::decode_request(&wire.to_string()).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(Some(id), wire["id"].as_u64(), "{name}");
        let line = protocol::encode_request(id, &request);
        let again: Value = serde_json::from_str(&line).unwrap();
        assert!(same(&again, wire), "{name}: {again} != {wire}");
        assert_eq!(request.op().name(), text(wire, "op"), "{name}");
    }
}

#[test]
fn bad_requests_are_refused_with_the_code_and_the_id() {
    let v = load("protocol.json");
    for case in list(&v, "badRequests") {
        let name = text(case, "name");
        let e = protocol::decode_request(text(case, "line"))
            .expect_err(&format!("{name} should be refused"));
        assert_eq!(e.id, case["id"].as_u64(), "{name}: id");
        assert_eq!(e.error.code, text(case, "code"), "{name}: code");
    }
}

#[test]
fn replies_decode_and_encode_back_to_the_same_object() {
    let v = load("protocol.json");
    for case in list(&v, "replies") {
        let name = text(case, "name");
        let wire = &case["wire"];
        let (id, reply) = protocol::decode_reply(op_of(text(case, "op")), &wire.to_string())
            .unwrap_or_else(|e| panic!("{name}: {e}"));
        let line = protocol::encode_reply(id, &reply);
        let again: Value = serde_json::from_str(&line).unwrap();
        assert!(same(&again, wire), "{name}: {again} != {wire}");
    }
}

#[test]
fn bad_replies_are_refused() {
    let v = load("protocol.json");
    for case in list(&v, "badReplies") {
        let name = text(case, "name");
        let got = protocol::decode_reply(op_of(text(case, "op")), text(case, "line"));
        assert!(got.is_err(), "{name} should be refused, got {got:?}");
    }
}

#[test]
fn refs_have_one_spelling() {
    let v = load("refs.json");
    for case in list(&v, "valid") {
        let r = text(case, "ref");
        let want = (
            case["revision"].as_u64().unwrap(),
            case["index"].as_u64().unwrap() as u32,
        );
        assert_eq!(refs::parse_ref(r), Some(want), "{r}");
        assert_eq!(refs::format_ref(want.0, want.1), r);
    }
    for r in list(&v, "invalid") {
        let r = r.as_str().unwrap();
        assert_eq!(refs::parse_ref(r), None, "{r:?}");
    }
}

fn int_list(v: &Value) -> Vec<i32> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|n| n.as_i64().unwrap() as i32)
        .collect()
}

struct OwnedInput {
    parent: i32,
    role: String,
    name: String,
    automation_id: String,
    runtime_id: Vec<i32>,
}

fn inputs(nodes: &[Value]) -> Vec<OwnedInput> {
    nodes
        .iter()
        .map(|n| OwnedInput {
            parent: n["parent"].as_i64().unwrap() as i32,
            role: text(n, "role").to_owned(),
            name: text(n, "name").to_owned(),
            automation_id: text(n, "automationId").to_owned(),
            runtime_id: int_list(&n["runtimeId"]),
        })
        .collect()
}

fn borrowed(owned: &[OwnedInput]) -> Vec<IdentityInput<'_>> {
    owned
        .iter()
        .map(|o| IdentityInput {
            parent: o.parent,
            role: &o.role,
            name: &o.name,
            automation_id: &o.automation_id,
            runtime_id: &o.runtime_id,
        })
        .collect()
}

fn identity_of(v: &Value) -> Identity {
    Identity {
        runtime_id: text(v, "runtimeId").to_owned(),
        automation_id: text(v, "automationId").to_owned(),
        role: text(v, "role").to_owned(),
        name_hash: text(v, "nameHash").to_owned(),
        parent_path: text(v, "parentPath").to_owned(),
        ordinal: v["ordinal"].as_u64().unwrap() as u32,
    }
}

#[test]
fn name_hashes() {
    let v = load("fingerprint.json");
    for case in list(&v, "nameHash") {
        assert_eq!(
            fingerprint::name_hash(text(case, "input")),
            text(case, "hash")
        );
    }
}

#[test]
fn identities_are_assigned_as_the_vectors_say() {
    let v = load("fingerprint.json");
    for case in list(&v, "assign") {
        let name = text(case, "name");
        let owned = inputs(list(case, "nodes"));
        let got = fingerprint::assign(&borrowed(&owned)).unwrap_or_else(|e| panic!("{name}: {e}"));
        let want: Vec<Identity> = list(case, "identities").iter().map(identity_of).collect();
        assert_eq!(got, want, "{name}");
    }
    for case in list(&v, "badOrder") {
        let owned = inputs(list(case, "nodes"));
        assert!(
            fingerprint::assign(&borrowed(&owned)).is_err(),
            "{}",
            text(case, "name")
        );
    }
}

#[test]
fn fingerprints_resolve_as_the_vectors_say() {
    let v = load("fingerprint.json");
    for case in list(&v, "resolve") {
        let name = text(case, "name");
        let fp: Fingerprint = serde_json::from_value(case["fingerprint"].clone()).unwrap();
        let candidates: Vec<Candidate> = list(case, "candidates")
            .iter()
            .map(|c| Candidate {
                index: c["index"].as_u64().unwrap() as u32,
                identity: identity_of(&c["identity"]),
            })
            .collect();
        let expect = &case["expect"];
        let want = match text(expect, "kind") {
            "found" => Match::Found {
                index: expect["index"].as_u64().unwrap() as u32,
                via: serde_json::from_value::<ResolveVia>(expect["via"].clone()).unwrap(),
            },
            "ambiguous" => Match::Ambiguous {
                candidates: expect["candidates"].as_u64().unwrap() as u32,
            },
            "notFound" => Match::NotFound,
            other => panic!("{name}: kind {other}"),
        };
        assert_eq!(fingerprint::resolve(&fp, &candidates), want, "{name}");
    }
}

fn modifier_name(m: &Modifier) -> &'static str {
    match m {
        Modifier::Ctrl => "ctrl",
        Modifier::Alt => "alt",
        Modifier::Shift => "shift",
        Modifier::Win => "win",
    }
}

#[test]
fn key_combos() {
    let v = load("keys.json");
    for case in list(&v, "combos") {
        let input = text(case, "input");
        let combo = keys::parse_combo(input).unwrap_or_else(|e| panic!("{input:?}: {e}"));
        let mods: Vec<&str> = combo.modifiers.iter().map(modifier_name).collect();
        let want_mods: Vec<&str> = list(case, "modifiers")
            .iter()
            .map(|m| m.as_str().unwrap())
            .collect();
        assert_eq!(mods, want_mods, "{input:?}");
        let key = &case["key"];
        let want_key = match (key.get("vk"), key.get("char")) {
            (Some(vk), None) => Key::Vk(vk.as_u64().unwrap() as u16),
            (None, Some(c)) => Key::Char(c.as_str().unwrap().chars().next().unwrap()),
            _ => panic!("{input:?}: a key is a vk or a char"),
        };
        assert_eq!(combo.key, want_key, "{input:?}");
    }
    for case in list(&v, "errors") {
        let input = text(case, "input");
        let err = keys::parse_combo(input).expect_err(input);
        let (kind, detail) = match err {
            KeyError::Empty => ("empty", None),
            KeyError::UnknownModifier(m) => ("unknown_modifier", Some(m)),
            KeyError::UnknownKey(k) => ("unknown_key", Some(k)),
        };
        assert_eq!(kind, text(case, "error"), "{input:?}");
        assert_eq!(detail.as_deref(), case["detail"].as_str(), "{input:?}");
    }
}

fn rect_of(v: &Value) -> Rect {
    serde_json::from_value(v.clone()).unwrap()
}

fn point_of(v: &Value) -> Point {
    Point {
        x: v["x"].as_i64().unwrap() as i32,
        y: v["y"].as_i64().unwrap() as i32,
    }
}

#[test]
fn dpi_math() {
    let v = load("dpi.json");
    for case in list(&v, "scale") {
        let dpi = case["dpi"].as_u64().unwrap() as u32;
        assert_eq!(
            dpi::scale_from_dpi(dpi),
            case["scale"].as_f64().unwrap(),
            "{dpi}"
        );
    }
    let monitors: Vec<Monitor> = list(&v, "monitors")
        .iter()
        .map(|m| Monitor {
            id: text(m, "id").to_owned(),
            bounds: rect_of(&m["bounds"]),
            dpi: m["dpi"].as_u64().unwrap() as u32,
        })
        .collect();
    assert_eq!(
        dpi::virtual_bounds(&monitors),
        Some(rect_of(&v["virtualBounds"]))
    );
    for case in list(&v, "at") {
        let p = point_of(&case["point"]);
        assert_eq!(
            dpi::monitor_at(&monitors, p).map(|m| m.id.as_str()),
            case["monitor"].as_str(),
            "{p:?}"
        );
        assert_eq!(
            dpi::monitor_nearest(&monitors, p).map(|m| m.id.as_str()),
            case["nearest"].as_str(),
            "{p:?}"
        );
    }
    for case in list(&v, "logical") {
        let p = point_of(&case["point"]);
        let m = dpi::monitor_at(&monitors, p).unwrap();
        assert_eq!(m.id, text(case, "monitor"));
        let (x, y) = m.to_logical(p);
        assert_eq!(
            (x, y),
            (
                case["logical"]["x"].as_f64().unwrap(),
                case["logical"]["y"].as_f64().unwrap()
            )
        );
        assert_eq!(m.to_physical((x, y)), p);
    }
    let desktop = dpi::virtual_bounds(&monitors).unwrap();
    for case in list(&v, "absolute") {
        let p = point_of(&case["point"]);
        let want = (
            case["abs"]["x"].as_i64().unwrap() as i32,
            case["abs"]["y"].as_i64().unwrap() as i32,
        );
        assert_eq!(dpi::to_absolute(p, &desktop), want, "{p:?}");
    }
    for case in list(&v, "scaledRect") {
        let got = rect_of(&case["rect"]).scaled(case["factor"].as_f64().unwrap());
        assert_eq!(got, rect_of(&case["scaled"]));
    }
}

#[test]
fn every_vector_file_is_an_object_with_an_about() {
    for name in [
        "protocol.json",
        "refs.json",
        "fingerprint.json",
        "keys.json",
        "dpi.json",
    ] {
        let v = load(name);
        let obj: &Map<String, Value> = v.as_object().expect(name);
        assert!(obj.get("about").is_some_and(Value::is_string), "{name}");
    }
}
