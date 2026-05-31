// SPDX-License-Identifier: AGPL-3.0-only
//
// Layout for the /users route segment. Declares a parallel route slot
// (`modal`) that the intercepting route at
// `app/users/@modal/(.)[id]/page.tsx` renders into.
//
// - children — the normal segment content (list page, /new, /[id] when
//   deep-linked, etc.)
// - modal    — the @modal parallel slot. Empty (default.tsx returns
//   null) until a soft-nav to /users/<id> intercepts into it.
//
// Both render in the same DOM tree; the modal floats on top via its
// fixed positioning inside the shadcn Dialog.
//
// See Learning:-06-routes for the full pattern walk-through.

export default function UsersLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  return (
    <>
      {children}
      {modal}
    </>
  );
}
