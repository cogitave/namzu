//! Per-request limits: a cooperative deadline and an output byte budget.

use std::time::{Duration, Instant};

use serde_json::Value;

use crate::error::{OpError, OpResult};

/// Hard limits the process enforces whatever a request asks for.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// Longest request line accepted, in bytes.
    pub max_request_bytes: usize,
    /// Largest target file accepted, in bytes.
    pub max_file_bytes: u64,
    /// Output cap used when a request names none.
    pub default_max_bytes: usize,
    /// The largest `maxBytes` a request may ask for.
    pub max_max_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_request_bytes: 1 << 20,
            max_file_bytes: 4 << 30,
            default_max_bytes: 4 << 20,
            max_max_bytes: 64 << 20,
        }
    }
}

/// Everything an op needs to stay inside its limits.
pub struct Ctx {
    deadline: Option<Instant>,
    pub max_bytes: usize,
    pub limits: Limits,
    ticks: u64,
}

impl Ctx {
    pub fn new(limits: Limits, deadline_ms: Option<u64>, max_bytes: Option<u64>) -> Self {
        let max_bytes = max_bytes
            .map(|b| usize::try_from(b).unwrap_or(usize::MAX))
            .unwrap_or(limits.default_max_bytes)
            .clamp(1024, limits.max_max_bytes);
        Self {
            deadline: deadline_ms.map(|ms| Instant::now() + Duration::from_millis(ms)),
            max_bytes,
            limits,
            ticks: 0,
        }
    }

    /// A context with no deadline, for tests.
    pub fn unlimited() -> Self {
        Self::new(Limits::default(), None, None)
    }

    /// Check the deadline now.
    pub fn check(&self) -> OpResult<()> {
        match self.deadline {
            Some(d) if Instant::now() >= d => Err(OpError::deadline()),
            _ => Ok(()),
        }
    }

    /// Call once per loop iteration. Looks at the clock on the first call and
    /// then every 4096th, so a hot loop does not pay for `Instant::now`.
    pub fn tick(&mut self) -> OpResult<()> {
        let n = self.ticks;
        self.ticks = self.ticks.wrapping_add(1);
        if n & 0xfff == 0 { self.check() } else { Ok(()) }
    }

    /// The part of the output budget a list may fill. The rest is headroom for
    /// the response envelope and the non-list fields.
    pub fn list_budget(&self) -> Budget {
        Budget {
            remaining: self.max_bytes.saturating_sub(self.max_bytes / 16 + 1024),
        }
    }
}

/// Counts the serialised size of list items against the request's `maxBytes`.
pub struct Budget {
    remaining: usize,
}

impl Budget {
    /// Take room for `item`. False means it does not fit and the list ends here.
    pub fn take(&mut self, item: &Value) -> bool {
        let size = serde_json::to_vec(item).map(|v| v.len() + 1).unwrap_or(0);
        if size > self.remaining {
            self.remaining = 0;
            return false;
        }
        self.remaining -= size;
        true
    }
}
