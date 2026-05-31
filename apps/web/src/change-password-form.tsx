// SPDX-License-Identifier: AGPL-3.0-only
//
// Client-side change-password form using react-hook-form + zod +
// shadcn Form. Added in v0.8.0 (Learning #7+#9) to demonstrate the
// pattern. The server action stays unchanged (changePasswordAction);
// this just adds client-side validation feedback before submit.
//
// The Zod schema lives here (not in @cool-tunnel/shared) because it's
// purely a UX constraint — the server's authoritative validation runs
// inside the action via the existing AdminStore.changeOwnPassword path
// (better-auth's password rules).

"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { changePasswordAction } from "./actions";
import { Notice } from "./components";

const schema = z
  .object({
    currentPassword: z.string().min(1, "Required"),
    newPassword: z.string().min(12, "At least 12 characters"),
    confirmPassword: z.string(),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: "Confirmation doesn't match",
    path: ["confirmPassword"],
  });

type FormShape = z.infer<typeof schema>;

export function ChangePasswordForm() {
  const [serverErr, setServerErr] = useState<string | null>(null);
  const form = useForm<FormShape>({
    resolver: zodResolver(schema),
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  });

  async function onSubmit(values: FormShape) {
    setServerErr(null);
    // The server action ignores its `_prev` param when called directly.
    // Call via a FormData object since the action signature expects it.
    const fd = new FormData();
    fd.set("currentPassword", values.currentPassword);
    fd.set("newPassword", values.newPassword);
    fd.set("confirmPassword", values.confirmPassword);
    const res = await changePasswordAction({ ok: true, message: "" }, fd);
    if (!res.ok) setServerErr(res.message);
    // On success, changePasswordAction redirects to /dashboard so this
    // promise effectively never resolves locally; the page navigates.
  }

  const submitting = form.formState.isSubmitting;

  return (
    <Form {...form}>
      <form className="form" onSubmit={form.handleSubmit(onSubmit)}>
        <FormField
          control={form.control}
          name="currentPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Current password</FormLabel>
              <FormControl>
                <Input type="password" autoComplete="current-password" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="newPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel>New password</FormLabel>
              <FormControl>
                <Input type="password" autoComplete="new-password" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="confirmPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Confirm new password</FormLabel>
              <FormControl>
                <Input type="password" autoComplete="new-password" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        {serverErr && <Notice state={{ ok: false, message: serverErr }} />}
        <Button type="submit" disabled={submitting}>
          {submitting && <Loader2 className="animate-spin" />}
          Update password
        </Button>
      </form>
    </Form>
  );
}
