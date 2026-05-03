// Single error type so we don't pull `anyhow` (heavier than we need).
//
// We can't write a blanket `impl<E: Error> From<E> for Error` — that
// conflicts with std's reflexive `impl<T> From<T> for T`. Instead we
// explicitly enumerate the error types we actually wrap. The list
// reads like a dependency map of the crate, which is fine: the
// compiler tells us when to add a new line.

use std::fmt;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug)]
pub struct Error(pub Box<dyn std::error::Error + Send + Sync>);

impl Error {
    pub fn msg<S: Into<String>>(s: S) -> Self {
        Self(Box::new(StringError(s.into())))
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&*self.0)
    }
}

#[derive(Debug)]
struct StringError(String);
impl fmt::Display for StringError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for StringError {}

// Explicit From impls per dependency. Adding a new dep means adding a
// new line here, which is on purpose — keeps the error surface visible
// at a glance.
macro_rules! from_impl {
    ($($t:ty),+ $(,)?) => {
        $(
            impl From<$t> for Error {
                fn from(e: $t) -> Self { Self(Box::new(e)) }
            }
        )+
    };
}

from_impl! {
    std::io::Error,
    std::str::Utf8Error,
    std::string::FromUtf8Error,
    std::num::ParseIntError,
    serde_json::Error,
    sqlx::Error,
    hyper::Error,
    hyper::http::Error,
    hyper::http::uri::InvalidUri,
    hyper_util::client::legacy::Error,
    reqwest::Error,
    redis::RedisError,
}
