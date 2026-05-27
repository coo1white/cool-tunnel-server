// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { useActionState } from "react";
import { Notice } from "./components";
import type { ActionState } from "./api";

const INITIAL: ActionState = { ok: true, message: "" };

/**
 * Wraps a form in useActionState so server-side validation errors returned by
 * the action surface inline via <Notice> instead of bubbling to a 500. The
 * form fields are passed as children and stay server-rendered.
 */
export function ActionForm({ action, className, children }: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  className?: string;
  children: React.ReactNode;
}) {
  const [state, formAction] = useActionState(action, INITIAL);
  return (
    <form className={className} action={formAction}>
      {children}
      <Notice state={state} />
    </form>
  );
}
