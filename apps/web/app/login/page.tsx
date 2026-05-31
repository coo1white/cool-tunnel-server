// SPDX-License-Identifier: AGPL-3.0-only

export default function LoginPage() {
  return (
    <main className="auth-page">
      <section className="auth-panel">
        <p className="eyebrow">Cool Tunnel Admin</p>
        <h1>Sign In</h1>
        <form className="form" method="post" action="/login">
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" name="email" type="email" autoComplete="username" required />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </div>
          <button className="btn" type="submit">
            Sign in
          </button>
        </form>
      </section>
    </main>
  );
}
