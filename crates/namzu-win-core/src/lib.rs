//! The parts of the `namzu-win` helper that do not touch Windows.
//!
//! Everything here is plain Rust that builds and tests on any platform: the
//! `namzu-win/1` line codec ([`protocol`]), the table that turns a ref back
//! into a control ([`refs`]), the identity of a control that survives a
//! re-read ([`fingerprint`]), key names ([`keys`]), DPI math ([`dpi`]), the controls of a window as a
//! snapshot ([`tree`]), the stream of changes a wait listens to ([`events`]), what
//! `act` may do to a control ([`act`]), the plan an `input` is carried out as
//! ([`input`]), the pixels of a `capture` ([`capture`]), the foreground lease
//! ([`foreground`]) and the hashes and base64 the pictures need ([`bytes`]).
//! The Windows calls themselves live in the `namzu-win` crate and use these.
//!
//! The TypeScript side implements the same codec; `conformance/namzu-win/`
//! holds the vectors both are held to.

pub mod act;
pub mod bytes;
pub mod capture;
pub mod dpi;
pub mod events;
pub mod fingerprint;
pub mod foreground;
pub mod input;
pub mod keys;
pub mod protocol;
pub mod refs;
pub mod tree;
pub mod window_id;

pub use protocol::PROTOCOL;
