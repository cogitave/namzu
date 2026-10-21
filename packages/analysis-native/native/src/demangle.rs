//! Demangling C++ (Itanium and MSVC) and Rust symbol names.

use symbolic_common::{Language, Name, NameMangling};
use symbolic_demangle::{Demangle, DemangleOptions};

/// The demangled form and the language it was mangled for, when the name is
/// mangled and the demangler accepts it.
pub fn demangle(raw: &str) -> Option<(String, &'static str)> {
    let first = *raw.as_bytes().first()?;
    if !matches!(first, b'_' | b'?' | b'$') {
        return None;
    }
    let name = Name::new(raw, NameMangling::Mangled, Language::Unknown);
    let language = match name.detect_language() {
        Language::Rust => "rust",
        Language::Cpp if raw.starts_with('?') => "msvc",
        Language::Cpp => "cpp",
        _ => return None,
    };
    let out = name.demangle(DemangleOptions::complete())?;
    (out != raw).then_some((out, language))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn itanium() {
        let (d, l) = demangle("_ZN3foo3barEi").unwrap();
        assert_eq!(d, "foo::bar(int)");
        assert_eq!(l, "cpp");
    }

    #[test]
    fn rust_legacy_and_v0() {
        let (d, l) = demangle("_ZN4core3fmt5Write9write_fmt17h0123456789abcdefE").unwrap();
        assert_eq!(d, "core::fmt::Write::write_fmt");
        assert_eq!(l, "rust");
        let (d, l) = demangle("_RNvCs1234_7mycrate4main").unwrap();
        assert_eq!(l, "rust");
        assert!(d.contains("main"), "{d}");
    }

    #[test]
    fn msvc() {
        let (d, l) = demangle("?foo@bar@@YAHH@Z").unwrap();
        assert_eq!(l, "msvc");
        assert!(d.contains("bar::foo"), "{d}");
        let (d, _) = demangle("??0Foo@@QEAA@XZ").unwrap();
        assert!(d.contains("Foo::Foo"), "{d}");
    }

    #[test]
    fn plain_c_names_are_left_alone() {
        assert!(demangle("main").is_none());
        assert!(demangle("_start").is_none());
        assert!(demangle("__libc_start_main").is_none());
        assert!(demangle("_Z").is_none());
    }
}
