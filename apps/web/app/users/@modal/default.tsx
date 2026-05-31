// SPDX-License-Identifier: AGPL-3.0-only
//
// Required by Next.js for every parallel route slot: rendered when the
// segment has no matching URL. Returning null keeps the slot inert
// until an intercepting route fills it.

export default function ModalDefault() {
  return null;
}
