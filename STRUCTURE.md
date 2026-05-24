# Repository Structure

Current map of the project. Use this when you need to find the owner
of a concern without walking the whole tree.

```text
cool-tunnel-server/
├── core/
│   ├── rust-toolchain.toml          Rust 1.88 toolchain pin
│   ├── ct-protocol/                 shared wire/profile schemas
│   └── ct-server-core/              Rust control-plane binary
│       └── src/
│           ├── main.rs              CLI dispatch
│           ├── caddy/mod.rs         Caddyfile rendering
│           ├── daemon.rs            JSON-over-unix-socket daemon
│           ├── db.rs                SQLx data access
│           ├── domain/              DB domain models
│           ├── frame.rs             daemon framing
│           ├── observability.rs     log/redaction helpers
│           ├── template.rs          small template renderer
│           └── util/                shared Rust utilities
├── singbox-core/                    Bun/TypeScript sing-box manager
│   ├── singbox.upstream.json        pinned upstream sing-box release
│   ├── src/config/                  server/client config rendering
│   └── src/subcommands/             install, render, supervise, version
├── operator/                        Bun operator CLI behind ./ct
│   ├── src/admin/                   Hono/Better Auth admin panel
│   ├── src/tasks/                   install, update, doctor, backup, restore
│   ├── src/util/                    compose/env/preflight helpers
│   └── tests/                       Bun unit tests
├── docker/
│   ├── caddy/Dockerfile             Caddy with caddy-l4 SNI routing
│   ├── core/Dockerfile              Rust core build image
│   ├── panel/                       Bun/Hono admin + Rust daemon runtime
│   └── singbox/Dockerfile           sing-box runtime + supervisor
├── caddy/Caddyfile.tpl              public SNI splitter + panel proxy
├── manifests/                       component/version manifests
├── scripts/                         shell helpers and host checks
├── docs/                            operator and design documentation
├── docker-compose.yml               caddy, singbox, panel, db, redis
├── Makefile                         local health and release gates
├── README.md                        product overview and doc map
├── GETTING_STARTED.md               shortest install walkthrough
└── STRUCTURE.md                     this file
```

## Runtime Shape

```text
client
  |
  | :443
  v
caddy
  |-- SNI = PANEL_DOMAIN --> panel HTTPS terminator --> panel:9000
  |
  `-- other SNI ---------> singbox:443

panel  <-->  SQLite admin DB (/data/admin/admin.sqlite)
panel  <-->  db
panel  <-->  redis
panel  -->   ct-server-core daemon / CLI
panel  -->   singbox-core render-server
singbox -->  /data/config/singbox.json rendered by panel
```

The main boundaries are deliberately simple:

- Caddy owns public `:80` and `:443`, ACME for the panel domain, and
  layer-4 SNI routing.
- `singbox` owns the user proxy path. Its config is rendered by
  `singbox-core` and watched by `singbox-core supervise`.
- `panel` owns Better Auth accounts, setup, settings, and operator UI.
- `ct-server-core` owns Rust-side control-plane helpers and the daemon
  wire protocol used by the panel.
- `operator` owns host-level workflows exposed through `./ct`.
