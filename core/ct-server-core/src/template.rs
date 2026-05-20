// SPDX-License-Identifier: AGPL-3.0-only
//! Tiny Go-template-style renderer.
//!
//! We render project templates from a small set of named values.
//! Rather than pull in a full template engine (`tera`,
//! `handlebars`, `gtmpl`), this module hand-rolls the subset we
//! actually need: bare `{{ .FieldName }}` substitution.
//!
//! Why Go-template syntax? sing-box is written in Go and its own
//! examples use `{{ .Field }}` shapes. Operators copy-pasting our
//! template into a sing-box config file (or vice versa) won't have
//! to mentally re-parse. New contributors who already know Go
//! templates from Helm / Hugo / Grafana provisioning recognise it
//! instantly.
//!
//! What this supports:
//!
//! - `{{ .FieldName }}` — replace with the value bound to `FieldName`.
//! - Whitespace inside the braces is allowed and ignored:
//!   `{{.X}}`, `{{ .X }}`, `{{  .X  }}` all behave identically.
//!
//! What this does NOT support (deliberately — keep it tiny):
//!
//! - `{{ range }} ... {{ end }}` loops. Build the JSON on the Rust
//!   side and bind it as a single field.
//! - `{{ if }} ... {{ else }} ... {{ end }}` conditionals. Same
//!   pattern: render conditional fragments on the Rust side.
//! - Pipelines (`{{ .X | upper }}`).
//! - Functions or methods.
//!
//! If you find yourself wanting any of those, the right move is to
//! bind the result of that logic as a single field — keeping the
//! template a simple substitution table makes both reading and
//! debugging much easier.

use std::collections::HashMap;
use std::fmt;

/// Errors a template render can raise. Each carries enough context
/// to point an operator at the file and column where things went
/// wrong, without dumping the whole template.
#[derive(Debug)]
pub enum RenderError {
    /// Found `{{` without a matching `}}`. Operators usually hit this
    /// when they edit the template by hand and miss a close.
    UnterminatedTag { offset: usize },
    /// Tag body wasn't of the form `.FieldName`. Probably a typo or
    /// an attempt to use unsupported syntax (`range`, `if`, etc.).
    BadTag { offset: usize, body: String },
    /// Tag references a field name we weren't given a value for.
    /// Most often a typo in either the template or the rendering
    /// site; we surface the field name verbatim.
    MissingField { name: String },
}

impl fmt::Display for RenderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnterminatedTag { offset } => write!(
                f,
                "unterminated `{{{{` at byte offset {offset} — probably a missing `}}}}` somewhere after this point",
            ),
            Self::BadTag { offset, body } => write!(
                f,
                "unsupported template tag at byte offset {offset}: `{{{{ {body} }}}}` — \
                 only `{{{{ .FieldName }}}}` is supported here",
            ),
            Self::MissingField { name } => write!(
                f,
                "template references `{{{{ .{name} }}}}` but no value was bound for `{name}` — \
                 add a binding in the renderer or fix the template",
            ),
        }
    }
}
impl std::error::Error for RenderError {}

/// Render `template` against `bindings` and return the result.
///
/// `bindings` is a flat name → value map. Use [`Bindings`] for an
/// ergonomic builder if you have many keys.
pub fn render(template: &str, bindings: &HashMap<String, String>) -> Result<String, RenderError> {
    let mut out = String::with_capacity(template.len() + 64);
    let bytes = template.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        // Look for the next `{{`.
        if let Some(open) = find_two(bytes, i, b'{', b'{') {
            // Copy literal text before the tag verbatim.
            out.push_str(&template[i..open]);

            // Find the matching `}}`.
            let close = find_two(bytes, open + 2, b'}', b'}')
                .ok_or(RenderError::UnterminatedTag { offset: open })?;

            // The body is what's between the braces, trimmed.
            let body = template[open + 2..close].trim();

            // We support exactly one form: `.FieldName`.
            let field = body
                .strip_prefix('.')
                .filter(|name| !name.is_empty() && name.chars().all(is_field_char))
                .ok_or_else(|| RenderError::BadTag {
                    offset: open,
                    body: body.to_owned(),
                })?;

            let value = bindings
                .get(field)
                .ok_or_else(|| RenderError::MissingField {
                    name: field.to_owned(),
                })?;
            out.push_str(value);

            i = close + 2;
        } else {
            // No more tags — copy the rest and we're done.
            out.push_str(&template[i..]);
            break;
        }
    }

    Ok(out)
}

/// A small builder for name → string bindings. Consider this the
/// "context" you pass to [`render`].
///
/// ```
/// # use ct_server_core::template::Bindings;
/// let b = Bindings::new()
///     .set("Domain", "proxy.example.com")
///     .set("AcmeEmail", "admin@example.com");
/// assert_eq!(b.get("Domain").as_deref(), Some("proxy.example.com"));
/// ```
#[derive(Debug, Default, Clone)]
pub struct Bindings {
    inner: HashMap<String, String>,
}

impl Bindings {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn set(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.inner.insert(name.into(), value.into());
        self
    }

    #[must_use]
    pub fn into_map(self) -> HashMap<String, String> {
        self.inner
    }

    /// Look up a binding by name. Exposed for tests and for callers
    /// inspecting a partially-built `Bindings` before render.
    #[must_use]
    #[allow(dead_code)]
    pub fn get(&self, name: &str) -> Option<&String> {
        self.inner.get(name)
    }
}

/// Validate that `value` is safe to interpolate verbatim into a
/// **Caddyfile** directive. Returns `Err(_)` if the value contains a
/// character that would let an operator-controlled binding break out
/// of its directive context: newlines (`\n`/`\r`) terminate a
/// directive, `{`/`}` open or close a site block, `"` opens a quoted
/// string. A hostile DOMAIN like
///
///   `example.com\n}\nadmin localhost:2019\n{`
///
/// would otherwise inject a fully-functional Caddy admin endpoint
/// onto the public surface.
///
/// We REFUSE TO RENDER rather than try to escape. Caddy's grammar has
/// no general escape mechanism for these inside an unquoted directive
/// argument, so any "smart" escape we tried would either change the
/// argument's meaning (breaking the legitimate use case) or pass-
/// through (defeating the check). Caddyfile has no general escape
/// mechanism for these characters in unquoted directive arguments —
/// the only correct response to a metasyntactic value is to fail
/// loudly with a clear error so the operator sees it before the bad
/// config reaches Caddy.
///
/// Used by `caddy::render` at the binding site.
/// (v0.0.16 hardening — closes the Caddyfile-injection class
/// surfaced in the loop-2 self-check.)
///
/// # Errors
/// Returns a description of the offending field and the first
/// metasyntactic character encountered.
pub fn caddyfile_validate(field: &str, value: &str) -> Result<(), String> {
    for c in value.chars() {
        match c {
            '\n' | '\r' | '{' | '}' | '"' => {
                return Err(format!(
                    "binding `{field}` contains Caddyfile-metasyntax \
                     character `{}` (codepoint U+{:04X}); refusing to \
                     render an injectable Caddyfile",
                    c.escape_debug(),
                    c as u32,
                ));
            }
            _ => {}
        }
    }
    Ok(())
}

fn find_two(bytes: &[u8], from: usize, a: u8, b: u8) -> Option<usize> {
    let mut i = from;
    while i + 1 < bytes.len() {
        if bytes[i] == a && bytes[i + 1] == b {
            return Some(i);
        }
        i += 1;
    }
    None
}

fn is_field_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    fn b(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    #[test]
    fn substitutes_a_single_field() {
        let out = render("hello {{ .Name }}", &b(&[("Name", "world")])).unwrap();
        assert_eq!(out, "hello world");
    }

    #[test]
    fn whitespace_inside_braces_is_ignored() {
        let bindings = b(&[("X", "1")]);
        assert_eq!(render("{{.X}}", &bindings).unwrap(), "1");
        assert_eq!(render("{{ .X }}", &bindings).unwrap(), "1");
        assert_eq!(render("{{   .X   }}", &bindings).unwrap(), "1");
    }

    #[test]
    fn substitutes_multiple_fields() {
        let out = render(
            "{{ .A }} + {{ .B }} = {{ .C }}",
            &b(&[("A", "1"), ("B", "2"), ("C", "3")]),
        )
        .unwrap();
        assert_eq!(out, "1 + 2 = 3");
    }

    #[test]
    fn missing_field_is_a_helpful_error() {
        let err = render("{{ .Domain }}", &b(&[])).unwrap_err();
        let msg = format!("{err}");
        assert!(
            msg.contains(".Domain"),
            "should name the missing field: {msg}"
        );
        assert!(
            msg.contains("renderer") || msg.contains("template"),
            "{msg}"
        );
    }

    #[test]
    fn unterminated_tag_is_a_helpful_error() {
        let err = render("hello {{ .Name without close", &b(&[])).unwrap_err();
        let msg = format!("{err}");
        assert!(msg.contains("unterminated"), "{msg}");
    }

    #[test]
    fn bad_tag_form_is_a_helpful_error() {
        // No leading dot — we don't support free identifiers.
        let err = render("{{ Domain }}", &b(&[])).unwrap_err();
        let msg = format!("{err}");
        assert!(
            msg.contains(".FieldName"),
            "should explain the supported form: {msg}"
        );
    }

    #[test]
    fn literal_text_around_tags_is_preserved() {
        let out = render("{prefix} {{ .X }} {suffix}", &b(&[("X", "MID")])).unwrap();
        assert_eq!(out, "{prefix} MID {suffix}");
    }

    #[test]
    fn empty_template_is_empty_output() {
        assert_eq!(render("", &b(&[])).unwrap(), "");
    }

    #[test]
    fn template_with_no_tags_passes_through_verbatim() {
        let body = "no tags here {single brace}";
        assert_eq!(render(body, &b(&[])).unwrap(), body);
    }

    #[test]
    fn bindings_builder_round_trip() {
        let m = Bindings::new().set("A", "1").set("B", "2").into_map();
        assert_eq!(m.get("A").map(String::as_str), Some("1"));
        assert_eq!(m.get("B").map(String::as_str), Some("2"));
    }

    // --- caddyfile_validate (v0.0.16 fix, tested in v0.0.18) ---
    //
    // The Caddyfile-injection guard. Each metasyntactic char must
    // independently produce an Err. A regression that drops the
    // check (or mis-spells one of the chars) re-opens the
    // injection vector.

    #[test]
    fn caddyfile_validate_accepts_clean_values() {
        // Exact charset that ServerConfig fields are expected to
        // hold today: domain (a-z 0-9 . -), email (+ @), URL
        // (+ : / ? & =).
        for v in [
            "proxy.example.com",
            "admin@example.com",
            "https://acme-v02.api.letsencrypt.org/directory",
            "ABC.123-xyz_subdomain.example.co.uk",
        ] {
            assert!(
                caddyfile_validate("Domain", v).is_ok(),
                "expected `{v}` to validate, got err",
            );
        }
    }

    #[test]
    fn caddyfile_validate_rejects_each_metasyntax_char() {
        // Each rejected character independently — a future
        // regression that drops one from the match arm must fail
        // its corresponding case here.
        for (label, c) in [
            ("newline", '\n'),
            ("carriage-return", '\r'),
            ("open-brace", '{'),
            ("close-brace", '}'),
            ("double-quote", '"'),
        ] {
            let v = format!("safe-prefix{c}safe-suffix");
            let err = caddyfile_validate("Domain", &v).unwrap_err();
            assert!(
                err.contains("Domain") && err.contains("metasyntax"),
                "{label}: error message should name field + 'metasyntax': {err}",
            );
        }
    }

    #[test]
    fn caddyfile_validate_rejects_realistic_injection_payload() {
        // The exact injection shape the v0.0.16 fix was written
        // against — break out of the {{ .Domain }}:8443 { … } block
        // and inject a Caddy admin endpoint.
        let payload = "example.com\n}\nadmin localhost:2019\n{";
        let err = caddyfile_validate("Domain", payload).unwrap_err();
        // First metasyntactic char hit is `\n`.
        assert!(err.contains("metasyntax"), "{err}");
    }

    #[test]
    fn caddyfile_validate_field_name_propagates_into_error() {
        let err = caddyfile_validate("AcmeEmail", "bad}value").unwrap_err();
        assert!(err.contains("AcmeEmail"), "{err}");
    }
}
