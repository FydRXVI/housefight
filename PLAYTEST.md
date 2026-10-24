# House Fight release playtest

Use this checklist before inviting a full group. Automated tests protect the rules and recovery format; this session checks the real phones, Wi-Fi, readability, timing, and social balance that bots cannot judge.

## 1. Preflight on the host

Run the release gates from a clean terminal:

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm simulate
pnpm audit --audit-level high
```

Start with explicit private locations so a restart uses the same data:

```bash
GAME_DATA_DIR=/absolute/private/house-fight-data \
GAME_BACKUP_DIR=/absolute/private/house-fight-backups \
pnpm dev
```

Acceptance: every command succeeds, the server prints a reachable LAN join URL, `/api/health` returns `ok: true`, and the browser/server consoles stay free of errors throughout the session.

## 2. Card vault and portraits

In `/admin`, create a new card, duplicate it, edit every effect type, save it, reload the page, and delete the duplicate. Confirm the original remains intact.

Create enough replacement Standard cards to keep 12 enabled, disable one built-in with **Enabled in drafts**, and run several drafts. Acceptance: the disabled card remains editable and present after reload/export/import, is marked `OFF` in the roster, and never enters any draw. Re-enable it and confirm it can appear again.

Test all of these strings in names, titles, quotes, and abilities:

- `Kol khara ya shrīk — mais avec élégance, s’il te plaît.`
- `Élodie d’Après` and `Ça va, habibi?`
- `كل خرا يا شريك` and mixed `FAYAD — كل خرا 2.0`
- Emoji and a 60-character unbroken name

Acceptance: text round-trips exactly, mixed Arabic/Latin chooses a sensible direction, no card/editor widens the page, and the game logic still refers to the card by its slug rather than its display text.

Upload a square JPEG, tall portrait, wide landscape, transparent PNG, WebP, AVIF, phone JPEG with EXIF rotation, and a file near 12 MB. Move both focus sliders. Also try an SVG renamed to `.png`, a corrupt file, an animated image, an iPhone HEIC, and a file over 12 MB. HEIC must be exported as JPEG/PNG first; the shipped cross-platform image library does not decode patent-encumbered HEIC consistently.

Acceptance: valid photos are oriented, cropped, resized, and sharp; metadata is stripped; invalid files produce a useful error; a missing or failed image falls back to the generated portrait; no private media URL is listed or cached.

## 3. Device matrix

Use one host computer, four real phones on the same Wi-Fi, and one laptop/TV on `/arena`. Include at least one iPhone/Safari and one Android/Chrome if available. Check portrait and landscape, a 320 px-wide viewport, reduced-motion mode, and a slow or briefly disconnected network.

Acceptance: the invite URL opens from another device, the first lobby view starts at the top, all tap targets are usable, safe areas are respected, no text overlaps, and Arena never reveals a hand, selected fighter, curse, or private command.

## 4. Match matrix

Complete each row, including rematch:

| Match | Players | What to verify |
|---|---:|---|
| Duel | 2 | Simultaneous lock, priority order, cooldowns, round-3 signature, double KO |
| FFA | 3 | Two-person `MOBBED` reduction and explanation, random-enemy targeting, spectator join |
| FFA | 4 | Three-person `MOBBED` reduction, every action appears in the cinematic/log, late reconnect |
| Teams | 4 | Exactly 2 Acid / 2 Coral, host team switching, teammate-only intent, full focus damage |
| Party | 2–4 | Boss and Cursed draft behavior, hijack clarity, unusual outcomes remain recoverable |

Exercise at least one dodge, reflect, taunt, disable, damage-over-time, heal-over-time, cleanse, stolen status, vulnerability, multi-hit, self-damage, late heal after apparent lethal, and round-12 decision.

Acceptance: each living locked fighter acts once; KOs are announced once; immediate defence lasts only its advertised round; taunt/disable affect the next planning round; two-tick effects tick exactly twice; opponents and Arena never see team intent.

Pacing acceptance: the private draw starts at 30 seconds, the resolution review starts at 12 seconds, the review countdown stays visible, and the next planning round opens with no stale move or target selected. With two humans, one **Ready for next round** press must wait and the second must advance immediately; repeat with one human plus bots and confirm one human press advances.

Open the music tab on iPhone Safari, Android Chrome, and the Arena display. Play, stop, change all three original tracks, and change volume. Lock the phone and return. Acceptance: playback starts only after a tap, the controls do not cover combat or the resolution-ready row, the resolution automatically collapses the drawer without stopping music, and no console/audio errors appear.

## 5. Reconnect and crash recovery

During both draft and planning:

1. Select an option, turn off that phone's Wi-Fi, and tap again.
2. Confirm a blocking reconnect screen prevents a fake submission.
3. Reconnect and confirm the authoritative selection/deadline returns.
4. Open a second tab with the same player token, close one tab, and confirm the other stays connected.
5. Disconnect every human while bots remain; confirm the timed phase pauses instead of finishing unattended.
6. Stop the server mid-planning, restart it with the same `GAME_DATA_DIR`, reconnect a non-host first, and resume as the elected human host.

Acceptance: no human seat is assigned to a bot, unknown/reused tokens cannot impersonate a player, a disconnected stale seat can be removed by the host, and the recovered match continues from the saved phase with no duplicated action.

## 6. Export, import, backup, and restore drill

From `/admin`, export a `.housefight` file containing the cards, portraits, and history. Import it in merge mode. Then start a second server with an empty `GAME_DATA_DIR` and import it in replace mode.

Acceptance: card text, effect structure, portrait crop, media bytes, match history, and deterministic replay survive. A modified byte or checksum is rejected before mutation, and replace import creates an automatic pre-import recovery backup.

Also run a server-side backup, verification, and offline restore as documented in `README.md`. Restart after restore and finish a recovered match. Keep at least one copy outside the host computer.

## 7. Human balance notes

`pnpm simulate` reports duel, 3-player FFA, 4-player FFA, and 2v2 outcomes across every legal Standard-card lineup/team partition with deterministic seat rotations. It compares random, varied, and tactical public-information policies, gives draws their fair equity, and marks policy-sensitive results separately from persistent card signals. A normal run is reproducible; use `SIM_SEED=123 pnpm simulate` for another deterministic sample or `SIM_MIN_GAMES=1000 pnpm simulate` for a deeper one. Treat `WATCH`/`REVIEW` as a playtest queue, not proof: bots do not understand grudges, table talk, threat perception, bluffing, or coordinated hidden choices.

For every human match, record just four things: mode, fighters, winner, and one sentence about anything that felt unfair or unclear. Review after at least five games per mode. Tune a Standard card only when repeated human evidence agrees with the simulator; Boss and Cursed cards are intentionally unfair.

## Ship decision

Ship to friends and family when all automated gates pass, the full device/match matrix completes without privacy or recovery failures, an export can restore into an empty directory, and the group agrees the remaining imbalance is funny rather than frustrating.
