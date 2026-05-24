// SPDX-License-Identifier: AGPL-3.0-only
//! Shared `SQLx` pool and DB queries.
//!
//! COMPILE-TIME SQL TYPE CHECKING (v0.0.11+).
//!
//! All queries below use `sqlx::query!()` / `sqlx::query_as!()`,
//! which inspect the live schema during `cargo sqlx prepare` and
//! embed the result in `core/.sqlx/*.json`. The build then uses
//! `SQLX_OFFLINE=true` to validate every query against that
//! frozen metadata at `cargo check` time. Schema regressions
//! (column dropped, retyped, renamed) fail the build, never
//! production. See `docs/sqlx-offline.md` and the
//! `make sqlx-prepare` target.
//!
//! Type-mapping notes for the retained `MariaDB` core tables:
//!   - unsigned integer IDs are cast to `i64` at the struct boundary;
//!     primary-key IDs in any plausible deployment are nowhere near
//!     2^63 so the cast is lossless.
//!   - `TINYINT(1)` values become `i8`; we compare `!= 0` for bools.
//!   - nullable timestamp columns return
//!     `Option<chrono::DateTime<chrono::Utc>>` with the chrono feature.

use crate::domain::ServerConfig;
use crate::Result;
use sqlx::mysql::{MySqlConnectOptions, MySqlPool, MySqlPoolOptions};
use std::env;
use std::str::FromStr;
use std::time::Duration;

pub async fn connect(database_url: &Option<String>) -> Result<MySqlPool> {
    // Resolve connection options. Prefer URL-style (`--database-url`
    // or `DATABASE_URL`) when present; otherwise build options from
    // the discrete `DB_*` env vars supplied by the deployment.
    //
    // The discrete-vars path was previously formatted into a
    // `mysql://user:pass@host:port/db` URL and re-parsed by sqlx,
    // which broke when DB_PASSWORD contained URL-special characters
    // (`/`, `@`, `:`, `#`, `?`). install.sh's recommended generator
    // (`openssl rand -base64 32`) produces `/` in roughly a third of
    // outputs, which made first-deploy fail with the famously
    // unhelpful `error: error with configuration: invalid port
    // number` — the URL parser misread the `/` in the password as
    // the path separator and the password's tail as the port.
    // Caught on the first real-world Debian 13 RackNerd deploy
    // (v0.0.25 hotfix). Use the typed builder so secrets bypass
    // URL escaping entirely.
    let opts = if let Some(url) = database_url
        .clone()
        .or_else(|| env::var("DATABASE_URL").ok())
    {
        MySqlConnectOptions::from_str(&url)?
    } else {
        options_from_env(|k| env::var(k).ok())
    };

    let pool = MySqlPoolOptions::new()
        .max_connections(4)
        .acquire_timeout(Duration::from_secs(5))
        .connect_with(opts)
        .await?;
    Ok(pool)
}

/// Build typed sqlx connection options from the discrete `DB_*`
/// env vars supplied by the deployment. Pure over an env-var lookup
/// closure so the v0.0.25 regression test can inject values without
/// mutating the process environment.
fn options_from_env<F>(get: F) -> MySqlConnectOptions
where
    F: Fn(&str) -> Option<String>,
{
    let host = get("DB_HOST").unwrap_or_else(|| "db".into());
    let port = get("DB_PORT")
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(3306);
    let db = get("DB_DATABASE").unwrap_or_else(|| "cooltunnel".into());
    let user = get("DB_USERNAME").unwrap_or_else(|| "cooltunnel".into());
    let pass = get("DB_PASSWORD").unwrap_or_default();
    MySqlConnectOptions::new()
        .host(&host)
        .port(port)
        .database(&db)
        .username(&user)
        .password(&pass)
}

pub async fn server_config(pool: &MySqlPool) -> Result<ServerConfig> {
    let row = sqlx::query!(
        r#"
        SELECT
            id, domain, acme_email, acme_directory,
            anti_tracking_hide_ip,
            anti_tracking_hide_via,
            anti_tracking_probe_resistance,
            anti_tracking_doh_resolver,
            http3_enabled,
            last_caddyfile_hash,
            last_rendered_at
        FROM server_configs
        WHERE id = 1
        "#,
    )
    .fetch_one(pool)
    .await?;

    Ok(ServerConfig {
        id: row.id as i64,
        domain: row.domain,
        acme_email: row.acme_email,
        acme_directory: row.acme_directory,
        hide_ip: row.anti_tracking_hide_ip != 0,
        hide_via: row.anti_tracking_hide_via != 0,
        probe_resistance: row.anti_tracking_probe_resistance != 0,
        doh_resolver: row.anti_tracking_doh_resolver,
        http3_enabled: row.http3_enabled != 0,
        last_caddyfile_hash: row.last_caddyfile_hash,
        last_rendered_at: row.last_rendered_at,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn from(pairs: &[(&str, &str)]) -> MySqlConnectOptions {
        let owned: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        options_from_env(|k| owned.get(k).cloned())
    }

    #[test]
    fn defaults_match_compose_env_block() {
        // No env vars at all → docker-compose's panel env block has
        // DB_HOST=db, DB_PORT=3306; defaults must agree so a stripped
        // .env doesn't drift the rendered config off the compose
        // network's reachable host.
        let opts = options_from_env(|_| None);
        assert_eq!(opts.get_host(), "db");
        assert_eq!(opts.get_port(), 3306);
        assert_eq!(opts.get_database(), Some("cooltunnel"));
        assert_eq!(opts.get_username(), "cooltunnel");
    }

    #[test]
    fn slash_in_password_does_not_corrupt_port_or_host() {
        // Regression test for v0.0.25 hotfix.
        //
        // BEFORE: assemble_from_parts() formatted env vars into
        //   "mysql://cooltunnel:abc/def@db:3306/cooltunnel"
        // sqlx's URL parser then read the FIRST `/` as the path
        // separator, making the authority `cooltunnel:abc` — i.e.
        // host="cooltunnel", port="abc", which url::ParseError
        // surfaced as "invalid port number". Real-world impact:
        // install.sh's `openssl rand -base64 32` produces `/` in
        // ~30% of outputs, and v0.0.24 first-deploy on Debian 13
        // crashed both `caddyfile render` and `singbox render`
        // with a famously unhelpful error message.
        //
        // AFTER: the typed builder accepts the raw password byte-
        // for-byte; no URL escaping is involved on the env-var path.
        let opts = from(&[
            ("DB_HOST", "db"),
            ("DB_PORT", "3306"),
            ("DB_DATABASE", "cooltunnel"),
            ("DB_USERNAME", "cooltunnel"),
            // Realistic openssl-base64 sample with `/`, `+`, `=`,
            // every URL-meta char that used to break the URL parser.
            ("DB_PASSWORD", "abc/def+ghi:jkl@mno#pqr=stu?vwx"),
        ]);
        assert_eq!(opts.get_host(), "db");
        assert_eq!(opts.get_port(), 3306);
        assert_eq!(opts.get_database(), Some("cooltunnel"));
        assert_eq!(opts.get_username(), "cooltunnel");
    }

    #[test]
    fn malformed_db_port_falls_back_to_3306() {
        // A stray `\r` from a Windows-edited .env or an accidental
        // alphabetic value must not blow up the renderer; fall back
        // to the documented default rather than refusing to render
        // at all (rendering with the wrong port is better than
        // halting Caddy + sing-box bring-up).
        let opts = from(&[("DB_PORT", "not-a-number"), ("DB_HOST", "db")]);
        assert_eq!(opts.get_port(), 3306);
        assert_eq!(opts.get_host(), "db");
    }

    #[test]
    fn url_path_still_works_for_explicit_database_url() {
        // When the operator explicitly sets DATABASE_URL (e.g. for
        // out-of-stack tooling) we still feed it through
        // MySqlConnectOptions::from_str. Regression guard: that
        // path must keep parsing a well-formed URL with no surprises.
        let url = "mysql://cooltunnel:hex0123@db:3306/cooltunnel";
        let opts = MySqlConnectOptions::from_str(url).unwrap();
        assert_eq!(opts.get_host(), "db");
        assert_eq!(opts.get_port(), 3306);
        assert_eq!(opts.get_database(), Some("cooltunnel"));
        assert_eq!(opts.get_username(), "cooltunnel");
    }

    // v0.4.0 — removed test `add_used_bytes_sql_carries_overflow_guard`
    // alongside the function it pinned. The v0.0.82 u64-overflow guard
    // was an invariant of the deleted clash-API metrics writer; the
    // v0.4.0 stack has no equivalent SQL-side accumulator, so there is
    // nothing to anchor.
}
