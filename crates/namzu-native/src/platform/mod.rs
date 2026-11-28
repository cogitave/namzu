//! The calls into each operating system, one module per platform. Only the
//! module for the platform being built is compiled.

#[cfg(windows)]
pub mod win32;
