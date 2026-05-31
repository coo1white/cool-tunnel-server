// SPDX-License-Identifier: AGPL-3.0-only

export default function SetupPage() {
  return (
    <main className="auth-page">
      <section className="auth-panel">
        <p className="eyebrow">First Owner Setup</p>
        <h1>Create Owner</h1>
        <p className="muted">
          Run <code>ct admin bootstrap</code> on the VPS, load the setup page, then create the first
          owner here.
        </p>
        <form className="form" method="post" action="/setup">
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" name="email" type="email" required />
          </div>
          <div className="field">
            <label htmlFor="username">Username</label>
            <input id="username" name="username" required />
          </div>
          <div className="field">
            <label htmlFor="name">Name</label>
            <input id="name" name="name" required />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
            />
          </div>
          <button className="btn" type="submit">
            Create owner
          </button>
        </form>
      </section>
    </main>
  );
}
