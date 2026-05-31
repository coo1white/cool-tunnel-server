// SPDX-License-Identifier: AGPL-3.0-only

"use client";

export default function ErrorBoundary({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="shell">
      <main className="main">
        <header className="topbar">
          <div>
            <p className="eyebrow">Something went wrong</p>
            <h1>Unexpected error</h1>
          </div>
        </header>
        <section className="card">
          <p>
            The console hit an unexpected error while handling this request. Your session is still
            active.
          </p>
          <p className="muted">
            Retry the action, or reload the page. If it keeps happening, check the admin API logs.
          </p>
          <button className="btn" type="button" onClick={() => reset()}>
            Try again
          </button>
        </section>
      </main>
    </div>
  );
}
