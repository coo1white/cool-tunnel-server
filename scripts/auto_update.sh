#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Cron entry-point. Symlinked into /etc/cron.daily/ct-auto-update by
# `ct auto-update enable`. Dispatches to the canonical operator binary.
exec "$(dirname "$0")/../ct" auto-update now --quiet
