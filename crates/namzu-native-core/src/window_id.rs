//! Window ids: `w:<handle as 16 hex digits>:<process id>`.
//!
//! The process id is there because a handle can be reused by a different
//! window after the first one closed; an id whose process no longer owns the
//! handle names nothing. A caller that only knows the handle may leave the
//! process id out (`w:<handle>`), and the helper then skips that check.

/// The id of window `hwnd`, owned by process `pid`.
pub fn format(hwnd: u64, pid: u32) -> String {
    format!("w:{hwnd:016x}:{pid}")
}

/// The handle and, when the id carried one, the process id.
pub fn parse(id: &str) -> Option<(u64, Option<u32>)> {
    let rest = id.strip_prefix("w:")?;
    let (hex, pid) = match rest.split_once(':') {
        Some((hex, pid)) => (hex, Some(pid)),
        None => (rest, None),
    };
    if hex.is_empty() || hex.len() > 16 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let hwnd = u64::from_str_radix(hex, 16).ok().filter(|h| *h != 0)?;
    let pid = match pid {
        None => None,
        Some(p) => {
            let plain = !p.is_empty()
                && p.bytes().all(|b| b.is_ascii_digit())
                && (p.len() == 1 || !p.starts_with('0'));
            Some(plain.then(|| p.parse::<u32>().ok()).flatten()?)
        }
    };
    Some((hwnd, pid))
}

/// Windows of Chromium, Electron, Firefox and embedded-browser programs.
/// Reading one with UI Automation switches its accessibility on for the
/// rest of the session, which costs the person speed in a program they did
/// not hand over, so a read of one is refused unless asked for.
pub fn is_chromium_class(class: &str) -> bool {
    class.starts_with("Chrome_") || class == "MozillaWindowClass" || class == "CefBrowserWindow"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_classes_are_recognised() {
        for yes in [
            "Chrome_WidgetWin_1",
            "Chrome_RenderWidgetHostHWND",
            "MozillaWindowClass",
            "CefBrowserWindow",
        ] {
            assert!(is_chromium_class(yes), "{yes}");
        }
        for no in ["", "Notepad", "ApplicationFrameWindow", "chrome_", "Chrome"] {
            assert!(!is_chromium_class(no), "{no}");
        }
    }

    #[test]
    fn an_id_round_trips() {
        let id = format(0x10a2c, 4120);
        assert_eq!(id, "w:0000000000010a2c:4120");
        assert_eq!(parse(&id), Some((0x10a2c, Some(4120))));
    }

    #[test]
    fn the_process_id_may_be_left_out() {
        assert_eq!(parse("w:10a2c"), Some((0x10a2c, None)));
        assert_eq!(parse("w:10A2C"), Some((0x10a2c, None)));
    }

    #[test]
    fn anything_else_is_not_an_id() {
        for bad in [
            "",
            "w:",
            "w::1",
            "0x10a2c",
            "x:10a2c:1",
            "w:zz:1",
            "w:0:1",
            "w:10a2c:",
            "w:10a2c:-1",
            "w:10a2c:01",
            "w:10a2c:1:2",
            "w:11111111111111111:1",
            "w:10a2c:99999999999",
        ] {
            assert_eq!(parse(bad), None, "{bad:?}");
        }
    }
}
