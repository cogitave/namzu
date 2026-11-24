//! Key names: `"ctrl+shift+t"`, `"alt+F4"`, `"page_down"` into virtual-key codes.
//!
//! The spellings are the ones the model already writes and the PowerShell
//! adapter already accepts, so the native adapter is a drop-in. As there,
//! `cmd`, `command` and `meta` mean Control (the shortcut key on Windows);
//! `win`, `windows` and `super` are the Windows key.

/// A modifier, in the order a combo presses them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Modifier {
    Ctrl,
    Alt,
    Shift,
    Win,
}

impl Modifier {
    /// The `VK_*` code of the left-hand key.
    pub fn vk(self) -> u16 {
        match self {
            Modifier::Ctrl => 0xA2,  // VK_LCONTROL
            Modifier::Alt => 0xA4,   // VK_LMENU
            Modifier::Shift => 0xA0, // VK_LSHIFT
            Modifier::Win => 0x5B,   // VK_LWIN
        }
    }

    pub fn parse(name: &str) -> Option<Modifier> {
        Some(match name.to_ascii_lowercase().as_str() {
            "ctrl" | "control" | "cmd" | "command" | "meta" => Modifier::Ctrl,
            "alt" | "option" | "opt" => Modifier::Alt,
            "shift" => Modifier::Shift,
            "win" | "windows" | "super" => Modifier::Win,
            _ => return None,
        })
    }
}

/// The key that is pressed while the modifiers are held.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
    /// A named key or a letter or digit, by `VK_*` code.
    Vk(u16),
    /// A character with no fixed code (punctuation, anything outside ASCII):
    /// the keyboard layout decides, so the Windows side maps it.
    Char(char),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Combo {
    /// Without repeats, in press order.
    pub modifiers: Vec<Modifier>,
    pub key: Key,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyError {
    Empty,
    UnknownModifier(String),
    UnknownKey(String),
}

impl std::fmt::Display for KeyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            KeyError::Empty => write!(f, "empty key combo"),
            KeyError::UnknownModifier(m) => write!(f, "unknown modifier \"{m}\""),
            KeyError::UnknownKey(k) => write!(f, "unknown key \"{k}\""),
        }
    }
}

impl std::error::Error for KeyError {}

/// A named key's `VK_*` code; names are case-insensitive.
pub fn named_key(name: &str) -> Option<u16> {
    let lower = name.to_ascii_lowercase();
    let vk = match lower.as_str() {
        "enter" | "return" => 0x0D,
        "escape" | "esc" => 0x1B,
        "tab" => 0x09,
        "backspace" => 0x08,
        "delete" | "del" | "forward_delete" => 0x2E,
        "insert" | "ins" => 0x2D,
        "space" => 0x20,
        "up" => 0x26,
        "down" => 0x28,
        "left" => 0x25,
        "right" => 0x27,
        "home" => 0x24,
        "end" => 0x23,
        "page_up" | "pageup" | "pgup" => 0x21,
        "page_down" | "pagedown" | "pgdn" => 0x22,
        "caps_lock" | "capslock" => 0x14,
        "print_screen" | "printscreen" => 0x2C,
        "menu" | "apps" => 0x5D,
        other => {
            let n = other.strip_prefix('f')?.parse::<u16>().ok()?;
            if !(1..=24).contains(&n) {
                return None;
            }
            0x70 + (n - 1)
        }
    };
    Some(vk)
}

/// The `VK_*` code of a letter or digit, which is its uppercase ASCII value.
pub fn vk_for_char(c: char) -> Option<u16> {
    match c {
        'a'..='z' => Some(c.to_ascii_uppercase() as u16),
        'A'..='Z' | '0'..='9' => Some(c as u16),
        _ => None,
    }
}

fn parse_key(token: &str) -> Result<Key, KeyError> {
    if let Some(vk) = named_key(token) {
        return Ok(Key::Vk(vk));
    }
    let mut chars = token.chars();
    match (chars.next(), chars.next()) {
        (Some(c), None) => Ok(vk_for_char(c).map_or(Key::Char(c), Key::Vk)),
        _ => Err(KeyError::UnknownKey(token.to_owned())),
    }
}

/// Reads `"mod+mod+key"`. The last part is the key; a trailing `+` is the plus
/// key itself (`"ctrl++"`, `"+"`).
pub fn parse_combo(input: &str) -> Result<Combo, KeyError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(KeyError::Empty);
    }
    let (head, key_token) = if trimmed == "+" {
        ("", "+")
    } else if let Some(head) = trimmed.strip_suffix("++") {
        (head, "+")
    } else {
        match trimmed.rsplit_once('+') {
            Some((head, last)) => (head, last),
            None => ("", trimmed),
        }
    };
    let key_token = key_token.trim();
    if key_token.is_empty() {
        return Err(KeyError::Empty);
    }
    let mut modifiers: Vec<Modifier> = Vec::new();
    for part in head.split('+').map(str::trim).filter(|p| !p.is_empty()) {
        let m = Modifier::parse(part).ok_or_else(|| KeyError::UnknownModifier(part.to_owned()))?;
        if !modifiers.contains(&m) {
            modifiers.push(m);
        }
    }
    Ok(Combo {
        modifiers,
        key: parse_key(key_token)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_combo() {
        let c = parse_combo("ctrl+shift+t").unwrap();
        assert_eq!(c.modifiers, vec![Modifier::Ctrl, Modifier::Shift]);
        assert_eq!(c.key, Key::Vk(0x54));
    }

    #[test]
    fn the_plus_key() {
        assert_eq!(parse_combo("+").unwrap().key, Key::Char('+'));
        let c = parse_combo("ctrl++").unwrap();
        assert_eq!((c.modifiers, c.key), (vec![Modifier::Ctrl], Key::Char('+')));
    }

    #[test]
    fn errors() {
        assert_eq!(parse_combo(""), Err(KeyError::Empty));
        assert_eq!(parse_combo("ctrl+"), Err(KeyError::Empty));
        assert_eq!(
            parse_combo("hyper+c"),
            Err(KeyError::UnknownModifier("hyper".into()))
        );
        assert_eq!(
            parse_combo("ctrl+wibble"),
            Err(KeyError::UnknownKey("wibble".into()))
        );
    }

    #[test]
    fn function_keys_stop_at_24() {
        assert_eq!(named_key("F1"), Some(0x70));
        assert_eq!(named_key("f24"), Some(0x87));
        assert_eq!(named_key("f25"), None);
        assert_eq!(named_key("f0"), None);
    }
}
