# House Fight

A finished, local-first party battler for 2–4 active players plus spectators. Phones hold private drafts and commands; a laptop or TV can run the shared arena. All rules resolve on the host with seeded, replayable randomness.

## Play locally

Requirements: Node 24+ and pnpm 11+.

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://localhost:4242`. Other players on the same network use the LAN URL printed by the server. Open `/arena` on the shared display and `/admin` on the host machine.

The first player is host. Use **Add a chaos bot** to run a complete 1v1 from one browser. FFA requires 3–4 fighters; teams requires 4.

Before the first real party, follow the full phone, Arena, portrait, reconnect, crash, and restore drill in [PLAYTEST.md](./PLAYTEST.md).

## Game rules

- Every active player privately draws three unique fighters.
- The private fighter draw lasts 30 seconds; each resolved round remains on screen for a 12-second review. Every human can press **Ready for next round** to skip the remainder unanimously; bots do not count.
- Planning is simultaneous and hidden. In 2v2, teammates alone can see each other’s intent.
- Protection and fast actions resolve before standard and slow actions.
- Anyone alive when planning closes still acts, so double KOs are possible.
- A slow heal can rescue a fighter reduced to zero earlier in the same simultaneous resolution; KOs are finalized after all locked actions.
- “Friendly / self” abilities may target their owner. At round start, healing-over-time resolves before damage-over-time.
- In FFA, two direct attackers deal 85% each; three deal 70% each. Team focus damage is unchanged.
- Signatures unlock on round 3 and are once per match.
- Balanced mode uses Standard cards only. Party mode gives each Boss one-fifth the draw weight of a Standard card and has a 10% chance of one Cursed Hijack per match.
- The music tab contains eight original, runtime-synthesized chiptunes with 35–55 second arrangements, layered harmony, arpeggios, bass, and percussion. Playback is opt-in, volume and track are remembered locally, and no third-party recording or melody is bundled.
- Every match stores its seed and can be reproduced by the pure engine.

## Commands

```bash
pnpm test
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm run simulate
pnpm audit
pnpm run audit:high
```

The full simulator covers every Standard lineup in duel, FFA, and 2v2, rotates seats, and compares random/varied/tactical public-state policies. The Admin card workshop also evaluates the current edited card—even before saving—against every Standard opponent in both duel seats, with draws counted as half-equity. These reports are deliberately human-playtest prompts rather than automatic balance verdicts; see [PLAYTEST.md](./PLAYTEST.md).

## Private data

No account, cloud service, tracker, or service worker is used. The server stores card JSON, replay data, room recovery checkpoints, and private media in one external directory. Host runs default to persistent application data (`~/Library/Application Support/House Fight` on macOS, the XDG data directory on Linux, and Local App Data on Windows). For an explicit location:

```bash
GAME_DATA_DIR=/absolute/path/outside/the/repository pnpm dev
```

Admin APIs are accepted only from loopback by default. To administer from another LAN device, configure a long `ADMIN_KEY`; the browser keeps it in session storage only. Application responses disable caching for API/private data.

The host-only `/admin` vault has **EXPORT BACKUP** and **IMPORT…** controls. Its portable `.housefight` file includes cards, normalized portraits, enable/disable state, and deterministic match history; every file and the complete payload are SHA-256 checked before import. **MERGE** keeps unrelated local records, while **REPLACE** swaps the vault only after creating an automatic recovery snapshot. The **Enabled in drafts** switch keeps a card safely in the vault and backups while removing it from future draws. Keep at least 12 enabled Standard cards so four-player Balanced drafts remain possible. Card text is stored as UTF-8 and normalized safely, so French accents, Lebanese Latin text, and Arabic text survive save/export/import unchanged.

Create a consistent, checksummed SQLite-and-media backup while the server is running, then verify it independently:

```bash
GAME_DATA_DIR=/absolute/private/path GAME_BACKUP_DIR=/another/private/path pnpm backup
GAME_DATA_DIR=/absolute/private/path GAME_BACKUP_DIR=/another/private/path pnpm backup:verify
```

`backup:verify` checks the newest completed backup by default. You can pass a specific backup directory after `--`. Restore is deliberately offline and creates a fresh pre-restore recovery backup before changing live data:

```bash
# Stop the game server first.
GAME_DATA_DIR=/absolute/private/path GAME_BACKUP_DIR=/another/private/path \
  pnpm restore -- --yes /another/private/path/<backup-directory>
```

Backups are built under a hidden partial name and become visible only after their manifest, SHA-256 checksums, media, and SQLite integrity check all pass. Database schema migrations are transactional; the app refuses to open a database created by a newer incompatible version.

## Docker

Copy `.env.example` to `.env`. Set `PUBLIC_BASE_URL` to the address phones can open—for example `http://192.168.1.25:4242`—because a container cannot discover the host Mac/PC LAN address reliably. `ADMIN_KEY` is optional unless `/admin` must be used from another device. Then:

```bash
docker compose up --build
```

If your installation provides the standalone command, use `docker-compose` in place of `docker compose`. The lobby deliberately refuses to copy a localhost/container-only invite when no shareable address is configured.

The container runs as the unprivileged `node` user, drops Linux capabilities, uses a read-only root filesystem, and writes only to `/data`, `/backups`, plus a small no-exec temp filesystem. Compose stores them in the Docker-managed `house-fight-private-data` and `house-fight-private-backups` volumes, outside the repository; this avoids host/VM UID translation failures that commonly break SQLite bind mounts on macOS and Linux VM runtimes.

Create and verify a live Docker backup using the production image:

```bash
docker compose --profile tools run --rm house-fight-tools
docker compose --profile tools run --rm house-fight-tools \
  node dist-server/scripts/verify-backup.js
```

For a restore, first list the completed backups, stop the server, restore, and start it again:

```bash
docker compose --profile tools run --rm house-fight-tools ls -1 /backups
docker compose stop house-fight
docker compose --profile tools run --rm house-fight-tools \
  node dist-server/scripts/restore.js --yes /backups/<backup-directory>
docker compose up -d house-fight
```

Never run the restore command while the game service is running. Inspect volume locations with `docker volume inspect house-fight-private-data` and `docker volume inspect house-fight-private-backups`. Treat both as private. Direct host runs can still point `GAME_DATA_DIR` and `GAME_BACKUP_DIR` at absolute private directories.

## Architecture

```text
React DOM UI  ──WebSocket──>  LAN room server  ──>  SQLite
      │                              │
      └──── reads snapshots ─────────┴──> pure TypeScript engine
```

- `engine/`: deterministic RNG, draft, ability DSL, statuses, resolution, bots, balance simulation.
- `server/`: authoritative room, private view filtering, timers, reconnect tokens, local persistence.
- `src/`: phone UI, shared arena, and local admin workshop.
- `fixtures/fake-card-pack/`: fictional data and code-native portraits; safe to keep in source control.

The engine has no React, WebSocket, filesystem, or database imports. Ability behavior is structured data—never user-supplied JavaScript.

## Contributing and license

Contributions are welcome through forks and pull requests; see [CONTRIBUTING.md](./CONTRIBUTING.md).
The source code and bundled original scores are available under the [MIT license](./LICENSE).
Private custom cards, portraits, game vaults, and backups are not included in this repository.
Host the game on a trusted private network; Internet hosting requires additional access controls.
