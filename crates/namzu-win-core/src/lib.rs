//! The parts of the `namzu-win` helper that do not touch Windows.
//!
//! Everything here is plain Rust that builds and tests on any platform: the
//! `namzu-win/1` line codec ([`protocol`]), the table that turns a ref back
//! into a control ([`refs`]), the identity of a control that survives a
//! re-read ([`fingerprint`]), key names ([`keys`]), DPI math ([`dpi`]), the controls of a window as a
//! snapshot ([`tree`]) and the stream of changes a wait listens to ([`events`]).
//! The Windows calls themselves live in the `namzu-win` crate and use these.
//!
//! The TypeScript side implements the same codec; `conformance/namzu-win/`
//! holds the vectors both are held to.

pub mod dpi;
pub mod events;
pub mod fingerprint;
pub mod keys;
pub mod protocol;
pub mod refs;
pub mod tree;
pub mod window_id;

pub use protocol::PROTOCOL;
