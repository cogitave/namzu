//! The `namzu-win/1` wire format: one JSON object per line over stdio.
//!
//! A request is `{"id":N,"op":"...", ...fields}`. A reply is
//! `{"id":N,"ok":true, ...fields}` or `{"id":N,"ok":false,"code":"...","message":"..."}`.
//! Field names are camelCase and mirror the TypeScript accessibility
//! interfaces, so the TypeScript side is a codec and not a redesign.
//! `conformance/namzu-win/` holds the lines both sides must agree on.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// The protocol a `hello` must name; a helper refuses any other.
pub const PROTOCOL: &str = "namzu-win/1";

/// The largest id or revision either side writes: what a JavaScript number
/// holds exactly (2^53 - 1), so the TypeScript caller never rounds one.
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Every `op` a request may carry, in the order the design lists them.
pub const OPS: [&str; 10] = [
    "hello",
    "windows",
    "displays",
    "snapshot",
    "identity",
    "resolve",
    "seq",
    "wait_change",
    "cancel",
    "quit",
];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// The failure codes a reply may carry. A TypeScript caller switches on the
/// string, so the spellings are part of the protocol.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    BadRequest,
    UnknownOp,
    ProtocolMismatch,
    StaleSnapshot,
    ChromiumNotActivated,
    NotFound,
    Ambiguous,
    BackgroundUnavailable,
    ElevatedTarget,
    Timeout,
    Unsupported,
    Cancelled,
    Internal,
}

impl ErrorCode {
    pub const ALL: [ErrorCode; 13] = [
        ErrorCode::BadRequest,
        ErrorCode::UnknownOp,
        ErrorCode::ProtocolMismatch,
        ErrorCode::StaleSnapshot,
        ErrorCode::ChromiumNotActivated,
        ErrorCode::NotFound,
        ErrorCode::Ambiguous,
        ErrorCode::BackgroundUnavailable,
        ErrorCode::ElevatedTarget,
        ErrorCode::Timeout,
        ErrorCode::Unsupported,
        ErrorCode::Cancelled,
        ErrorCode::Internal,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::BadRequest => "bad_request",
            ErrorCode::UnknownOp => "unknown_op",
            ErrorCode::ProtocolMismatch => "protocol_mismatch",
            ErrorCode::StaleSnapshot => "stale_snapshot",
            ErrorCode::ChromiumNotActivated => "chromium_not_activated",
            ErrorCode::NotFound => "not_found",
            ErrorCode::Ambiguous => "ambiguous",
            ErrorCode::BackgroundUnavailable => "background_unavailable",
            ErrorCode::ElevatedTarget => "elevated_target",
            ErrorCode::Timeout => "timeout",
            ErrorCode::Unsupported => "unsupported",
            ErrorCode::Cancelled => "cancelled",
            ErrorCode::Internal => "internal",
        }
    }

    pub fn parse(code: &str) -> Option<ErrorCode> {
        ErrorCode::ALL.into_iter().find(|c| c.as_str() == code)
    }
}

/// A failure reply: the code stays a string so a newer helper's code does not
/// make an older reader fail to decode the line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireError {
    pub code: String,
    pub message: String,
}

impl WireError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> WireError {
        WireError {
            code: code.as_str().to_owned(),
            message: message.into(),
        }
    }
}

/// A line that could not be decoded. `id` is set when the line got far enough
/// to name one, so the caller can answer it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodeError {
    pub id: Option<u64>,
    pub error: WireError,
}

impl DecodeError {
    fn new(id: Option<u64>, code: ErrorCode, message: impl Into<String>) -> DecodeError {
        DecodeError {
            id,
            error: WireError::new(code, message),
        }
    }
}

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.error.code, self.error.message)
    }
}

impl std::error::Error for DecodeError {}

// ---------------------------------------------------------------------------
// Shared value types
// ---------------------------------------------------------------------------

/// A rectangle in virtual-desktop physical pixels; `x` and `y` may be negative
/// on a display left of or above the primary one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// A top-level window a person would call a window.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    pub window_id: String,
    pub process_id: u32,
    pub process_name: String,
    pub title: String,
    pub bounds: Rect,
    pub minimized: bool,
    pub focused: bool,
    pub z: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Display {
    pub id: String,
    pub bounds: Rect,
    pub work_area: Rect,
    /// 1.0 is 96 dpi, 1.5 is 144 dpi.
    pub scale: f64,
    pub primary: bool,
}

/// What a control can be asked to do, by the pattern it offers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Invoke,
    Value,
    Toggle,
    ExpandCollapse,
    SelectionItem,
    Scroll,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToggleState {
    On,
    Off,
    Mixed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExpandState {
    Expanded,
    Collapsed,
    Partial,
    Leaf,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    /// Position in [`Snapshot::nodes`].
    pub index: u32,
    /// The handle an `act` takes: `r<revision>.<index>`.
    #[serde(rename = "ref")]
    pub reference: String,
    /// Index of the parent, -1 for the window itself.
    pub parent: i32,
    pub depth: u32,
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub automation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub class_name: Option<String>,
    pub bounds: Rect,
    pub enabled: bool,
    pub offscreen: bool,
    pub focused: bool,
    pub actions: Vec<Action>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub toggle: Option<ToggleState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expand: Option<ExpandState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected: Option<bool>,
    /// Present when the children of this control were not all listed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub child_count: Option<u32>,
}

/// Names a control well enough to find it again after the window changed.
/// Holds no text: the name travels as a hash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fingerprint {
    pub runtime_id: String,
    pub automation_id: String,
    pub role: String,
    pub name_hash: String,
    pub parent_path: String,
    /// Among siblings with the same kind and name.
    pub ordinal: u32,
    /// When the owning process started (ms); a different value means a different run.
    pub process_start: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Structure,
    Property,
    Location,
}

impl ChangeKind {
    pub const ALL: [ChangeKind; 3] = [
        ChangeKind::Structure,
        ChangeKind::Property,
        ChangeKind::Location,
    ];
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloRequest {
    pub protocol: String,
    pub cli_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_owned: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotRequest {
    pub window_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_nodes: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_depth: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skeleton: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_chromium: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

impl SnapshotRequest {
    pub const DEFAULT_MAX_NODES: u32 = 400;
    pub const DEFAULT_MAX_DEPTH: u32 = 12;
    pub const DEFAULT_TIMEOUT_MS: u64 = 8_000;

    pub fn max_nodes(&self) -> u32 {
        self.max_nodes.unwrap_or(Self::DEFAULT_MAX_NODES)
    }
    pub fn max_depth(&self) -> u32 {
        self.max_depth.unwrap_or(Self::DEFAULT_MAX_DEPTH)
    }
    pub fn timeout_ms(&self) -> u64 {
        self.timeout_ms.unwrap_or(Self::DEFAULT_TIMEOUT_MS)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityRequest {
    pub window_id: String,
    /// Position in the window's latest snapshot.
    pub index: u32,
    /// Refuse (`stale_snapshot`) when the window was read again since this revision.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveRequest {
    pub window_id: String,
    pub fingerprint: Fingerprint,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeqRequest {
    /// With a window, also starts watching that window.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaitChangeRequest {
    pub window_id: String,
    /// A token from `seq`: count changes since then. Default: since this call.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quiet_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kinds: Option<Vec<ChangeKind>>,
}

impl WaitChangeRequest {
    pub const DEFAULT_QUIET_MS: u64 = 120;
    pub const DEFAULT_TIMEOUT_MS: u64 = 2_000;
    pub const MAX_TIMEOUT_MS: u64 = 10_000;

    pub fn quiet_ms(&self) -> u64 {
        self.quiet_ms.unwrap_or(Self::DEFAULT_QUIET_MS)
    }
    /// The wait's limit, never above [`Self::MAX_TIMEOUT_MS`].
    pub fn timeout_ms(&self) -> u64 {
        self.timeout_ms
            .unwrap_or(Self::DEFAULT_TIMEOUT_MS)
            .min(Self::MAX_TIMEOUT_MS)
    }
    pub fn kinds(&self) -> Vec<ChangeKind> {
        match &self.kinds {
            Some(k) if !k.is_empty() => k.clone(),
            _ => ChangeKind::ALL.to_vec(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CancelRequest {
    /// The id of the request to stop.
    pub target: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    Hello(HelloRequest),
    Windows(WindowsRequest),
    Displays,
    Snapshot(SnapshotRequest),
    Identity(IdentityRequest),
    Resolve(ResolveRequest),
    Seq(SeqRequest),
    WaitChange(WaitChangeRequest),
    Cancel(CancelRequest),
    Quit,
}

/// The request kinds, for a reader that must know which reply to expect.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    Hello,
    Windows,
    Displays,
    Snapshot,
    Identity,
    Resolve,
    Seq,
    WaitChange,
    Cancel,
    Quit,
}

impl Op {
    pub fn name(self) -> &'static str {
        match self {
            Op::Hello => "hello",
            Op::Windows => "windows",
            Op::Displays => "displays",
            Op::Snapshot => "snapshot",
            Op::Identity => "identity",
            Op::Resolve => "resolve",
            Op::Seq => "seq",
            Op::WaitChange => "wait_change",
            Op::Cancel => "cancel",
            Op::Quit => "quit",
        }
    }

    pub fn from_name(name: &str) -> Option<Op> {
        Some(match name {
            "hello" => Op::Hello,
            "windows" => Op::Windows,
            "displays" => Op::Displays,
            "snapshot" => Op::Snapshot,
            "identity" => Op::Identity,
            "resolve" => Op::Resolve,
            "seq" => Op::Seq,
            "wait_change" => Op::WaitChange,
            "cancel" => Op::Cancel,
            "quit" => Op::Quit,
            _ => return None,
        })
    }
}

impl Request {
    pub fn op(&self) -> Op {
        match self {
            Request::Hello(_) => Op::Hello,
            Request::Windows(_) => Op::Windows,
            Request::Displays => Op::Displays,
            Request::Snapshot(_) => Op::Snapshot,
            Request::Identity(_) => Op::Identity,
            Request::Resolve(_) => Op::Resolve,
            Request::Seq(_) => Op::Seq,
            Request::WaitChange(_) => Op::WaitChange,
            Request::Cancel(_) => Op::Cancel,
            Request::Quit => Op::Quit,
        }
    }
}

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloReply {
    pub version: String,
    pub build_hash: String,
    pub arch: String,
    pub os_build: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signer: Option<String>,
    pub caps: Vec<String>,
    pub dpi_awareness: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WindowsReply {
    pub windows: Vec<Window>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DisplaysReply {
    pub displays: Vec<Display>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub window_id: String,
    /// Names this read; a ref from an older read is refused as stale.
    pub revision: u64,
    pub nodes: Vec<Node>,
    /// Controls in the window, listed or not.
    pub total: u32,
    pub truncated: bool,
    pub skeleton: bool,
    /// How long the platform call took, ms.
    pub read_ms: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IdentityReply {
    pub fingerprint: Fingerprint,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SeqReply {
    pub seq: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResolveVia {
    RuntimeId,
    AutomationId,
    Name,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotFoundCode {
    NotFound,
    Ambiguous,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolution {
    Found {
        /// Index in the read this call made.
        index: u32,
        via: ResolveVia,
        revision: u64,
    },
    Missing {
        code: NotFoundCode,
        candidates: Option<u32>,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolutionWire {
    found: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    index: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    via: Option<ResolveVia>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    code: Option<NotFoundCode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    candidates: Option<u32>,
}

impl From<&Resolution> for ResolutionWire {
    fn from(r: &Resolution) -> ResolutionWire {
        match r {
            Resolution::Found {
                index,
                via,
                revision,
            } => ResolutionWire {
                found: true,
                index: Some(*index),
                via: Some(*via),
                revision: Some(*revision),
                code: None,
                candidates: None,
            },
            Resolution::Missing { code, candidates } => ResolutionWire {
                found: false,
                index: None,
                via: None,
                revision: None,
                code: Some(*code),
                candidates: *candidates,
            },
        }
    }
}

impl TryFrom<ResolutionWire> for Resolution {
    type Error = String;
    fn try_from(w: ResolutionWire) -> Result<Resolution, String> {
        if w.found {
            match (w.index, w.via, w.revision) {
                (Some(index), Some(via), Some(revision)) => Ok(Resolution::Found {
                    index,
                    via,
                    revision,
                }),
                _ => Err("a found resolution carries index, via and revision".to_owned()),
            }
        } else {
            match w.code {
                Some(code) => Ok(Resolution::Missing {
                    code,
                    candidates: w.candidates,
                }),
                None => Err("a missing resolution carries a code".to_owned()),
            }
        }
    }
}

impl Serialize for Resolution {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        ResolutionWire::from(self).serialize(s)
    }
}

impl<'de> Deserialize<'de> for Resolution {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Resolution, D::Error> {
        let wire = ResolutionWire::deserialize(d)?;
        Resolution::try_from(wire).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WaitResult {
    Changed {
        /// False when changes were still arriving at the timeout.
        settled: bool,
        /// From the start of the wait to the first change; negative when it came earlier.
        first_event_ms: i64,
        settled_ms: u64,
        events: u32,
        /// Windows of the same program that appeared.
        new_windows: Vec<String>,
    },
    TimedOut {
        settled_ms: u64,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WaitResultWire {
    changed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    settled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    first_event_ms: Option<i64>,
    settled_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    events: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    new_windows: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    timed_out: Option<bool>,
}

impl From<&WaitResult> for WaitResultWire {
    fn from(r: &WaitResult) -> WaitResultWire {
        match r {
            WaitResult::Changed {
                settled,
                first_event_ms,
                settled_ms,
                events,
                new_windows,
            } => WaitResultWire {
                changed: true,
                settled: Some(*settled),
                first_event_ms: Some(*first_event_ms),
                settled_ms: *settled_ms,
                events: Some(*events),
                new_windows: Some(new_windows.clone()),
                timed_out: None,
            },
            WaitResult::TimedOut { settled_ms } => WaitResultWire {
                changed: false,
                settled: None,
                first_event_ms: None,
                settled_ms: *settled_ms,
                events: None,
                new_windows: None,
                timed_out: Some(true),
            },
        }
    }
}

impl TryFrom<WaitResultWire> for WaitResult {
    type Error = String;
    fn try_from(w: WaitResultWire) -> Result<WaitResult, String> {
        if w.changed {
            match (w.settled, w.first_event_ms, w.events, w.new_windows) {
                (Some(settled), Some(first_event_ms), Some(events), Some(new_windows)) => {
                    Ok(WaitResult::Changed {
                        settled,
                        first_event_ms,
                        settled_ms: w.settled_ms,
                        events,
                        new_windows,
                    })
                }
                _ => Err(
                    "a changed wait carries settled, firstEventMs, events and newWindows"
                        .to_owned(),
                ),
            }
        } else if w.timed_out == Some(true) {
            Ok(WaitResult::TimedOut {
                settled_ms: w.settled_ms,
            })
        } else {
            Err("an unchanged wait carries timedOut: true".to_owned())
        }
    }
}

impl Serialize for WaitResult {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        WaitResultWire::from(self).serialize(s)
    }
}

impl<'de> Deserialize<'de> for WaitResult {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<WaitResult, D::Error> {
        let wire = WaitResultWire::deserialize(d)?;
        WaitResult::try_from(wire).map_err(serde::de::Error::custom)
    }
}

/// What a successful reply carries, by the op it answers.
#[derive(Debug, Clone, PartialEq)]
pub enum ReplyBody {
    Hello(HelloReply),
    Windows(WindowsReply),
    Displays(DisplaysReply),
    Snapshot(Snapshot),
    Identity(IdentityReply),
    Resolve(Resolution),
    Seq(SeqReply),
    WaitChange(WaitResult),
    /// `cancel` and `quit`: nothing but `ok`.
    Ack,
}

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

fn take_id(map: &mut Map<String, Value>) -> Result<u64, DecodeError> {
    match map.remove("id") {
        Some(Value::Number(n)) => {
            n.as_u64()
                .filter(|id| *id <= MAX_SAFE_INTEGER)
                .ok_or_else(|| {
                    DecodeError::new(
                        None,
                        ErrorCode::BadRequest,
                        "id must be a non-negative integer",
                    )
                })
        }
        Some(_) => Err(DecodeError::new(
            None,
            ErrorCode::BadRequest,
            "id must be a non-negative integer",
        )),
        None => Err(DecodeError::new(
            None,
            ErrorCode::BadRequest,
            "id is required",
        )),
    }
}

fn parse_object(line: &str) -> Result<Map<String, Value>, DecodeError> {
    match serde_json::from_str::<Value>(line.trim()) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Err(DecodeError::new(
            None,
            ErrorCode::BadRequest,
            "a line is one JSON object",
        )),
        Err(e) => Err(DecodeError::new(
            None,
            ErrorCode::BadRequest,
            format!("not JSON: {e}"),
        )),
    }
}

/// Reads one request line. A failure names the id when the line had one.
pub fn decode_request(line: &str) -> Result<(u64, Request), DecodeError> {
    let mut map = parse_object(line)?;
    let id = take_id(&mut map)?;
    let fail = |code: ErrorCode, message: String| DecodeError::new(Some(id), code, message);
    let op_name = match map.get("op") {
        Some(Value::String(s)) => s.clone(),
        Some(_) => {
            return Err(fail(
                ErrorCode::BadRequest,
                "op must be a string".to_owned(),
            ));
        }
        None => return Err(fail(ErrorCode::BadRequest, "op is required".to_owned())),
    };
    if Op::from_name(&op_name).is_none() {
        return Err(fail(
            ErrorCode::UnknownOp,
            format!("unknown op \"{op_name}\""),
        ));
    }
    serde_json::from_value::<Request>(Value::Object(map))
        .map(|request| (id, request))
        .map_err(|e| fail(ErrorCode::BadRequest, format!("{op_name}: {e}")))
}

/// Writes one request as a line, without the trailing newline.
pub fn encode_request(id: u64, request: &Request) -> String {
    let mut map = match serde_json::to_value(request) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    };
    map.insert("id".to_owned(), Value::from(id));
    Value::Object(map).to_string()
}

/// Writes one reply as a line, without the trailing newline.
pub fn encode_reply(id: u64, reply: &Result<ReplyBody, WireError>) -> String {
    let mut map = Map::new();
    map.insert("id".to_owned(), Value::from(id));
    match reply {
        Ok(body) => {
            map.insert("ok".to_owned(), Value::Bool(true));
            let payload = match body {
                ReplyBody::Hello(b) => serde_json::to_value(b),
                ReplyBody::Windows(b) => serde_json::to_value(b),
                ReplyBody::Displays(b) => serde_json::to_value(b),
                ReplyBody::Snapshot(b) => serde_json::to_value(b),
                ReplyBody::Identity(b) => serde_json::to_value(b),
                ReplyBody::Resolve(b) => serde_json::to_value(b),
                ReplyBody::Seq(b) => serde_json::to_value(b),
                ReplyBody::WaitChange(b) => serde_json::to_value(b),
                ReplyBody::Ack => Ok(Value::Object(Map::new())),
            };
            if let Ok(Value::Object(fields)) = payload {
                map.extend(fields);
            }
        }
        Err(e) => {
            map.insert("ok".to_owned(), Value::Bool(false));
            map.insert("code".to_owned(), Value::String(e.code.clone()));
            map.insert("message".to_owned(), Value::String(e.message.clone()));
        }
    }
    Value::Object(map).to_string()
}

/// Reads one reply line the caller knows the op of.
pub fn decode_reply(
    op: Op,
    line: &str,
) -> Result<(u64, Result<ReplyBody, WireError>), DecodeError> {
    let mut map = parse_object(line)?;
    let id = take_id(&mut map)?;
    let fail = |message: String| DecodeError::new(Some(id), ErrorCode::BadRequest, message);
    let ok = match map.remove("ok") {
        Some(Value::Bool(b)) => b,
        _ => return Err(fail("ok must be a boolean".to_owned())),
    };
    let payload = Value::Object(map);
    if !ok {
        return serde_json::from_value::<WireError>(payload)
            .map(|e| (id, Err(e)))
            .map_err(|e| fail(format!("failure reply: {e}")));
    }
    let body = match op {
        Op::Hello => serde_json::from_value(payload).map(ReplyBody::Hello),
        Op::Windows => serde_json::from_value(payload).map(ReplyBody::Windows),
        Op::Displays => serde_json::from_value(payload).map(ReplyBody::Displays),
        Op::Snapshot => serde_json::from_value(payload).map(ReplyBody::Snapshot),
        Op::Identity => serde_json::from_value(payload).map(ReplyBody::Identity),
        Op::Resolve => serde_json::from_value(payload).map(ReplyBody::Resolve),
        Op::Seq => serde_json::from_value(payload).map(ReplyBody::Seq),
        Op::WaitChange => serde_json::from_value(payload).map(ReplyBody::WaitChange),
        Op::Cancel | Op::Quit => Ok(ReplyBody::Ack),
    };
    body.map(|b| (id, Ok(b)))
        .map_err(|e| fail(format!("{} reply: {e}", op.name())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_codes_round_trip_by_spelling() {
        for code in ErrorCode::ALL {
            assert_eq!(ErrorCode::parse(code.as_str()), Some(code));
        }
        assert_eq!(ErrorCode::parse("nope"), None);
    }

    #[test]
    fn every_listed_op_has_a_variant_and_back() {
        for name in OPS {
            let op = Op::from_name(name).expect("listed op");
            assert_eq!(op.name(), name);
        }
    }

    #[test]
    fn wait_defaults_and_cap() {
        let req = WaitChangeRequest {
            window_id: "w".into(),
            since: None,
            quiet_ms: None,
            timeout_ms: Some(60_000),
            kinds: Some(vec![]),
        };
        assert_eq!(req.quiet_ms(), 120);
        assert_eq!(req.timeout_ms(), 10_000);
        assert_eq!(req.kinds(), ChangeKind::ALL.to_vec());
    }

    #[test]
    fn a_failed_decode_names_the_id_when_it_can() {
        let e = decode_request(r#"{"id":7,"op":"nope"}"#).unwrap_err();
        assert_eq!(e.id, Some(7));
        assert_eq!(e.error.code, "unknown_op");
        let e = decode_request(r#"{"op":"hello"}"#).unwrap_err();
        assert_eq!(e.id, None);
    }
}
