// SPDX-License-Identifier: AGPL-3.0-only
// ct-protocol — shared types every Cool Tunnel client / server agrees on.
//
// Conventions:
// - Every public wire type is suffixed `V1`. A `V2` lives side by
//   side; we never break `V1` shape silently.
// - Pure Rust, `no_std`-compatible (with `alloc`). No I/O, no async,
//   no platform-specific deps. Anything that needs syscalls belongs
//   in the *platform's* core crate, not here.
// - Constructor-validated value types. Once you hold a `ProfileV1`,
//   the rules have already been checked.

#![cfg_attr(not(feature = "std"), no_std)]
#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

extern crate alloc;

pub mod components;
pub mod profile;
pub mod subscription;
pub mod wire;

pub use components::{
    ComponentKindV1, ComponentManifestV1, ComponentStateV1, ComponentStatusV1, VerifySpecV1,
};
pub use profile::{ProfileParseError, ProfileV1};
pub use subscription::{AntiTrackingFeature, ServerCapabilitiesV1, SubscriptionManifestV1};
pub use wire::{WireEventV1, WireRequestV1, WireResponseV1};

/// Wire-format major version. Bumping this is a breaking change.
pub const PROTOCOL_VERSION: u32 = 1;
