# Contributing

Fork this repository, create a branch, and open a pull request against `main`.
Describe the problem, the change, and how you tested it. Contributions use the
MIT license in this repository.

Use Node.js 24 or newer and the pnpm version pinned in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm run lint
pnpm run typecheck
pnpm test
pnpm run build
pnpm audit
```

Read README.md for local startup and PLAYTEST.md for multiplayer checks. Use
fictional card text and synthetic images in fixtures. Never submit `.env`
files, admin keys, private portraits, game databases, exported vaults, or
backups. Changes to combat rules should include deterministic regression tests.

House Fight is designed for a trusted private LAN. Do not expose your game or
admin interface directly to the public Internet.
