//! The error every op returns: a stable machine-readable code and a message.

use std::fmt;

/// Codes are part of the wire protocol. Add, never rename.
#[derive(Debug, Clone)]
pub struct OpError {
    pub code: &'static str,
    pub message: String,
}

pub type OpResult<T> = Result<T, OpError>;

impl OpError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn invalid_params(message: impl Into<String>) -> Self {
        Self::new("invalid_params", message)
    }

    pub fn unsupported_format(message: impl Into<String>) -> Self {
        Self::new("unsupported_format", message)
    }

    pub fn parse_error(message: impl Into<String>) -> Self {
        Self::new("parse_error", message)
    }

    pub fn deadline() -> Self {
        Self::new(
            "deadline_exceeded",
            "the request ran past its deadline and was stopped",
        )
    }
}

impl fmt::Display for OpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for OpError {}

impl From<serde_json::Error> for OpError {
    fn from(e: serde_json::Error) -> Self {
        Self::invalid_params(e.to_string())
    }
}
