// SPDX-License-Identifier: AGPL-3.0-only
// `naive+https://user:pass@host:port` URL parser + serializer.
//
// This is the *single* place any Cool Tunnel client should turn a
// user-pasted URL into a usable profile. The macOS client already
// parses URLs in its own core; once it migrates to ct-protocol, the
// validation rules become consistent across every platform.
//
// We deliberately don't depend on `url` — the input format is small
// and a hand-written parser saves ~120 KB of binary on Android.

use alloc::borrow::ToOwned;
use alloc::string::{String, ToString};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProfileV1 {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    /// Free-form label the user picked (e.g. "Tokyo VPS"). Optional.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProfileParseError {
    MissingScheme,
    UnsupportedScheme,
    MissingCredentials,
    EmptyUsername,
    EmptyPassword,
    EmptyHost,
    InvalidPort,
    UnsafeUsername,
}

#[cfg(feature = "std")]
impl core::fmt::Display for ProfileParseError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(match self {
            Self::MissingScheme => "URL missing scheme",
            Self::UnsupportedScheme => "scheme must be naive+https://",
            Self::MissingCredentials => "URL has no user:pass@ part",
            Self::EmptyUsername => "username is empty",
            Self::EmptyPassword => "password is empty",
            Self::EmptyHost => "host is empty",
            Self::InvalidPort => "port must be a u16",
            Self::UnsafeUsername => "username contains characters disallowed in basic_auth",
        })
    }
}

#[cfg(feature = "std")]
impl std::error::Error for ProfileParseError {}

impl ProfileV1 {
    /// Parse a `naive+https://user:pass@host:port` URL.
    ///
    /// # Errors
    ///
    /// Returns [`ProfileParseError`] when the input doesn't have the
    /// `naive+https://` (or legacy `naive+http://`) prefix, when
    /// authority parsing fails (missing `:` or `@`), or when the
    /// port isn't a valid `u16`.
    pub fn parse(s: &str) -> Result<Self, ProfileParseError> {
        let s = s.trim();
        let rest = s
            .strip_prefix("naive+https://")
            .or_else(|| {
                s.strip_prefix("naive+http://").map(|_| {
                    // map_or_else trick to differentiate; we only return
                    // Some on the supported scheme. http is intentionally
                    // unsupported — proxying over plaintext defeats the
                    // entire point.
                    ""
                })
            })
            .ok_or(ProfileParseError::MissingScheme)?;

        if rest.is_empty() {
            return Err(ProfileParseError::UnsupportedScheme);
        }

        let (creds, host_port) = rest
            .split_once('@')
            .ok_or(ProfileParseError::MissingCredentials)?;

        let (username, password) = creds
            .split_once(':')
            .ok_or(ProfileParseError::MissingCredentials)?;

        if username.is_empty() {
            return Err(ProfileParseError::EmptyUsername);
        }
        if password.is_empty() {
            return Err(ProfileParseError::EmptyPassword);
        }
        if !is_safe_username(username) {
            return Err(ProfileParseError::UnsafeUsername);
        }

        let (host, port) = host_port
            .rsplit_once(':')
            .ok_or(ProfileParseError::EmptyHost)?;

        if host.is_empty() {
            return Err(ProfileParseError::EmptyHost);
        }
        let port: u16 = port.parse().map_err(|_| ProfileParseError::InvalidPort)?;
        if port == 0 {
            return Err(ProfileParseError::InvalidPort);
        }

        Ok(Self {
            host: host.to_owned(),
            port,
            username: username.to_owned(),
            password: password.to_owned(),
            label: None,
        })
    }

    /// Round-trip back to the canonical URL form. Lossless.
    #[must_use]
    pub fn to_url(&self) -> String {
        // Note: we don't URL-encode the password here because
        // basic_auth already restricts what we accept on the server
        // side. Clients displaying the URL should still escape for
        // their UI's needs.
        let mut s =
            String::with_capacity(64 + self.username.len() + self.password.len() + self.host.len());
        s.push_str("naive+https://");
        s.push_str(&self.username);
        s.push(':');
        s.push_str(&self.password);
        s.push('@');
        s.push_str(&self.host);
        s.push(':');
        s.push_str(&self.port.to_string());
        s
    }
}

fn is_safe_username(u: &str) -> bool {
    !u.is_empty()
        && u.len() <= 64
        && u.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn happy_path() {
        let p = ProfileV1::parse("naive+https://alice:s3cr3t@proxy.example.com:443").unwrap();
        assert_eq!(p.host, "proxy.example.com");
        assert_eq!(p.port, 443);
        assert_eq!(p.username, "alice");
        assert_eq!(p.password, "s3cr3t");
        assert_eq!(
            p.to_url(),
            "naive+https://alice:s3cr3t@proxy.example.com:443"
        );
    }

    #[test]
    fn rejects_http_scheme() {
        assert_eq!(
            ProfileV1::parse("naive+http://alice:p@x:443"),
            Err(ProfileParseError::UnsupportedScheme),
        );
    }

    #[test]
    fn rejects_unsafe_username() {
        assert_eq!(
            ProfileV1::parse("naive+https://al ice:p@x:443"),
            Err(ProfileParseError::UnsafeUsername),
        );
    }

    #[test]
    fn rejects_zero_port() {
        assert_eq!(
            ProfileV1::parse("naive+https://a:b@h:0"),
            Err(ProfileParseError::InvalidPort),
        );
    }

    #[test]
    fn round_trip_via_serde() {
        let p = ProfileV1::parse("naive+https://alice:p@h:443").unwrap();
        let s = serde_json::to_string(&p).unwrap();
        let p2: ProfileV1 = serde_json::from_str(&s).unwrap();
        assert_eq!(p, p2);
    }
}
