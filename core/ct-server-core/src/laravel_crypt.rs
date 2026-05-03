// Laravel-compatible AES-256-GCM decryption.
//
// Laravel 11's `Crypt::encryptString($plain)` produces:
//   base64( JSON {"iv":"<b64-12B>","value":"<b64-ct>","tag":"<b64-16B>","mac":""} )
// using the key derived from `base64:` + APP_KEY (the part after the
// `base64:` prefix is base64 of the 32-byte AES-256 key).
//
// On the panel side, ProxyAccount::setCleartextPassword() calls
// Crypt::encryptString. Here we reverse that — used by db.rs when
// hydrating active_proxy_accounts() so the rendered sing-box config
// has the cleartext sing-box needs.
//
// This impl only supports the modern AES-256-GCM mode Laravel 11
// defaults to. Older AES-256-CBC (Laravel ≤ 10) is not handled here
// and will return an InvalidPayload error — the panel runs Laravel 11
// per composer.json so this is fine.

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::Deserialize;
use std::fmt;

#[derive(Debug)]
pub enum CryptError {
    EmptyAppKey,
    BadAppKey,
    InvalidPayload,
    DecryptFailed,
}

impl fmt::Display for CryptError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::EmptyAppKey => {
                "APP_KEY env var is empty. \
                The Rust core needs the SAME APP_KEY the panel uses so it can \
                decrypt cleartext proxy passwords. \
                Check that docker-compose.yml passes APP_KEY through to the \
                panel container (it lives in .env at the repo root) and that \
                the supervisord-managed daemon inherits it."
            }
            Self::BadAppKey => {
                "APP_KEY is set but does not look like a Laravel key. \
                Expected format: `base64:<44 base64 chars decoding to 32 bytes>`. \
                Generate a fresh one with: \
                `docker compose exec panel php artisan key:generate --show`"
            }
            Self::InvalidPayload => {
                "Encrypted payload is not a valid Laravel Crypt envelope. \
                This usually means a column was hand-edited in the DB or restored from a \
                backup made under a different APP_KEY. Regenerate the affected proxy \
                account's password from the panel — that re-encrypts under the current key."
            }
            Self::DecryptFailed => {
                "AES-GCM decryption failed. \
                The stored ciphertext is well-formed but the key is wrong (or the row was \
                tampered with). Most common cause: APP_KEY was rotated and old rows weren't \
                re-encrypted. Regenerate the affected proxy account's password from the \
                panel; that fixes it for that user."
            }
        })
    }
}
impl std::error::Error for CryptError {}

#[derive(Debug, Deserialize)]
struct Envelope {
    iv: String,
    value: String,
    #[serde(default)]
    #[allow(dead_code)]
    mac: String,
    #[serde(default)]
    tag: String,
}

pub fn decrypt(payload_b64: &str, app_key: &str) -> Result<String, CryptError> {
    if app_key.is_empty() {
        return Err(CryptError::EmptyAppKey);
    }
    let key_bytes = parse_app_key(app_key)?;
    let cipher = Aes256Gcm::new_from_slice(&key_bytes).map_err(|_| CryptError::BadAppKey)?;

    // Outer envelope: Laravel base64-encodes the JSON.
    let envelope_json = B64
        .decode(payload_b64.trim())
        .map_err(|_| CryptError::InvalidPayload)?;
    let env: Envelope =
        serde_json::from_slice(&envelope_json).map_err(|_| CryptError::InvalidPayload)?;

    let iv = B64
        .decode(&env.iv)
        .map_err(|_| CryptError::InvalidPayload)?;
    let ct = B64
        .decode(&env.value)
        .map_err(|_| CryptError::InvalidPayload)?;
    let tag = B64
        .decode(&env.tag)
        .map_err(|_| CryptError::InvalidPayload)?;

    if iv.len() != 12 || tag.len() != 16 {
        return Err(CryptError::InvalidPayload);
    }

    // AES-GCM in aes_gcm 0.10 expects the tag appended to the
    // ciphertext.
    let mut sealed = ct;
    sealed.extend_from_slice(&tag);

    let nonce = Nonce::from_slice(&iv);
    let plain = cipher
        .decrypt(nonce, sealed.as_ref())
        .map_err(|_| CryptError::DecryptFailed)?;

    String::from_utf8(plain).map_err(|_| CryptError::DecryptFailed)
}

fn parse_app_key(app_key: &str) -> Result<[u8; 32], CryptError> {
    // Laravel stores APP_KEY as `base64:<32B-key-base64>`.
    let stripped = app_key
        .strip_prefix("base64:")
        .ok_or(CryptError::BadAppKey)?;
    let decoded = B64.decode(stripped).map_err(|_| CryptError::BadAppKey)?;
    if decoded.len() != 32 {
        return Err(CryptError::BadAppKey);
    }
    let mut out = [0_u8; 32];
    out.copy_from_slice(&decoded);
    Ok(out)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use aes_gcm::aead::Aead;
    use aes_gcm::{Aes256Gcm, KeyInit};

    fn fixture_app_key() -> String {
        // 32 zero bytes, base64-encoded — only used in tests.
        let key = [0u8; 32];
        format!("base64:{}", B64.encode(key))
    }

    /// Manually produce a Laravel-shaped envelope using the same
    /// key, then verify decrypt() round-trips. Doesn't depend on the
    /// real Laravel runtime.
    #[test]
    fn round_trip_with_self_constructed_envelope() {
        let app_key = fixture_app_key();
        let key_bytes = parse_app_key(&app_key).unwrap();
        let cipher = Aes256Gcm::new_from_slice(&key_bytes).unwrap();

        let plaintext = b"hello-secret";
        let iv = [42_u8; 12];
        let nonce = Nonce::from_slice(&iv);
        let mut sealed = cipher.encrypt(nonce, plaintext.as_ref()).unwrap();
        // aes-gcm 0.10 returns ct||tag; split.
        let tag = sealed.split_off(sealed.len() - 16);

        let env_json = format!(
            r#"{{"iv":"{}","value":"{}","mac":"","tag":"{}"}}"#,
            B64.encode(iv),
            B64.encode(&sealed),
            B64.encode(&tag),
        );
        let outer = B64.encode(env_json.as_bytes());

        let got = decrypt(&outer, &app_key).unwrap();
        assert_eq!(got, "hello-secret");
    }

    #[test]
    fn empty_key_errors() {
        let r = decrypt("anything", "");
        assert!(matches!(r, Err(CryptError::EmptyAppKey)));
    }

    #[test]
    fn malformed_envelope_errors() {
        let r = decrypt("not-base64!!!!", &fixture_app_key());
        assert!(matches!(r, Err(CryptError::InvalidPayload)));
    }

    #[test]
    fn parse_app_key_rejects_non_base64_prefix() {
        assert!(matches!(
            parse_app_key("rawhex"),
            Err(CryptError::BadAppKey)
        ));
    }
}
