//! Pictures of the screen: a window, a display, a region.
//!
//! A window or a display is captured with Windows.Graphics.Capture, which
//! works while the window is covered and does not draw the pointer or the
//! yellow border unless asked. Where that is not available (an older
//! Windows, a minimized window) a window is drawn with `PrintWindow`, and a
//! region, or a display that the capture API refused, is copied from the
//! screen's device context. The pixels come back as one BGRA buffer; the PNG
//! is written by the Windows imaging component, so the helper carries no
//! encoder of its own.

use super::enumerate::{self, frame_rect, rect_of};
use namzu_win_core::capture::{CaptureVia, clip, crop_top_left, make_opaque, tight_rows};
use namzu_win_core::dpi;
use namzu_win_core::protocol::{ErrorCode, Rect, WireError};
use std::time::{Duration, Instant};
use windows::Graphics::Capture::{
    Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession,
};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::{HMODULE, HWND};
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE, D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAP_READ,
    D3D11_MAPPED_SUBRESOURCE, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::{IDXGIAdapter, IDXGIDevice};
use windows::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BitBlt, CAPTUREBLT, CreateCompatibleDC, CreateDIBSection,
    DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDC, HMONITOR, MONITOR_DEFAULTTONEAREST,
    MonitorFromWindow, RGBQUAD, ReleaseDC, SRCCOPY, SelectObject,
};
use windows::Win32::Graphics::Imaging::{
    CLSID_WICImagingFactory, GUID_ContainerFormatPng, GUID_WICPixelFormat32bppBGRA,
    IWICImagingFactory, WICBitmapEncoderNoCache,
};
use windows::Win32::Storage::Xps::{PRINT_WINDOW_FLAGS, PrintWindow};
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, CoCreateInstance, STATFLAG_NONAME, STATSTG, STREAM_SEEK_SET,
};
use windows::Win32::System::WinRT::Direct3D11::{
    CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::UI::Shell::SHCreateMemStream;
use windows::Win32::UI::WindowsAndMessaging::{GetWindowRect, IsIconic};
use windows::core::Interface;

/// `PW_RENDERFULLCONTENT`: ask the program to draw even what DWM composes itself.
const PW_RENDERFULLCONTENT: u32 = 2;

pub struct Shot {
    pub width: u32,
    pub height: u32,
    /// Tight rows of BGRA pixels, opaque.
    pub bgra: Vec<u8>,
    pub via: CaptureVia,
    /// What the picture shows, in virtual-desktop physical pixels.
    pub bounds: Rect,
    pub scale: f64,
    pub display: Option<String>,
}

fn fail(message: impl Into<String>) -> WireError {
    WireError::new(ErrorCode::Internal, message)
}

// --- Windows.Graphics.Capture ------------------------------------------------

enum Item {
    Window(HWND),
    Monitor(HMONITOR),
}

fn create_device() -> windows::core::Result<(ID3D11Device, ID3D11DeviceContext)> {
    let mut last = windows::core::Error::empty();
    for driver in [D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP] {
        let (mut device, mut context) = (None, None);
        // SAFETY: out parameters point at locals that live through the call.
        let made = unsafe {
            D3D11CreateDevice(
                None::<&IDXGIAdapter>,
                driver as D3D_DRIVER_TYPE,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
        };
        match (made, device, context) {
            (Ok(()), Some(d), Some(c)) => return Ok((d, c)),
            (Err(e), _, _) => last = e,
            _ => {}
        }
    }
    Err(last)
}

/// One frame of `item` as tight BGRA rows.
fn wgc(item: &Item, cursor: bool, timeout: Duration) -> Result<(u32, u32, Vec<u8>), String> {
    let e = |what: &str| {
        let what = what.to_owned();
        move |err: windows::core::Error| format!("{what}: 0x{:08x}", err.code().0 as u32)
    };
    unsafe {
        if !GraphicsCaptureSession::IsSupported().map_err(e("IsSupported"))? {
            return Err("this Windows cannot capture a window".to_owned());
        }
        let (device, context) = create_device().map_err(e("D3D11CreateDevice"))?;
        let dxgi: IDXGIDevice = device.cast().map_err(e("IDXGIDevice"))?;
        let winrt_device: IDirect3DDevice = CreateDirect3D11DeviceFromDXGIDevice(&dxgi)
            .map_err(e("CreateDirect3D11DeviceFromDXGIDevice"))?
            .cast()
            .map_err(e("IDirect3DDevice"))?;
        let interop = windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()
            .map_err(e("capture item factory"))?;
        let captured: GraphicsCaptureItem = match item {
            Item::Window(h) => interop.CreateForWindow(*h),
            Item::Monitor(m) => interop.CreateForMonitor(*m),
        }
        .map_err(e("CreateForWindow"))?;
        let size = captured.Size().map_err(e("Size"))?;
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            &winrt_device,
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            1,
            size,
        )
        .map_err(e("CreateFreeThreaded"))?;
        let session = pool
            .CreateCaptureSession(&captured)
            .map_err(e("CreateCaptureSession"))?;
        // Off unless asked. The border switch needs a recent Windows; where it
        // is missing the error is ignored and the system draws its border.
        let _ = session.SetIsCursorCaptureEnabled(cursor);
        let _ = session.SetIsBorderRequired(false);
        session.StartCapture().map_err(e("StartCapture"))?;
        let deadline = Instant::now() + timeout;
        let frame = loop {
            if let Ok(frame) = pool.TryGetNextFrame() {
                break frame;
            }
            if Instant::now() >= deadline {
                let _ = session.Close();
                let _ = pool.Close();
                return Err("no frame arrived".to_owned());
            }
            std::thread::sleep(Duration::from_millis(8));
        };
        let result = read_frame(&device, &context, &frame);
        let _ = frame.Close();
        let _ = session.Close();
        let _ = pool.Close();
        result
    }
}

unsafe fn read_frame(
    device: &ID3D11Device,
    context: &ID3D11DeviceContext,
    frame: &windows::Graphics::Capture::Direct3D11CaptureFrame,
) -> Result<(u32, u32, Vec<u8>), String> {
    let e = |what: &str| {
        let what = what.to_owned();
        move |err: windows::core::Error| format!("{what}: 0x{:08x}", err.code().0 as u32)
    };
    unsafe {
        let content = frame.ContentSize().map_err(e("ContentSize"))?;
        let surface = frame.Surface().map_err(e("Surface"))?;
        let access: IDirect3DDxgiInterfaceAccess = surface.cast().map_err(e("surface access"))?;
        let texture: ID3D11Texture2D = access.GetInterface().map_err(e("GetInterface"))?;
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        texture.GetDesc(&mut desc);
        desc.Usage = D3D11_USAGE_STAGING;
        desc.BindFlags = 0;
        desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
        desc.MiscFlags = 0;
        let mut staging: Option<ID3D11Texture2D> = None;
        device
            .CreateTexture2D(&desc, None, Some(&mut staging))
            .map_err(e("CreateTexture2D"))?;
        let staging = staging.ok_or("no staging texture")?;
        context.CopyResource(&staging, &texture);
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        context
            .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
            .map_err(e("Map"))?;
        let (full_w, full_h) = (desc.Width as usize, desc.Height as usize);
        let pitch = mapped.RowPitch as usize;
        let raw = std::slice::from_raw_parts(mapped.pData as *const u8, pitch * full_h);
        let tight = tight_rows(raw, pitch, full_w, full_h);
        context.Unmap(&staging, 0);
        let tight = tight.ok_or("the frame's rows do not fit its size")?;
        let w = (content.Width.max(1) as usize).min(full_w);
        let h = (content.Height.max(1) as usize).min(full_h);
        let cropped = if w == full_w && h == full_h {
            tight
        } else {
            crop_top_left(&tight, full_w, w, h).ok_or("the frame's content does not fit it")?
        };
        Ok((w as u32, h as u32, cropped))
    }
}

// --- GDI ----------------------------------------------------------------------

fn bitmap_info(width: i32, height: i32) -> BITMAPINFO {
    BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            // Negative: rows run top to bottom.
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        bmiColors: [RGBQUAD::default(); 1],
    }
}

/// Draws into a new top-down 32-bit bitmap with `paint` and returns its pixels.
fn with_bitmap(
    width: i32,
    height: i32,
    paint: impl FnOnce(windows::Win32::Graphics::Gdi::HDC) -> bool,
) -> Result<Vec<u8>, WireError> {
    if width <= 0 || height <= 0 || i64::from(width) * i64::from(height) > 1 << 28 {
        return Err(WireError::new(
            ErrorCode::BadRequest,
            "the area to capture is empty or too large",
        ));
    }
    unsafe {
        let screen = GetDC(None);
        let memory = CreateCompatibleDC(Some(screen));
        let info = bitmap_info(width, height);
        let mut bits: *mut std::ffi::c_void = std::ptr::null_mut();
        let made = CreateDIBSection(Some(screen), &info, DIB_RGB_COLORS, &mut bits, None, 0);
        let result = match made {
            Ok(bitmap) if !bits.is_null() => {
                let old = SelectObject(memory, bitmap.into());
                let painted = paint(memory);
                let out = painted.then(|| {
                    std::slice::from_raw_parts(
                        bits as *const u8,
                        width as usize * height as usize * 4,
                    )
                    .to_vec()
                });
                SelectObject(memory, old);
                let _ = DeleteObject(bitmap.into());
                out.ok_or_else(|| fail("the screen could not be copied"))
            }
            Ok(bitmap) => {
                let _ = DeleteObject(bitmap.into());
                Err(fail("no bitmap memory"))
            }
            Err(e) => Err(fail(format!(
                "CreateDIBSection: 0x{:08x}",
                e.code().0 as u32
            ))),
        };
        let _ = DeleteDC(memory);
        ReleaseDC(None, screen);
        result
    }
}

fn bitblt(area: &Rect) -> Result<Vec<u8>, WireError> {
    with_bitmap(area.width, area.height, |memory| unsafe {
        let screen = GetDC(None);
        let ok = BitBlt(
            memory,
            0,
            0,
            area.width,
            area.height,
            Some(screen),
            area.x,
            area.y,
            SRCCOPY | CAPTUREBLT,
        )
        .is_ok();
        ReleaseDC(None, screen);
        ok
    })
}

fn print_window(hwnd: HWND, width: i32, height: i32) -> Result<Vec<u8>, WireError> {
    with_bitmap(width, height, |memory| unsafe {
        PrintWindow(hwnd, memory, PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT)).as_bool()
    })
}

// --- Targets ------------------------------------------------------------------

fn monitor_scale(
    monitors: &[(HMONITOR, namzu_win_core::protocol::Display)],
    h: HMONITOR,
) -> (f64, Option<String>) {
    monitors
        .iter()
        .find(|(m, _)| *m == h)
        .map_or((1.0, None), |(_, d)| (d.scale, Some(d.id.clone())))
}

/// A window, drawn as it is even when covered.
pub fn window(hwnd: HWND, cursor: bool, timeout: Duration) -> Result<Shot, WireError> {
    let iconic = unsafe { IsIconic(hwnd).as_bool() };
    let monitors = enumerate::monitors();
    let nearest = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    let (scale, display) = monitor_scale(&monitors, nearest);
    if !iconic {
        if let Ok((width, height, mut bgra)) = wgc(&Item::Window(hwnd), cursor, timeout) {
            make_opaque(&mut bgra);
            let frame = frame_rect(hwnd, false);
            return Ok(Shot {
                width,
                height,
                bgra,
                via: CaptureVia::Wgc,
                bounds: Rect {
                    x: frame.x,
                    y: frame.y,
                    width: width as i32,
                    height: height as i32,
                },
                scale,
                display,
            });
        }
    }
    let mut r = windows::Win32::Foundation::RECT::default();
    unsafe {
        let _ = GetWindowRect(hwnd, &mut r);
    }
    let bounds = rect_of(r);
    let mut bgra = print_window(hwnd, bounds.width, bounds.height)?;
    make_opaque(&mut bgra);
    Ok(Shot {
        width: bounds.width as u32,
        height: bounds.height as u32,
        bgra,
        via: CaptureVia::PrintWindow,
        bounds,
        scale,
        display,
    })
}

/// A display; the primary one when `id` is not given.
pub fn display(id: Option<&str>, cursor: bool, timeout: Duration) -> Result<Shot, WireError> {
    let monitors = enumerate::monitors();
    let (handle, info) = monitors
        .iter()
        .find(|(_, d)| match id {
            Some(id) => d.id == id,
            None => d.primary,
        })
        .or_else(|| if id.is_none() { monitors.first() } else { None })
        .ok_or_else(|| WireError::new(ErrorCode::NotFound, "no such display"))?;
    if let Ok((width, height, mut bgra)) = wgc(&Item::Monitor(*handle), cursor, timeout) {
        make_opaque(&mut bgra);
        return Ok(Shot {
            width,
            height,
            bgra,
            via: CaptureVia::Wgc,
            bounds: Rect {
                x: info.bounds.x,
                y: info.bounds.y,
                width: width as i32,
                height: height as i32,
            },
            scale: info.scale,
            display: Some(info.id.clone()),
        });
    }
    let mut bgra = bitblt(&info.bounds)?;
    make_opaque(&mut bgra);
    Ok(Shot {
        width: info.bounds.width as u32,
        height: info.bounds.height as u32,
        bgra,
        via: CaptureVia::BitBlt,
        bounds: info.bounds,
        scale: info.scale,
        display: Some(info.id.clone()),
    })
}

/// A rectangle of the virtual desktop, copied from the screen.
pub fn region(area: &Rect) -> Result<Shot, WireError> {
    let monitors = enumerate::monitors();
    let all: Vec<dpi::Monitor> = monitors
        .iter()
        .map(|(_, d)| dpi::Monitor {
            id: d.id.clone(),
            bounds: d.bounds,
            dpi: (d.scale * 96.0).round() as u32,
        })
        .collect();
    let desktop = dpi::virtual_bounds(&all)
        .ok_or_else(|| WireError::new(ErrorCode::NotFound, "no display"))?;
    let area = clip(area, &desktop).ok_or_else(|| {
        WireError::new(ErrorCode::BadRequest, "the region is outside every display")
    })?;
    let mut bgra = bitblt(&area)?;
    make_opaque(&mut bgra);
    let centre = area.center();
    let at = dpi::monitor_nearest(&all, centre);
    Ok(Shot {
        width: area.width as u32,
        height: area.height as u32,
        bgra,
        via: CaptureVia::BitBlt,
        bounds: area,
        scale: at.map_or(1.0, |m| m.scale()),
        display: at.map(|m| m.id.clone()),
    })
}

// --- PNG ----------------------------------------------------------------------

/// The picture as a PNG file's bytes, encoded by the Windows imaging component.
pub fn encode_png(shot: &Shot) -> Result<Vec<u8>, WireError> {
    let e = |what: &str| {
        let what = what.to_owned();
        move |err: windows::core::Error| fail(format!("{what}: 0x{:08x}", err.code().0 as u32))
    };
    unsafe {
        let factory: IWICImagingFactory =
            CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)
                .map_err(e("imaging factory"))?;
        let stream = SHCreateMemStream(None).ok_or_else(|| fail("no memory stream"))?;
        let encoder = factory
            .CreateEncoder(&GUID_ContainerFormatPng, std::ptr::null())
            .map_err(e("CreateEncoder"))?;
        encoder
            .Initialize(&stream, WICBitmapEncoderNoCache)
            .map_err(e("encoder Initialize"))?;
        let mut frame = None;
        encoder
            .CreateNewFrame(&mut frame, std::ptr::null_mut())
            .map_err(e("CreateNewFrame"))?;
        let frame = frame.ok_or_else(|| fail("no frame"))?;
        frame.Initialize(None).map_err(e("frame Initialize"))?;
        frame
            .SetSize(shot.width, shot.height)
            .map_err(e("SetSize"))?;
        let mut format = GUID_WICPixelFormat32bppBGRA;
        frame
            .SetPixelFormat(&mut format)
            .map_err(e("SetPixelFormat"))?;
        frame
            .WritePixels(shot.height, shot.width * 4, &shot.bgra)
            .map_err(e("WritePixels"))?;
        frame.Commit().map_err(e("frame Commit"))?;
        encoder.Commit().map_err(e("encoder Commit"))?;
        let mut stat = STATSTG::default();
        stream.Stat(&mut stat, STATFLAG_NONAME).map_err(e("Stat"))?;
        let size = stat.cbSize as usize;
        stream.Seek(0, STREAM_SEEK_SET, None).map_err(e("Seek"))?;
        let mut png = vec![0u8; size];
        let mut read = 0u32;
        stream
            .Read(png.as_mut_ptr().cast(), size as u32, Some(&mut read))
            .ok()
            .map_err(e("Read"))?;
        png.truncate(read as usize);
        Ok(png)
    }
}
