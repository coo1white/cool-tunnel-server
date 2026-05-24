# LTSC-Heng License Draft

> **Status:** Draft only. The active license for this repository is
> `AGPL-3.0-only` unless and until the steward replaces `LICENSE` and
> publishes a release under different terms.
>
> This draft is written for legal review. It is intentionally strict,
> but it should not be treated as legal advice or as an adopted license.

## Preamble

LTSC-Heng is a restrictive source-available covenant for deterministic
infrastructure software. Its purpose is to preserve technical
sovereignty, source constancy, and the zero user-tracking posture while
blocking commercial resale without explicit authorization.

## 1. Definitions

**Software** means Cool Tunnel Server, Cool Tunnel Panel, associated
deployment scripts, templates, manifests, documentation, and derived
source or object forms.

**Steward** means coolwhite LLC or a successor explicitly named by the
repository maintainers.

**Sovereign Endorsement** means prior written permission from the
Steward granting a named party the right to commercially resell,
repackage, white-label, or host the Software as a managed service.

**Modification** means any change to source, object code, deployment
scripts, templates, manifests, documentation, or runtime defaults.

**Milestone Markers** means versioned LTSC, Heng, audit-cycle, and
2026 posture references preserved in source comments, documentation,
release notes, and operator-facing files.

**User Data Collection** means collection, storage, export, sale,
correlation, or metric labeling of usernames, account identifiers,
subscription tokens, device identifiers, target hosts, request IDs,
destination addresses, browsing activity, or equivalent user-identifying
or user-behavioral data.

**Internal Health Metrics** means operator-visible service health data
that does not identify a specific user, account, device, token, request,
or destination. Examples include process restart counts, memory pressure,
DB pool pressure, semaphore saturation, config reload counts, queue
depth, binary version drift, and component health status.

## 2. Permission

Subject to the restrictions below, you may use, study, run, modify,
copy, and redistribute the Software.

## 3. Commercial Resale Restriction

You may not sell, rent, lease, white-label, sublicense for commercial
hosting, package into a paid appliance, or offer the Software as a
managed commercial service without Sovereign Endorsement.

Charging for your own infrastructure, internal operations, private
consulting, incident response, or deployment labor is permitted only
when the Software itself is not resold, relicensed, hidden, or
presented as proprietary.

Sovereign Endorsement must be explicit, written, and scoped to a named
party, named product or service, named territory when applicable, and a
defined term. Silence, public availability of the repository, prior
commercial use, or acceptance of patches does not imply endorsement.

## 4. Covenant of Constancy

All Modifications that are conveyed, distributed, or operated for
network users must remain source-available under terms no less open
than AGPL-3.0-only.

If you operate a modified version over a network, every user with
access to that service must be offered the complete corresponding
source for the modified version, including build scripts, deployment
templates, manifests, and local patches.

You must retain Milestone Markers unless the referenced behavior has
been removed and the removal is documented in an adjacent changelog or
release note. Removal of a marker without replacement is a license
violation under this draft.

The corresponding source must include build scripts, Dockerfiles,
Compose files, Caddy/sing-box templates, manifests, migrations,
Rust crates, Bun/TypeScript admin and operator code, shell scripts,
and local deployment patches necessary to reproduce the modified
service.

Minified, obfuscated, vendored, or generated artifacts do not satisfy
this covenant unless the preferred source form and reproducible build
path are provided alongside them.

## 5. Zero User Tracking Boundary

You may not add undisclosed user tracking, per-destination analytics,
device identifiers, subscription-token logging, or equivalent user
data collection to the Software while representing it as Cool Tunnel
Server or as a Steward-endorsed derivative.

Operator-internal health metrics are permitted when they do not expose
usernames, account identifiers, target hosts, subscription tokens,
request identifiers, or equivalent user-identifying labels.

Internal Health Metrics are allowed. User Data Collection is forbidden.
The distinction is load-bearing: metrics that can identify a user,
session, token, destination, or browsing behavior are not health metrics
under this draft.

## 6. Attribution and Notices

Redistributions must preserve:

- Copyright notices.
- License notices.
- SPDX headers.
- AGPL-3.0 source-availability notices, when applicable.
- LTSC, Heng, audit-cycle, and 2026 milestone markers.
- Third-party notices for bundled or referenced upstream components.

## 7. No Warranty

The Software is provided **AS IS**, without warranty of any kind,
express or implied, including but not limited to warranties of
merchantability, fitness for a particular purpose, non-infringement,
availability, performance, or legal suitability in any jurisdiction.

No oral or written statement, documentation, issue comment, release
note, benchmark, deployment example, or support response creates a
warranty.

## 8. Limitation of Liability

To the maximum extent permitted by law, the Steward, contributors,
copyright holders, and distributors are not liable for any claim,
damage, loss, interruption, enforcement action, legal consequence,
data loss, service outage, or third-party harm arising from the
Software or from any deployment, modification, redistribution, or use
of the Software.

This limitation includes direct, indirect, incidental, special,
exemplary, punitive, and consequential damages, including lost profits,
lost revenue, business interruption, reputational harm, provider
suspension, network blocks, data loss, or legal/regulatory action.

## 9. Termination

Rights under this draft terminate automatically if you violate the
commercial resale restriction, remove required notices, conceal
modified source from network users, or add prohibited user tracking
while representing the derivative as Cool Tunnel Server or as
Steward-endorsed.

Rights may be reinstated only after the violation is cured and the
Steward receives written notice of the cure.

## 10. Severability

If any provision of this draft is held unenforceable, the remaining
provisions remain in effect to the maximum extent permitted by law.

## 11. Conflict With Active License

This draft does not override the repository's active `LICENSE` file.
For releases currently licensed under AGPL-3.0-only, AGPL-3.0-only is
the operative license text.
