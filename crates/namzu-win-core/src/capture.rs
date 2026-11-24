//! `capture`: a window, a display or a region of the screen as a PNG.
//!
//! The wire shapes and the pixel clean-up that needs no Windows live here.
//! A picture too big for a line (above [`INLINE_LIMIT`]) is written to a file
//! in the directory the request names, and the reply carries the path; a small
//! one may come back inline as base64.

use crate::protocol::Rect;
use serde::{Deserialize, Serialize};

/// The largest picture a reply carries inline, in bytes.
pub const INLINE_LIMIT: usize = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CaptureTarget {
    /// One window, even when something covers it.
    Window {
        #[serde(rename = "windowId")]
        window_id: String,
    },
    /// One display; the primary one when no id is given.
    Display {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    /// A rectangle of the virtual desktop, in physical pixels.
    Region {
        x: i32,
        y: i32,
        width: i32,
        height: i32,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRequest {
    pub target: CaptureTarget,
    /// A directory (made by the caller) the picture is written into. The
    /// helper writes nowhere else.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub into: Option<String>,
    /// Return the picture in the reply when it is small enough.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inline: Option<bool>,
    /// Draw the pointer into the picture. Off unless asked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

impl CaptureRequest {
    pub const DEFAULT_TIMEOUT_MS: u64 = 8_000;

    pub fn timeout_ms(&self) -> u64 {
        self.timeout_ms.unwrap_or(Self::DEFAULT_TIMEOUT_MS)
    }

    /// Where the picture goes: a file, inline, or neither (a request to refuse).
    pub fn delivery(&self) -> Result<Delivery<'_>, String> {
        match (&self.into, self.inline.unwrap_or(false)) {
            (Some(dir), _) => Ok(Delivery::File(dir)),
            (None, true) => Ok(Delivery::Inline),
            (None, false) => Err("capture needs `into` (a directory) or `inline: true`".into()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delivery<'a> {
    File(&'a str),
    Inline,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptureVia {
    /// Windows.Graphics.Capture.
    Wgc,
    /// `PrintWindow` with the full-content flag.
    PrintWindow,
    /// A copy from the screen's device context.
    BitBlt,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureReply {
    /// The file written, when the picture went to `into`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// The picture as base64, when it came inline.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_base64: Option<String>,
    pub bytes: u64,
    pub width: u32,
    pub height: u32,
    /// The display's scale (1.0 is 96 dpi): the one the picture's area is on.
    pub scale: f64,
    pub via: CaptureVia,
    pub sha256: String,
    /// The area the picture shows, in virtual-desktop physical pixels.
    pub bounds: Rect,
    /// The display the picture is of, or the one most of a window is on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display: Option<String>,
}

/// Packs rows of `row_pitch` bytes into rows of `width * 4` bytes.
pub fn tight_rows(data: &[u8], row_pitch: usize, width: usize, height: usize) -> Option<Vec<u8>> {
    let row = width.checked_mul(4)?;
    if row_pitch < row || height == 0 {
        return None;
    }
    let needed = row_pitch.checked_mul(height - 1)?.checked_add(row)?;
    if data.len() < needed {
        return None;
    }
    let mut out = Vec::with_capacity(row * height);
    for y in 0..height {
        let start = y * row_pitch;
        out.extend_from_slice(&data[start..start + row]);
    }
    Some(out)
}

/// The top-left `width` x `height` pixels of tight rows that are `full_width` pixels wide.
pub fn crop_top_left(
    tight: &[u8],
    full_width: usize,
    width: usize,
    height: usize,
) -> Option<Vec<u8>> {
    if width == 0 || height == 0 || width > full_width {
        return None;
    }
    let full_row = full_width.checked_mul(4)?;
    if tight.len() < full_row.checked_mul(height)? {
        return None;
    }
    let row = width * 4;
    let mut out = Vec::with_capacity(row * height);
    for y in 0..height {
        let start = y * full_row;
        out.extend_from_slice(&tight[start..start + row]);
    }
    Some(out)
}

/// Sets every pixel's alpha to opaque: a window's capture may carry zero alpha
/// where the program drew none, which a PNG viewer would show as holes.
pub fn make_opaque(bgra: &mut [u8]) {
    for px in bgra.chunks_exact_mut(4) {
        px[3] = 0xFF;
    }
}

/// The width and height a PNG file's header names.
pub fn png_size(png: &[u8]) -> Option<(u32, u32)> {
    const SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    if png.len() < 24 || png[..8] != SIGNATURE || &png[12..16] != b"IHDR" {
        return None;
    }
    let be = |i: usize| u32::from_be_bytes([png[i], png[i + 1], png[i + 2], png[i + 3]]);
    Some((be(16), be(20)))
}

/// The part of `area` that lies inside `bounds`, or `None` when they do not meet.
pub fn clip(area: &Rect, bounds: &Rect) -> Option<Rect> {
    let x = area.x.max(bounds.x);
    let y = area.y.max(bounds.y);
    let right = area.right().min(bounds.right());
    let bottom = area.bottom().min(bounds.bottom());
    (right > x && bottom > y).then_some(Rect {
        x,
        y,
        width: right - x,
        height: bottom - y,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_picture_goes_to_a_file_or_inline() {
        let mut r = CaptureRequest {
            target: CaptureTarget::Display { id: None },
            into: None,
            inline: None,
            cursor: None,
            timeout_ms: None,
        };
        assert!(r.delivery().is_err());
        r.inline = Some(true);
        assert_eq!(r.delivery(), Ok(Delivery::Inline));
        r.into = Some("C:\\t".into());
        assert_eq!(r.delivery(), Ok(Delivery::File("C:\\t")));
    }

    #[test]
    fn rows_lose_their_padding() {
        // 2 pixels wide, pitch 12 (4 bytes of padding), 2 rows.
        let data: Vec<u8> = (0..24).collect();
        let tight = tight_rows(&data, 12, 2, 2).unwrap();
        assert_eq!(
            tight,
            [0, 1, 2, 3, 4, 5, 6, 7, 12, 13, 14, 15, 16, 17, 18, 19]
        );
        assert!(tight_rows(&data, 4, 2, 2).is_none());
        assert!(tight_rows(&data[..10], 12, 2, 2).is_none());
        // The last row needs no padding after it.
        assert!(tight_rows(&data[..20], 12, 2, 2).is_some());
    }

    #[test]
    fn a_picture_is_cropped_to_its_content() {
        // 3 pixels wide, 2 rows; keep the left 2 of the first row.
        let data: Vec<u8> = (0..24).collect();
        assert_eq!(
            crop_top_left(&data, 3, 2, 1).unwrap(),
            [0, 1, 2, 3, 4, 5, 6, 7]
        );
        assert_eq!(crop_top_left(&data, 3, 3, 2).unwrap(), data);
        assert!(crop_top_left(&data, 3, 4, 1).is_none());
        assert!(crop_top_left(&data, 3, 2, 3).is_none());
    }

    #[test]
    fn alpha_is_made_opaque() {
        let mut px = [1u8, 2, 3, 0, 4, 5, 6, 9];
        make_opaque(&mut px);
        assert_eq!(px, [1, 2, 3, 255, 4, 5, 6, 255]);
    }

    #[test]
    fn a_png_header_is_read() {
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13];
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&640u32.to_be_bytes());
        png.extend_from_slice(&480u32.to_be_bytes());
        assert_eq!(png_size(&png), Some((640, 480)));
        assert_eq!(png_size(&png[..20]), None);
        assert_eq!(png_size(b"not a png at all, no"), None);
    }

    #[test]
    fn a_region_is_clipped_to_a_display() {
        let display = Rect {
            x: 0,
            y: 0,
            width: 100,
            height: 100,
        };
        let area = Rect {
            x: 80,
            y: -10,
            width: 50,
            height: 30,
        };
        assert_eq!(
            clip(&area, &display),
            Some(Rect {
                x: 80,
                y: 0,
                width: 20,
                height: 20
            })
        );
        let apart = Rect {
            x: 200,
            y: 0,
            width: 5,
            height: 5,
        };
        assert_eq!(clip(&apart, &display), None);
    }
}
