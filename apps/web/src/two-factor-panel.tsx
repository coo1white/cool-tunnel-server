// SPDX-License-Identifier: AGPL-3.0-only
//
// Client-rendered TwoFactorPanel for /me. Hosts the enroll + disable
// wizards in shadcn Dialogs. The actual API calls happen in server
// actions (apps/web/src/actions.ts::*TwoFactor*) so cookies + CSRF are
// handled by the existing apiFetch / betterAuthFetch plumbing.
//
// Enroll wizard is 3 steps:
//   1. Password — confirm identity, server calls /api/auth/two-factor/enable,
//      response includes the TOTP URI + backup codes
//   2. Scan — QR rendered from the URI + backup codes shown ONCE
//      (download as .txt). User enters first 6-digit code.
//   3. Verify — server calls /api/auth/two-factor/verify-totp; on success
//      page revalidates and dialog closes
//
// Disable wizard is 1 step: enter password, server calls
// /api/auth/two-factor/disable.

"use client";

import { Loader2, Lock, ShieldCheck, ShieldOff } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import QRCode from "react-qr-code";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { disableTwoFactorAction, enableTwoFactorAction, verifyEnrollTotpAction } from "./actions";
import { Notice } from "./components";

export interface TwoFactorPanelProps {
  readonly enabled: boolean;
}

export function TwoFactorPanel({ enabled }: TwoFactorPanelProps) {
  const [showEnroll, setShowEnroll] = useState(false);
  const [showDisable, setShowDisable] = useState(false);

  return (
    <>
      {enabled ? (
        <Button variant="destructive" onClick={() => setShowDisable(true)}>
          <ShieldOff /> Disable two-factor authentication
        </Button>
      ) : (
        <Button onClick={() => setShowEnroll(true)}>
          <ShieldCheck /> Set up two-factor authentication
        </Button>
      )}
      <EnrollWizard open={showEnroll} onOpenChange={setShowEnroll} />
      <DisableWizard open={showDisable} onOpenChange={setShowDisable} />
    </>
  );
}

type EnrollStep =
  | { kind: "password" }
  | { kind: "scan"; totpURI: string; backupCodes: readonly string[] }
  | { kind: "done" };

function EnrollWizard({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [step, setStep] = useState<EnrollStep>({ kind: "password" });
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function close() {
    onOpenChange(false);
    // Reset for next open. setTimeout so the close animation can play first.
    setTimeout(() => {
      setStep({ kind: "password" });
      setPending(false);
      setErr(null);
    }, 200);
  }

  async function submitPassword(formData: FormData) {
    setPending(true);
    setErr(null);
    const res = await enableTwoFactorAction(String(formData.get("password") ?? ""));
    setPending(false);
    if (!res.ok || !res.totpURI) {
      setErr(res.message);
      return;
    }
    setStep({ kind: "scan", totpURI: res.totpURI, backupCodes: res.backupCodes ?? [] });
  }

  async function submitCode(formData: FormData) {
    setPending(true);
    setErr(null);
    const res = await verifyEnrollTotpAction(String(formData.get("code") ?? ""));
    setPending(false);
    if (!res.ok) {
      setErr(res.message);
      return;
    }
    setStep({ kind: "done" });
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Set up two-factor authentication</DialogTitle>
          <DialogDescription>
            Use any TOTP authenticator app (1Password, Google Authenticator, Authy…).
          </DialogDescription>
        </DialogHeader>

        {step.kind === "password" && (
          <form action={submitPassword} className="form">
            <Label htmlFor="enroll-password">Confirm your password</Label>
            <Input
              id="enroll-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
            {err && <Notice state={{ ok: false, message: err }} />}
            <div className="form-actions">
              <Button type="submit" disabled={pending}>
                {pending ? <Loader2 className="animate-spin" /> : <Lock />}
                Continue
              </Button>
            </div>
          </form>
        )}

        {step.kind === "scan" && (
          <form action={submitCode} className="form">
            <p className="muted">Scan this QR code with your authenticator app:</p>
            <div
              style={{
                display: "flex",
                justifyContent: "center",
                padding: "1rem",
                background: "white",
                borderRadius: 8,
              }}
            >
              <QRCode value={step.totpURI} size={180} />
            </div>
            <details>
              <summary className="muted" style={{ cursor: "pointer" }}>
                Can't scan? Show the secret manually
              </summary>
              <code
                style={{
                  display: "block",
                  marginTop: 8,
                  padding: 8,
                  background: "var(--surface-2)",
                  borderRadius: 4,
                  wordBreak: "break-all",
                  fontSize: "0.75rem",
                }}
              >
                {step.totpURI}
              </code>
            </details>
            <div>
              <strong>Backup codes:</strong>
              <p className="muted" style={{ fontSize: "0.85rem", margin: "4px 0 8px" }}>
                Save these somewhere safe. Each code works once if you lose your authenticator.
              </p>
              <pre
                style={{
                  background: "var(--surface-2)",
                  padding: 8,
                  borderRadius: 4,
                  fontSize: "0.85rem",
                  fontFamily: "ui-monospace, monospace",
                  margin: 0,
                  whiteSpace: "pre",
                }}
              >
                {step.backupCodes.join("\n")}
              </pre>
              <a
                href={`data:text/plain;charset=utf-8,${encodeURIComponent(
                  step.backupCodes.join("\n"),
                )}`}
                download="cool-tunnel-2fa-backup-codes.txt"
                className="muted"
                style={{ fontSize: "0.85rem" }}
              >
                Download as .txt
              </a>
            </div>
            <Label htmlFor="enroll-code">Enter the 6-digit code from your app to confirm</Label>
            <Input
              id="enroll-code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
              autoFocus
            />
            {err && <Notice state={{ ok: false, message: err }} />}
            <div className="form-actions">
              <Button type="submit" disabled={pending}>
                {pending ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
                Enable
              </Button>
            </div>
          </form>
        )}

        {step.kind === "done" && (
          <>
            <Notice state={{ ok: true, message: "Two-factor authentication enabled." }} />
            <div className="form-actions">
              <Button onClick={close}>Done</Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DisableWizard({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(formData: FormData) {
    setPending(true);
    setErr(null);
    const res = await disableTwoFactorAction(String(formData.get("password") ?? ""));
    setPending(false);
    if (!res.ok) {
      setErr(res.message);
      return;
    }
    onOpenChange(false);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Disable two-factor authentication</DialogTitle>
          <DialogDescription>
            Confirm with your password. Your authenticator app and backup codes will stop working.
          </DialogDescription>
        </DialogHeader>
        <form action={submit} className="form">
          <Label htmlFor="disable-password">Password</Label>
          <Input
            id="disable-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
          {err && <Notice state={{ ok: false, message: err }} />}
          <div className="form-actions">
            <Button type="submit" variant="destructive" disabled={pending}>
              {pending ? <Loader2 className="animate-spin" /> : <ShieldOff />}
              Disable
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
