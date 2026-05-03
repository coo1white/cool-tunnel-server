// Single error type so we don't pull `anyhow` (heavier than we need).

use std::fmt;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug)]
pub struct Error(pub Box<dyn std::error::Error + Send + Sync>);

impl Error {
    pub fn msg<S: Into<String>>(s: S) -> Self {
        Self(StringError(s.into()).into())
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}
impl std::error::Error for Error {}

impl<E: std::error::Error + Send + Sync + 'static> From<E> for Error {
    fn from(e: E) -> Self {
        // The blanket can't apply here directly because std::error::Error is not Sized;
        // we boxed-trait it instead.
        Self(Box::new(e))
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
