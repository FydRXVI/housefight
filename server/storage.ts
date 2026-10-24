import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import type {
  ActionChoice,
  AbilityDefinition,
  BattleState,
  CardDefinition,
  Condition,
  Effect,
  GameMode,
  Playlist,
} from '../engine/types.js';
import {
  normalizeCardDefinition,
  validateCardDefinition,
} from '../shared/card-validation.js';
import {
  PORTABLE_EXPORT_FORMAT,
  PORTABLE_EXPORT_LIMITS,
  PORTABLE_EXPORT_VERSION,
} from '../shared/portable-backup.js';
import type {
  PortableCardOrigin,
  PortableCardRecord,
  PortableExportFile,
  PortableExportPayload,
  PortableImportOptions,
  PortableImportResult,
  PortableMatchRecord,
  PortableMediaRecord,
} from '../shared/portable-backup.js';

export const CURRENT_SCHEMA_VERSION = 5;
export const BACKUP_FORMAT = 'house-fight-backup' as const;
export const BACKUP_VERSION = 1 as const;

const APP_VERSION = '1.0.0';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_MATCH_ID = /^[A-Za-z0-9-]{1,64}$/;
const SAFE_ABILITY_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_MEDIA_BYTES = PORTABLE_EXPORT_LIMITS.mediaFileBytes;
const MAX_MEDIA_DIMENSION = 12_000;
const MAX_MEDIA_PIXELS = 40_000_000;
const MAX_CHECKPOINT_BYTES = 2 * 1024 * 1024;
const MINIMUM_STANDARD_CARDS = 12;

function isEnabledStandard(card: CardDefinition): boolean {
  return card.rarity === 'standard' && card.enabled !== false;
}

export type SupportedMediaType = 'image/jpeg' | 'image/png' | 'image/webp';

const MEDIA_EXTENSIONS: Record<SupportedMediaType, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

export interface MatchRecord {
  id: string;
  seed: number;
  mode: GameMode;
  playlist: Playlist;
  rounds: number;
  winnerIds: string[];
  fighterIds: string[];
  /** Immutable pre-round-one state used for deterministic replay. */
  initialBattle: BattleState;
  /** Human and bot choices grouped by resolved round. */
  roundActions: ActionChoice[][];
}

export interface FighterStat {
  fighterId: string;
  matches: number;
  wins: number;
  winRate: number;
}

export interface MediaRecord {
  id: string;
  mimeType: SupportedMediaType;
  width: number;
  height: number;
  byteSize: number;
  sha256: string;
  createdAt: string;
}

export interface StoredMedia {
  record: MediaRecord;
  absolutePath: string;
}

export interface SaveMediaInput {
  id: string;
  bytes: Uint8Array;
  mimeType: SupportedMediaType;
  width: number;
  height: number;
  /** Optional caller-computed digest. It must match the bytes when supplied. */
  sha256?: string;
}

export interface StoreDiagnostics {
  schemaVersion: number;
  integrity: string;
  cards: number;
  enabledCards: number;
  standardCards: number;
  enabledStandardCards: number;
  matches: number;
  media: number;
  hasRoomCheckpoint: boolean;
}

export interface BackupFileEntry {
  path: string;
  byteSize: number;
  sha256: string;
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  createdAt: string;
  schemaVersion: number;
  files: BackupFileEntry[];
}

export interface BackupResult {
  path: string;
  manifest: BackupManifest;
}

export interface BackupVerification {
  ok: boolean;
  errors: string[];
  manifest: BackupManifest | null;
}

export interface RestoreResult {
  restoredFrom: string;
  recoveryPath: string | null;
}

interface CardRow {
  id: string;
  payload: string;
  revision: number;
  origin: PortableCardOrigin;
  updated_at: string;
}

interface MatchRow {
  id: string;
  seed: number;
  mode: string;
  playlist: string;
  rounds: number;
  winner_ids: string;
  fighter_ids: string;
  card_snapshots: string;
  initial_battle: string;
  round_actions: string;
  created_at: string;
}

interface MediaRow {
  id: string;
  relative_path: string;
  mime_type: string;
  width: number;
  height: number;
  byte_size: number;
  sha256: string;
  created_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function containsMediaId(value: unknown, mediaId: string): boolean {
  const pending: unknown[] = [value];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    visited += 1;
    if (visited > 250_000) throw new Error('Room checkpoint is too complex to scan safely.');
    if (Array.isArray(current)) {
      for (const item of current) pending.push(item);
      continue;
    }
    if (!isRecord(current)) continue;
    if (current.mediaId === mediaId) return true;
    for (const item of Object.values(current)) pending.push(item);
  }
  return false;
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Private storage directory is not a real directory: ${path}`);
  chmodSync(path, 0o700);
}

function hardenFile(path: string): void {
  const stat = lstatIfPresent(path);
  if (!stat) return;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Private storage file is not a regular file: ${path}`);
  chmodSync(path, 0o600);
}

function ensureWithin(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`Path escapes private storage: ${candidate}`);
  }
  return resolvedCandidate;
}

function ensurePathWithoutSymlinks(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = ensureWithin(resolvedRoot, candidate);
  const rootStat = lstatSync(resolvedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Private storage root is not a real directory: ${resolvedRoot}`);
  }
  let current = resolvedRoot;
  const remainder = relative(resolvedRoot, resolvedCandidate);
  if (!remainder) return resolvedCandidate;
  for (const part of remainder.split(sep)) {
    current = join(current, part);
    const stat = lstatIfPresent(current);
    if (!stat) break;
    if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in private storage: ${current}`);
  }
  return resolvedCandidate;
}

function safeRelativePath(value: string): boolean {
  if (!value || value.includes('\\') || value.startsWith('/') || value.includes('\0')) return false;
  const parts = value.split('/');
  return parts.every((part) => part !== '' && part !== '.' && part !== '..');
}

function hashBytes(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function hashFile(path: string): string {
  return hashBytes(readFileSync(path));
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function normalizeIsoDate(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be an ISO date.`);
  const timestamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`${field} must be an ISO date.`);
  return new Date(timestamp).toISOString();
}

function optionalEffectBase(effect: Effect): { chance?: number; recipient?: 'target' | 'self' } {
  return {
    ...(effect.chance === undefined ? {} : { chance: effect.chance }),
    ...(effect.recipient === undefined ? {} : { recipient: effect.recipient }),
  };
}

function canonicalCondition(condition: Condition): Condition {
  switch (condition.kind) {
    case 'target-hp-below':
    case 'self-hp-below':
      return { kind: condition.kind, percent: condition.percent };
    case 'round-at-least':
      return { kind: condition.kind, round: condition.round };
    case 'target-has-status':
      return { kind: condition.kind, status: condition.status };
    case 'damaged-by-target-last-round':
      return { kind: condition.kind };
    case 'chance':
      return { kind: condition.kind, probability: condition.probability };
  }
}

function canonicalEffect(effect: Effect): Effect {
  const base = optionalEffectBase(effect);
  switch (effect.kind) {
    case 'damage':
      return {
        ...base,
        kind: 'damage',
        amount: effect.amount,
        ...(effect.repeat ? { repeat: { min: effect.repeat.min, max: effect.repeat.max } } : {}),
      };
    case 'heal':
    case 'shield':
    case 'self-damage':
      return { ...base, kind: effect.kind, amount: effect.amount };
    case 'status':
      return {
        ...base,
        kind: 'status',
        status: {
          kind: effect.status.kind,
          label: effect.status.label,
          duration: effect.status.duration,
          ...(effect.status.value === undefined ? {} : { value: effect.status.value }),
          ...(effect.status.abilityId === undefined ? {} : { abilityId: effect.status.abilityId }),
        },
      };
    case 'disable':
      return { ...base, kind: 'disable', duration: effect.duration };
    case 'cleanse':
    case 'steal-status':
      return { ...base, kind: effect.kind, ...(effect.count === undefined ? {} : { count: effect.count }) };
    case 'conditional':
      return {
        ...base,
        kind: 'conditional',
        condition: canonicalCondition(effect.condition),
        effects: effect.effects.map(canonicalEffect),
        ...(effect.otherwise === undefined ? {} : { otherwise: effect.otherwise.map(canonicalEffect) }),
      };
  }
}

function canonicalAbility(ability: AbilityDefinition): AbilityDefinition {
  return {
    id: ability.id,
    name: ability.name,
    description: ability.description,
    target: ability.target,
    priority: ability.priority,
    cooldown: ability.cooldown,
    ...(ability.availableFromRound === undefined ? {} : { availableFromRound: ability.availableFromRound }),
    ...(ability.oncePerMatch === undefined ? {} : { oncePerMatch: ability.oncePerMatch }),
    effects: ability.effects.map(canonicalEffect),
  };
}

function canonicalCard(value: unknown, field = 'card'): CardDefinition {
  const validation = validateCardDefinition(value);
  if (!validation.ok) throw new Error(`${field} is invalid: ${validation.errors.join(' ')}`);
  const normalized = normalizeCardDefinition(value as CardDefinition);
  return {
    id: normalized.id,
    enabled: normalized.enabled !== false,
    name: normalized.name,
    title: normalized.title,
    quote: normalized.quote,
    archetype: normalized.archetype,
    hp: normalized.hp,
    rarity: normalized.rarity,
    accent: normalized.accent,
    accentAlt: normalized.accentAlt,
    avatarSeed: normalized.avatarSeed,
    ...(normalized.portrait ? {
      portrait: {
        mediaId: normalized.portrait.mediaId,
        focalX: normalized.portrait.focalX,
        focalY: normalized.portrait.focalY,
      },
    } : {}),
    abilities: normalized.abilities.map(canonicalAbility),
  };
}

function parseJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${field} contains invalid JSON.`);
  }
}

function parseStringArray(value: string, field: string): string[] {
  const parsed = parseJson(value, field);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error(`${field} must be a text array.`);
  }
  return parsed;
}

function canonicalAction(value: unknown, field: string): ActionChoice {
  if (!isRecord(value)
    || typeof value.actorId !== 'string'
    || value.actorId.length < 1
    || value.actorId.length > 128
    || typeof value.abilityId !== 'string'
    || !SAFE_ABILITY_ID.test(value.abilityId)
    || !Array.isArray(value.targetIds)
    || value.targetIds.length > 4
    || !value.targetIds.every((target) => typeof target === 'string' && target.length >= 1 && target.length <= 128)) {
    throw new Error(`${field} is not a valid action.`);
  }
  return {
    actorId: value.actorId,
    abilityId: value.abilityId,
    targetIds: [...new Set(value.targetIds as string[])],
  };
}

function canonicalRoundActions(value: unknown, field: string): ActionChoice[][] {
  if (!Array.isArray(value) || value.length > 12) throw new Error(`${field} must contain at most 12 rounds.`);
  return value.map((round, roundIndex) => {
    if (!Array.isArray(round) || round.length > 4) throw new Error(`${field}[${roundIndex}] must contain at most four actions.`);
    const actions = round.map((action, actionIndex) => canonicalAction(action, `${field}[${roundIndex}][${actionIndex}]`));
    if (new Set(actions.map((action) => action.actorId)).size !== actions.length) {
      throw new Error(`${field}[${roundIndex}] contains duplicate actors.`);
    }
    return actions;
  });
}

function canonicalInitialBattle(value: unknown, field: string): BattleState {
  if (!isRecord(value)
    || !Number.isInteger(value.seed)
    || (value.seed as number) < 1
    || (value.seed as number) > 2_147_483_647
    || !Number.isInteger(value.rngState)
    || (value.rngState as number) < 0
    || (value.rngState as number) > 4_294_967_295
    || !['duel', 'ffa', 'teams'].includes(value.mode as string)
    || value.round !== 1
    || value.finished !== false
    || value.winnerPlayerIds !== null
    || !isRecord(value.fighters)) {
    throw new Error(`${field} is not a valid pre-round-one battle state.`);
  }
  const entries = Object.entries(value.fighters);
  if (entries.length < 2 || entries.length > 4) throw new Error(`${field} must contain two to four fighters.`);
  const fighters: BattleState['fighters'] = {};
  for (const [key, rawFighter] of entries) {
    if (!isRecord(rawFighter)
      || rawFighter.id !== key
      || typeof rawFighter.name !== 'string'
      || [...rawFighter.name.trim()].length < 1
      || [...rawFighter.name].length > 40
      || typeof rawFighter.teamId !== 'string'
      || rawFighter.teamId.length < 1
      || rawFighter.teamId.length > 128
      || !Number.isInteger(rawFighter.hp)
      || !Number.isInteger(rawFighter.shield)
      || rawFighter.shield !== 0
      || !Array.isArray(rawFighter.statuses)
      || rawFighter.statuses.length !== 0
      || !isRecord(rawFighter.cooldowns)
      || Object.keys(rawFighter.cooldowns).length !== 0
      || !Array.isArray(rawFighter.usedAbilities)
      || rawFighter.usedAbilities.length !== 0
      || !Array.isArray(rawFighter.damagedByLastRound)
      || rawFighter.damagedByLastRound.length !== 0) {
      throw new Error(`${field}.fighters.${key} is not a valid initial combatant.`);
    }
    const card = canonicalCard(rawFighter.card, `${field}.fighters.${key}.card`);
    if (rawFighter.hp !== card.hp) throw new Error(`${field}.fighters.${key} must begin at full HP.`);
    fighters[key] = {
      id: key,
      name: rawFighter.name.normalize('NFC').trim(),
      teamId: rawFighter.teamId,
      card,
      hp: card.hp,
      shield: 0,
      statuses: [],
      cooldowns: {},
      usedAbilities: [],
      damagedByLastRound: [],
    };
  }
  return {
    seed: value.seed as number,
    rngState: value.rngState as number,
    mode: value.mode as GameMode,
    round: 1,
    fighters,
    finished: false,
    winnerPlayerIds: null,
  };
}

function validateMatchFields(match: MatchRecord): MatchRecord {
  if (!SAFE_MATCH_ID.test(match.id)) throw new Error('Match id is invalid.');
  if (!Number.isInteger(match.seed) || match.seed < 1 || match.seed > 2_147_483_647) throw new Error('Match seed is invalid.');
  if (!['duel', 'ffa', 'teams'].includes(match.mode)) throw new Error('Match mode is invalid.');
  if (!['balanced', 'party'].includes(match.playlist)) throw new Error('Match playlist is invalid.');
  if (!Number.isInteger(match.rounds) || match.rounds < 1 || match.rounds > 12) throw new Error('Match rounds are invalid.');
  if (!Array.isArray(match.winnerIds) || !match.winnerIds.every((id) => typeof id === 'string' && id.length <= 40)) {
    throw new Error('Match winner ids are invalid.');
  }
  if (!Array.isArray(match.fighterIds) || match.fighterIds.length < 2 || match.fighterIds.length > 4
    || !match.fighterIds.every((id) => typeof id === 'string' && id.length <= 40)) {
    throw new Error('Match fighter ids are invalid.');
  }
  const initialBattle = canonicalInitialBattle(match.initialBattle, 'initialBattle');
  if (initialBattle.seed !== match.seed || initialBattle.mode !== match.mode) throw new Error('Initial battle metadata must match the match record.');
  const battleFighterIds = Object.values(initialBattle.fighters).map((fighter) => fighter.card.id);
  if (battleFighterIds.length !== match.fighterIds.length
    || battleFighterIds.some((fighterId, index) => fighterId !== match.fighterIds[index])) {
    throw new Error('Initial battle fighters must match the match record.');
  }
  const roundActions = canonicalRoundActions(match.roundActions, 'roundActions');
  if (roundActions.length !== match.rounds) throw new Error('Match round actions must match the resolved round count.');
  const playerIds = new Set(Object.keys(initialBattle.fighters));
  for (const [roundIndex, actions] of roundActions.entries()) {
    for (const action of actions) {
      const fighter = initialBattle.fighters[action.actorId];
      if (!fighter || !fighter.card.abilities.some((ability) => ability.id === action.abilityId)) {
        throw new Error(`roundActions[${roundIndex}] references an unknown actor or ability.`);
      }
      if (action.targetIds.some((targetId) => !playerIds.has(targetId))) {
        throw new Error(`roundActions[${roundIndex}] references an unknown target.`);
      }
    }
  }
  return {
    ...match,
    winnerIds: [...match.winnerIds],
    fighterIds: [...match.fighterIds],
    initialBattle,
    roundActions,
  };
}

function rowToMediaRecord(row: MediaRow): MediaRecord {
  if (!UUID_V4.test(row.id)
    || !(row.mime_type in MEDIA_EXTENSIONS)
    || !safeRelativePath(row.relative_path)
    || row.relative_path !== relativeMediaPath(row.sha256, row.mime_type as SupportedMediaType)
    || !Number.isInteger(row.width)
    || !Number.isInteger(row.height)
    || !Number.isInteger(row.byte_size)
    || row.width < 1
    || row.height < 1
    || row.width > MAX_MEDIA_DIMENSION
    || row.height > MAX_MEDIA_DIMENSION
    || row.width * row.height > MAX_MEDIA_PIXELS
    || row.byte_size < 1
    || row.byte_size > MAX_MEDIA_BYTES
    || !SHA256.test(row.sha256)) {
    throw new Error(`Media metadata is corrupt for ${row.id}.`);
  }
  return {
    id: row.id,
    mimeType: row.mime_type as SupportedMediaType,
    width: row.width,
    height: row.height,
    byteSize: row.byte_size,
    sha256: row.sha256,
    createdAt: normalizeIsoDate(row.created_at, `media ${row.id} created_at`),
  };
}

function relativeMediaPath(hash: string, mimeType: SupportedMediaType): string {
  return `media/people/${hash}${MEDIA_EXTENSIONS[mimeType]}`;
}

function databaseSchemaVersion(database: DatabaseSync): number {
  const row = database.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return row?.user_version ?? 0;
}

function databaseIntegrity(database: DatabaseSync): string {
  const row = database.prepare('PRAGMA integrity_check').get() as Record<string, unknown> | undefined;
  return String(row?.integrity_check ?? Object.values(row ?? {})[0] ?? 'unknown');
}

function hasColumn(database: DatabaseSync, table: string, column: string): boolean {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function applyMigrations(database: DatabaseSync): void {
  const foundVersion = databaseSchemaVersion(database);
  if (foundVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(`Database schema ${foundVersion} is newer than supported schema ${CURRENT_SCHEMA_VERSION}.`);
  }

  for (let version = foundVersion + 1; version <= CURRENT_SCHEMA_VERSION; version += 1) {
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      if (version === 1) {
        database.exec(`
          CREATE TABLE IF NOT EXISTS cards (
            id TEXT PRIMARY KEY,
            payload TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          );
          CREATE TABLE IF NOT EXISTS matches (
            id TEXT PRIMARY KEY,
            seed INTEGER NOT NULL,
            mode TEXT NOT NULL,
            playlist TEXT NOT NULL,
            rounds INTEGER NOT NULL,
            winner_ids TEXT NOT NULL,
            fighter_ids TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          );
        `);
      }
      if (version === 2) {
        if (!hasColumn(database, 'cards', 'revision')) database.exec('ALTER TABLE cards ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
        if (!hasColumn(database, 'cards', 'origin')) database.exec("ALTER TABLE cards ADD COLUMN origin TEXT NOT NULL DEFAULT 'legacy'");
        if (!hasColumn(database, 'cards', 'builtin_hash')) database.exec('ALTER TABLE cards ADD COLUMN builtin_hash TEXT');
        database.exec(`
          CREATE TABLE IF NOT EXISTS media (
            id TEXT PRIMARY KEY,
            relative_path TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            width INTEGER NOT NULL,
            height INTEGER NOT NULL,
            byte_size INTEGER NOT NULL,
            sha256 TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(relative_path)
          );
          CREATE INDEX IF NOT EXISTS media_sha256_idx ON media(sha256);
          CREATE TABLE IF NOT EXISTS room_checkpoint (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            payload TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          );
        `);
      }
      if (version === 3) {
        if (!hasColumn(database, 'matches', 'card_snapshots')) database.exec("ALTER TABLE matches ADD COLUMN card_snapshots TEXT NOT NULL DEFAULT '[]'");
        if (!hasColumn(database, 'matches', 'round_actions')) database.exec("ALTER TABLE matches ADD COLUMN round_actions TEXT NOT NULL DEFAULT '[]'");
      }
      if (version === 4) {
        if (!hasColumn(database, 'matches', 'initial_battle')) database.exec("ALTER TABLE matches ADD COLUMN initial_battle TEXT NOT NULL DEFAULT 'null'");
      }
      if (version === 5) {
        database.exec(`
          CREATE TABLE media_v5 (
            id TEXT PRIMARY KEY,
            relative_path TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            width INTEGER NOT NULL,
            height INTEGER NOT NULL,
            byte_size INTEGER NOT NULL,
            sha256 TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          );
          INSERT INTO media_v5 SELECT id, relative_path, mime_type, width, height, byte_size, sha256, created_at FROM media;
          DROP TABLE media;
          ALTER TABLE media_v5 RENAME TO media;
          CREATE INDEX media_sha256_idx ON media(sha256);
        `);
      }
      database.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(version);
      database.exec(`PRAGMA user_version = ${version}`);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
}

function hardenSqliteFiles(dataDirectory: string): void {
  hardenFile(join(dataDirectory, 'game.sqlite'));
  hardenFile(join(dataDirectory, 'game.sqlite-wal'));
  hardenFile(join(dataDirectory, 'game.sqlite-shm'));
}

function ensureMediaInput(input: SaveMediaInput): { bytes: Buffer; hash: string } {
  if (!UUID_V4.test(input.id)) throw new Error('Media id must be a UUID v4.');
  if (!(input.mimeType in MEDIA_EXTENSIONS)) throw new Error('Unsupported normalized media type.');
  const bytes = Buffer.from(input.bytes);
  if (bytes.length < 1 || bytes.length > MAX_MEDIA_BYTES) throw new Error(`Media must be 1–${MAX_MEDIA_BYTES} bytes.`);
  const signatureMatches = input.mimeType === 'image/jpeg'
    ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : input.mimeType === 'image/png'
      ? bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!signatureMatches) throw new Error('Media bytes do not match the declared normalized MIME type.');
  if (!Number.isInteger(input.width) || !Number.isInteger(input.height)
    || input.width < 1 || input.height < 1
    || input.width > MAX_MEDIA_DIMENSION || input.height > MAX_MEDIA_DIMENSION
    || input.width * input.height > MAX_MEDIA_PIXELS) {
    throw new Error('Media dimensions exceed the private media limits.');
  }
  const hash = hashBytes(bytes);
  if (input.sha256 !== undefined && input.sha256.toLowerCase() !== hash) throw new Error('Media SHA-256 does not match its bytes.');
  return { bytes, hash };
}

function decodeCanonicalBase64(value: unknown, field: string): Buffer {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error(`${field} is not canonical base64.`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error(`${field} is not canonical base64.`);
  return bytes;
}

function portablePayload(file: PortableExportFile): PortableExportPayload {
  return {
    format: file.format,
    version: file.version,
    appVersion: file.appVersion,
    exportedAt: file.exportedAt,
    includesMatches: file.includesMatches,
    cards: file.cards,
    matches: file.matches,
    media: file.media,
  };
}

function canonicalPortableMatch(value: unknown, index: number): PortableMatchRecord {
  if (!isRecord(value)) throw new Error(`matches[${index}] must be an object.`);
  const createdAt = normalizeIsoDate(value.createdAt, `matches[${index}].createdAt`);
  if (value.initialBattle === null) {
    if (typeof value.id !== 'string'
      || !SAFE_MATCH_ID.test(value.id)
      || !Number.isInteger(value.seed)
      || (value.seed as number) < 1
      || (value.seed as number) > 2_147_483_647
      || !['duel', 'ffa', 'teams'].includes(value.mode as string)
      || !['balanced', 'party'].includes(value.playlist as string)
      || !Number.isInteger(value.rounds)
      || (value.rounds as number) < 1
      || (value.rounds as number) > 12
      || !Array.isArray(value.winnerIds)
      || !Array.isArray(value.fighterIds)
      || !Array.isArray(value.roundActions)
      || value.roundActions.length !== 0) {
      throw new Error(`matches[${index}] legacy metadata is invalid.`);
    }
    return {
      id: value.id,
      seed: value.seed as number,
      mode: value.mode as GameMode,
      playlist: value.playlist as Playlist,
      rounds: value.rounds as number,
      winnerIds: (value.winnerIds as unknown[]).map((id) => {
        if (typeof id !== 'string') throw new Error(`matches[${index}].winnerIds is invalid.`);
        return id;
      }),
      fighterIds: (value.fighterIds as unknown[]).map((id) => {
        if (typeof id !== 'string') throw new Error(`matches[${index}].fighterIds is invalid.`);
        return id;
      }),
      initialBattle: null,
      roundActions: [],
      createdAt,
    };
  }
  const match = validateMatchFields({
    id: value.id as string,
    seed: value.seed as number,
    mode: value.mode as GameMode,
    playlist: value.playlist as Playlist,
    rounds: value.rounds as number,
    winnerIds: value.winnerIds as string[],
    fighterIds: value.fighterIds as string[],
    initialBattle: value.initialBattle as BattleState,
    roundActions: Array.isArray(value.roundActions) ? value.roundActions as ActionChoice[][] : [],
  });
  return { ...match, createdAt };
}

interface ValidatedPortableFile {
  file: PortableExportFile;
  mediaBytes: Map<string, Buffer>;
}

function validatePortableFile(value: unknown): ValidatedPortableFile {
  if (!isRecord(value)
    || value.format !== PORTABLE_EXPORT_FORMAT
    || value.version !== PORTABLE_EXPORT_VERSION
    || typeof value.appVersion !== 'string'
    || typeof value.includesMatches !== 'boolean'
    || !Array.isArray(value.cards)
    || !Array.isArray(value.matches)
    || !Array.isArray(value.media)
    || typeof value.checksum !== 'string'
    || !SHA256.test(value.checksum)) {
    throw new Error('Portable export header is invalid or unsupported.');
  }
  if (value.cards.length < 1 || value.cards.length > PORTABLE_EXPORT_LIMITS.cards) throw new Error('Portable export card count is invalid.');
  if (value.matches.length > PORTABLE_EXPORT_LIMITS.matches) throw new Error('Portable export match count is invalid.');
  if (!value.includesMatches && value.matches.length > 0) throw new Error('Portable export contains undeclared match history.');
  if (value.media.length > PORTABLE_EXPORT_LIMITS.mediaFiles) throw new Error('Portable export media count is invalid.');

  const cards: PortableCardRecord[] = value.cards.map((item, index) => {
    if (!isRecord(item)
      || !Number.isInteger(item.revision)
      || (item.revision as number) < 1
      || !['builtin', 'custom', 'imported', 'legacy'].includes(item.origin as string)) {
      throw new Error(`cards[${index}] metadata is invalid.`);
    }
    return {
      card: canonicalCard(item.card, `cards[${index}].card`),
      revision: item.revision as number,
      origin: item.origin as PortableCardOrigin,
      updatedAt: normalizeIsoDate(item.updatedAt, `cards[${index}].updatedAt`),
    };
  });
  if (new Set(cards.map((item) => item.card.id)).size !== cards.length) throw new Error('Portable export contains duplicate card ids.');

  const matches = value.matches.map(canonicalPortableMatch);
  if (new Set(matches.map((match) => match.id)).size !== matches.length) throw new Error('Portable export contains duplicate match ids.');

  const mediaBytes = new Map<string, Buffer>();
  let totalMediaBytes = 0;
  const media: PortableMediaRecord[] = value.media.map((item, index) => {
    if (!isRecord(item)
      || typeof item.id !== 'string'
      || !UUID_V4.test(item.id)
      || typeof item.mimeType !== 'string'
      || !(item.mimeType in MEDIA_EXTENSIONS)
      || !Number.isInteger(item.width)
      || !Number.isInteger(item.height)
      || !Number.isInteger(item.byteSize)
      || typeof item.sha256 !== 'string'
      || !SHA256.test(item.sha256)) {
      throw new Error(`media[${index}] metadata is invalid.`);
    }
    const bytes = decodeCanonicalBase64(item.dataBase64, `media[${index}].dataBase64`);
    const verified = ensureMediaInput({
      id: item.id,
      bytes,
      mimeType: item.mimeType as SupportedMediaType,
      width: item.width as number,
      height: item.height as number,
      sha256: item.sha256,
    });
    if (verified.bytes.length !== item.byteSize) throw new Error(`media[${index}] byte size does not match.`);
    totalMediaBytes += verified.bytes.length;
    if (totalMediaBytes > PORTABLE_EXPORT_LIMITS.totalMediaBytes) throw new Error('Portable export media is too large.');
    mediaBytes.set(item.id, verified.bytes);
    return {
      id: item.id,
      mimeType: item.mimeType as SupportedMediaType,
      width: item.width as number,
      height: item.height as number,
      byteSize: item.byteSize as number,
      sha256: item.sha256,
      dataBase64: item.dataBase64 as string,
      createdAt: normalizeIsoDate(item.createdAt, `media[${index}].createdAt`),
    };
  });
  if (new Set(media.map((item) => item.id)).size !== media.length) throw new Error('Portable export contains duplicate media ids.');

  const mediaIds = new Set(media.map((item) => item.id));
  for (const card of [
    ...cards.map((item) => item.card),
    ...matches.flatMap((match) => match.initialBattle ? Object.values(match.initialBattle.fighters).map((fighter) => fighter.card) : []),
  ]) {
    if (card.portrait && !mediaIds.has(card.portrait.mediaId)) {
      throw new Error(`Portable export is missing portrait media ${card.portrait.mediaId}.`);
    }
  }

  const file: PortableExportFile = {
    format: PORTABLE_EXPORT_FORMAT,
    version: PORTABLE_EXPORT_VERSION,
    appVersion: value.appVersion,
    exportedAt: normalizeIsoDate(value.exportedAt, 'exportedAt'),
    includesMatches: value.includesMatches,
    cards,
    matches,
    media,
    checksum: value.checksum,
  };
  const expectedChecksum = hashBytes(stableJson(portablePayload(file)));
  if (file.checksum !== expectedChecksum) throw new Error('Portable export checksum does not match its contents.');
  return { file, mediaBytes };
}

function parseBackupManifest(value: unknown): BackupManifest {
  if (!isRecord(value)
    || value.format !== BACKUP_FORMAT
    || value.version !== BACKUP_VERSION
    || !Number.isInteger(value.schemaVersion)
    || !Array.isArray(value.files)) {
    throw new Error('Backup manifest is invalid or unsupported.');
  }
  const files = value.files.map((item, index): BackupFileEntry => {
    if (!isRecord(item)
      || typeof item.path !== 'string'
      || !safeRelativePath(item.path)
      || !Number.isInteger(item.byteSize)
      || (item.byteSize as number) < 0
      || typeof item.sha256 !== 'string'
      || !SHA256.test(item.sha256)) {
      throw new Error(`Backup manifest file ${index} is invalid.`);
    }
    return { path: item.path, byteSize: item.byteSize as number, sha256: item.sha256 };
  });
  if (files.length < 1 || files.length > 10_000) throw new Error('Backup manifest file count is invalid.');
  if (new Set(files.map((file) => file.path)).size !== files.length) throw new Error('Backup manifest contains duplicate paths.');
  if (!files.some((file) => file.path === 'game.sqlite')) throw new Error('Backup is missing game.sqlite.');
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: normalizeIsoDate(value.createdAt, 'backup createdAt'),
    schemaVersion: value.schemaVersion as number,
    files,
  };
}

function copyPrivateFile(source: string, target: string): BackupFileEntry {
  const sourceStat = lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error(`Backup source is not a regular file: ${source}`);
  ensurePrivateDirectory(dirname(target));
  copyFileSync(source, target);
  chmodSync(target, 0o600);
  const stat = statSync(target);
  return { path: '', byteSize: stat.size, sha256: hashFile(target) };
}

export function latestBackupDirectory(backupRoot: string): string | null {
  const root = resolve(backupRoot);
  if (!existsSync(root)) return null;
  const candidates = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && existsSync(join(root, entry.name, 'manifest.json')))
    .map((entry) => ({ path: join(root, entry.name), modified: statSync(join(root, entry.name)).mtimeMs }))
    .sort((left, right) => right.modified - left.modified);
  return candidates[0]?.path ?? null;
}

export async function createConsistentBackup(
  dataDirectoryInput: string,
  backupRootInput: string,
  label = 'manual',
): Promise<BackupResult> {
  const dataDirectory = resolve(dataDirectoryInput);
  const backupRoot = resolve(backupRootInput);
  if (backupRoot === dataDirectory || backupRoot.startsWith(`${dataDirectory}${sep}`)) {
    throw new Error('Backup directory must be outside GAME_DATA_DIR.');
  }
  const sourceDatabasePath = join(dataDirectory, 'game.sqlite');
  if (!existsSync(sourceDatabasePath)) throw new Error(`No game database found at ${sourceDatabasePath}`);
  ensurePathWithoutSymlinks(dataDirectory, sourceDatabasePath);
  ensurePrivateDirectory(backupRoot);

  const safeLabel = label.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'backup';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const finalDirectory = join(backupRoot, `${timestamp}-${safeLabel}-${randomUUID().slice(0, 8)}`);
  const partialDirectory = join(backupRoot, `.partial-${basename(finalDirectory)}`);
  ensurePrivateDirectory(partialDirectory);

  try {
    const targetDatabasePath = join(partialDirectory, 'game.sqlite');
    const sourceDatabase = new DatabaseSync(sourceDatabasePath, { readOnly: true });
    try {
      await backup(sourceDatabase, targetDatabasePath);
    } finally {
      sourceDatabase.close();
    }
    chmodSync(targetDatabasePath, 0o600);

    const snapshotDatabase = new DatabaseSync(targetDatabasePath, { readOnly: true });
    let schemaVersion = 0;
    let mediaRows: MediaRow[] = [];
    try {
      if (databaseIntegrity(snapshotDatabase) !== 'ok') throw new Error('SQLite integrity check failed for the backup snapshot.');
      schemaVersion = databaseSchemaVersion(snapshotDatabase);
      if (schemaVersion >= 2) mediaRows = snapshotDatabase.prepare('SELECT * FROM media ORDER BY id').all() as unknown as MediaRow[];
    } finally {
      snapshotDatabase.close();
    }

    const files: BackupFileEntry[] = [];
    const copiedMedia = new Map<string, BackupFileEntry>();
    const databaseStat = statSync(targetDatabasePath);
    files.push({ path: 'game.sqlite', byteSize: databaseStat.size, sha256: hashFile(targetDatabasePath) });
    for (const row of mediaRows) {
      const record = rowToMediaRecord(row);
      if (!safeRelativePath(row.relative_path)) throw new Error(`Unsafe media path in database: ${row.relative_path}`);
      const copied = copiedMedia.get(row.relative_path);
      if (copied) {
        if (copied.byteSize !== record.byteSize || copied.sha256 !== record.sha256) {
          throw new Error(`Deduplicated media metadata conflicts for ${record.id}`);
        }
        continue;
      }
      const source = ensurePathWithoutSymlinks(dataDirectory, join(dataDirectory, row.relative_path));
      const target = ensureWithin(partialDirectory, join(partialDirectory, row.relative_path));
      if (!existsSync(source)) throw new Error(`Media file is missing during backup: ${record.id}`);
      const entry = copyPrivateFile(source, target);
      entry.path = row.relative_path;
      if (entry.byteSize !== record.byteSize || entry.sha256 !== record.sha256) {
        throw new Error(`Media changed or is corrupt during backup: ${record.id}`);
      }
      files.push(entry);
      copiedMedia.set(row.relative_path, entry);
    }

    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      createdAt: new Date().toISOString(),
      schemaVersion,
      files,
    };
    writeFileSync(join(partialDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(partialDirectory, finalDirectory);
    return { path: finalDirectory, manifest };
  } catch (error) {
    rmSync(partialDirectory, { recursive: true, force: true });
    throw error;
  }
}

export function verifyConsistentBackup(backupDirectoryInput: string): BackupVerification {
  const backupDirectory = resolve(backupDirectoryInput);
  const errors: string[] = [];
  let manifest: BackupManifest | null = null;
  try {
    ensurePathWithoutSymlinks(backupDirectory, backupDirectory);
    const manifestPath = join(backupDirectory, 'manifest.json');
    if (!existsSync(manifestPath) || statSync(manifestPath).size > 1_000_000) throw new Error('Backup manifest is missing or too large.');
    manifest = parseBackupManifest(parseJson(readFileSync(manifestPath, 'utf8'), 'backup manifest'));
    if (manifest.schemaVersion > CURRENT_SCHEMA_VERSION) {
      errors.push(`Backup schema ${manifest.schemaVersion} is newer than supported schema ${CURRENT_SCHEMA_VERSION}.`);
    }
    for (const file of manifest.files) {
      const path = ensurePathWithoutSymlinks(backupDirectory, join(backupDirectory, file.path));
      if (!existsSync(path)) {
        errors.push(`Missing file: ${file.path}`);
        continue;
      }
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        errors.push(`Not a regular file: ${file.path}`);
        continue;
      }
      if (stat.size !== file.byteSize) errors.push(`Size mismatch: ${file.path}`);
      if (hashFile(path) !== file.sha256) errors.push(`Checksum mismatch: ${file.path}`);
    }

    if (errors.length === 0) {
      const database = new DatabaseSync(join(backupDirectory, 'game.sqlite'), { readOnly: true });
      try {
        if (databaseIntegrity(database) !== 'ok') errors.push('SQLite integrity check failed.');
        if (databaseSchemaVersion(database) !== manifest.schemaVersion) errors.push('Manifest and database schema versions differ.');
        const cardRows = database.prepare('SELECT id, payload FROM cards').all() as Array<{ id: string; payload: string }>;
        for (const row of cardRows) canonicalCard(parseJson(row.payload, `card ${row.id}`), `card ${row.id}`);
        if (manifest.schemaVersion >= 2) {
          const manifestFiles = new Map(manifest.files.map((file) => [file.path, file]));
          const mediaRows = database.prepare('SELECT * FROM media').all() as unknown as MediaRow[];
          for (const row of mediaRows) {
            const media = rowToMediaRecord(row);
            const file = manifestFiles.get(row.relative_path);
            if (!file || file.byteSize !== media.byteSize || file.sha256 !== media.sha256) {
              errors.push(`Manifest is missing valid media for ${media.id}.`);
            }
          }
        }
      } finally {
        database.close();
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'Backup verification failed.');
  }
  return { ok: errors.length === 0, errors, manifest };
}

export async function restoreConsistentBackup(
  dataDirectoryInput: string,
  backupDirectoryInput: string,
  recoveryRootInput: string,
  options: { confirmServerStopped: boolean },
): Promise<RestoreResult> {
  if (!options.confirmServerStopped) throw new Error('Restore refused: explicitly confirm that the game server is stopped.');
  const dataDirectory = resolve(dataDirectoryInput);
  const backupDirectory = resolve(backupDirectoryInput);
  const recoveryRoot = resolve(recoveryRootInput);
  const verification = verifyConsistentBackup(backupDirectory);
  if (!verification.ok || !verification.manifest) throw new Error(`Backup verification failed: ${verification.errors.join(' ')}`);
  ensurePrivateDirectory(dataDirectory);

  const currentDatabase = join(dataDirectory, 'game.sqlite');
  const recovery = existsSync(currentDatabase)
    ? await createConsistentBackup(dataDirectory, recoveryRoot, 'pre-restore')
    : null;
  const staging = join(dataDirectory, `.restore-stage-${randomUUID()}`);
  const rollback = join(dataDirectory, `.restore-rollback-${randomUUID()}`);
  ensurePrivateDirectory(staging);
  ensurePrivateDirectory(rollback);
  let swapStarted = false;

  try {
    for (const file of verification.manifest.files) {
      const source = ensureWithin(backupDirectory, join(backupDirectory, file.path));
      const target = ensureWithin(staging, join(staging, file.path));
      const copied = copyPrivateFile(source, target);
      if (copied.byteSize !== file.byteSize || copied.sha256 !== file.sha256) throw new Error(`Restore staging verification failed for ${file.path}.`);
    }

    swapStarted = true;
    for (const name of ['game.sqlite', 'game.sqlite-wal', 'game.sqlite-shm', 'media']) {
      const current = join(dataDirectory, name);
      if (existsSync(current)) renameSync(current, join(rollback, name));
    }
    renameSync(join(staging, 'game.sqlite'), currentDatabase);
    if (existsSync(join(staging, 'media'))) renameSync(join(staging, 'media'), join(dataDirectory, 'media'));
    else ensurePrivateDirectory(join(dataDirectory, 'media'));
    hardenSqliteFiles(dataDirectory);

    const restored = new DatabaseSync(currentDatabase, { readOnly: true });
    try {
      if (databaseIntegrity(restored) !== 'ok') throw new Error('Restored database failed its final integrity check.');
    } finally {
      restored.close();
    }
  } catch (error) {
    if (swapStarted) {
      for (const name of ['game.sqlite', 'game.sqlite-wal', 'game.sqlite-shm', 'media']) {
        rmSync(join(dataDirectory, name), { recursive: true, force: true });
        const previous = join(rollback, name);
        if (existsSync(previous)) renameSync(previous, join(dataDirectory, name));
      }
    }
    rmSync(staging, { recursive: true, force: true });
    rmSync(rollback, { recursive: true, force: true });
    throw error;
  }
  try {
    rmSync(rollback, { recursive: true, force: true });
    rmSync(staging, { recursive: true, force: true });
  } catch (error) {
    throw new Error('Restore succeeded, but its private staging data could not be removed.', { cause: error });
  }
  return { restoredFrom: backupDirectory, recoveryPath: recovery?.path ?? null };
}

export class GameStore {
  private readonly database: DatabaseSync;
  private readonly dataDirectory: string;
  private readonly builtinCardIds: Set<string>;

  constructor(dataDirectory: string, initialCards: CardDefinition[]) {
    this.dataDirectory = resolve(dataDirectory);
    this.builtinCardIds = new Set();
    ensurePrivateDirectory(this.dataDirectory);
    ensurePrivateDirectory(join(this.dataDirectory, 'media'));
    ensurePrivateDirectory(join(this.dataDirectory, 'media', 'people'));
    ensurePrivateDirectory(join(this.dataDirectory, 'media', '.tmp'));
    const databasePath = join(this.dataDirectory, 'game.sqlite');
    if (lstatIfPresent(databasePath)) ensurePathWithoutSymlinks(this.dataDirectory, databasePath);
    this.database = new DatabaseSync(databasePath);
    hardenFile(databasePath);
    this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF;');
    applyMigrations(this.database);
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    hardenSqliteFiles(this.dataDirectory);

    const insert = this.database.prepare(`
      INSERT OR IGNORE INTO cards (id, payload, revision, origin, builtin_hash)
      VALUES (?, ?, 1, 'builtin', ?)
    `);
    const upgradeBuiltin = this.database.prepare(`
      UPDATE cards SET
        payload = ?,
        revision = revision + 1,
        builtin_hash = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND origin = 'builtin'
        AND (payload <> ? OR builtin_hash IS NULL OR builtin_hash <> ?)
    `);
    const markBuiltin = this.database.prepare(`
      UPDATE cards SET origin = 'builtin', builtin_hash = ?
      WHERE id = ? AND origin = 'legacy' AND payload = ?
    `);
    for (const initialCard of initialCards) {
      const card = canonicalCard(initialCard, `builtin card ${initialCard.id}`);
      this.builtinCardIds.add(card.id);
      const payload = JSON.stringify(card);
      const digest = hashBytes(stableJson(card));
      insert.run(card.id, payload, digest);
      upgradeBuiltin.run(payload, digest, card.id, payload, digest);
      markBuiltin.run(digest, card.id, payload);
    }
  }

  schemaVersion(): number {
    return databaseSchemaVersion(this.database);
  }

  listCards(): CardDefinition[] {
    return this.listCardRecords().map((record) => record.card);
  }

  private listCardRecords(): PortableCardRecord[] {
    const rows = this.database.prepare('SELECT id, payload, revision, origin, updated_at FROM cards ORDER BY id').all() as unknown as CardRow[];
    return rows.map((row) => {
      if (!Number.isInteger(row.revision) || row.revision < 1
        || !['builtin', 'custom', 'imported', 'legacy'].includes(row.origin)) {
        throw new Error(`Card metadata is corrupt for ${row.id}.`);
      }
      return {
        card: canonicalCard(parseJson(row.payload, `card ${row.id}`), `card ${row.id}`),
        revision: row.revision,
        origin: row.origin,
        updatedAt: normalizeIsoDate(row.updated_at, `card ${row.id} updated_at`),
      };
    });
  }

  saveCard(input: CardDefinition): void {
    const card = canonicalCard(input);
    if (card.portrait && !this.getMediaRecord(card.portrait.mediaId)) throw new Error('Portrait media does not exist.');
    const existingRow = this.database.prepare('SELECT payload FROM cards WHERE id = ?').get(card.id) as { payload: string } | undefined;
    const existingCard = existingRow
      ? canonicalCard(parseJson(existingRow.payload, `card ${card.id}`), `card ${card.id}`)
      : null;
    const enabledStandardCards = this.listCards().filter(isEnabledStandard).length;
    const projectedEnabledStandardCards = enabledStandardCards
      - (existingCard && isEnabledStandard(existingCard) ? 1 : 0)
      + (isEnabledStandard(card) ? 1 : 0);
    if (projectedEnabledStandardCards < MINIMUM_STANDARD_CARDS && projectedEnabledStandardCards < enabledStandardCards) {
      throw new Error(`At least ${MINIMUM_STANDARD_CARDS} enabled Standard cards must remain for four-player Balanced games.`);
    }
    this.database.prepare(`
      INSERT INTO cards (id, payload, revision, origin, builtin_hash, updated_at)
      VALUES (?, ?, 1, 'custom', NULL, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        payload = excluded.payload,
        revision = cards.revision + 1,
        origin = 'custom',
        builtin_hash = NULL,
        updated_at = CURRENT_TIMESTAMP
    `).run(card.id, JSON.stringify(card));
    hardenSqliteFiles(this.dataDirectory);
  }

  deleteCard(id: string): boolean {
    const row = this.database.prepare('SELECT payload FROM cards WHERE id = ?').get(id) as { payload: string } | undefined;
    if (!row) return false;
    if (this.builtinCardIds.has(id)) {
      throw new Error('Built-in cards cannot be deleted. Duplicate the card first if you want a removable version.');
    }
    const card = canonicalCard(parseJson(row.payload, `card ${id}`), `card ${id}`);
    if (isEnabledStandard(card)) {
      const enabledStandardCards = this.listCards().filter(isEnabledStandard).length;
      if (enabledStandardCards <= MINIMUM_STANDARD_CARDS) {
        throw new Error(`At least ${MINIMUM_STANDARD_CARDS} enabled Standard cards must remain for four-player Balanced games.`);
      }
    }
    this.database.prepare('DELETE FROM cards WHERE id = ?').run(id);
    if (card.portrait && !this.mediaIsReferenced(card.portrait.mediaId)) this.deleteMedia(card.portrait.mediaId);
    hardenSqliteFiles(this.dataDirectory);
    return true;
  }

  recordMatch(input: MatchRecord): void {
    const match = validateMatchFields(input);
    this.database.prepare(`
      INSERT OR IGNORE INTO matches
      (id, seed, mode, playlist, rounds, winner_ids, fighter_ids, card_snapshots, initial_battle, round_actions)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      match.id,
      match.seed,
      match.mode,
      match.playlist,
      match.rounds,
      JSON.stringify(match.winnerIds),
      JSON.stringify(match.fighterIds),
      JSON.stringify(Object.values(match.initialBattle.fighters).map((fighter) => fighter.card)),
      JSON.stringify(match.initialBattle),
      JSON.stringify(match.roundActions),
    );
    hardenSqliteFiles(this.dataDirectory);
  }

  private listMatchRecords(): PortableMatchRecord[] {
    const rows = this.database.prepare('SELECT * FROM matches ORDER BY created_at, id').all() as unknown as MatchRow[];
    return rows.map((row) => {
      const fighterIds = parseStringArray(row.fighter_ids, `match ${row.id} fighter_ids`);
      const initialValue = parseJson(row.initial_battle, `match ${row.id} initial_battle`);
      const actionsValue = parseJson(row.round_actions, `match ${row.id} round_actions`);
      const actions = canonicalRoundActions(actionsValue, `match ${row.id} round_actions`);
      const initialBattle = initialValue === null
        ? null
        : canonicalInitialBattle(initialValue, `match ${row.id} initial_battle`);
      return {
        id: row.id,
        seed: row.seed,
        mode: row.mode as GameMode,
        playlist: row.playlist as Playlist,
        rounds: row.rounds,
        winnerIds: parseStringArray(row.winner_ids, `match ${row.id} winner_ids`),
        fighterIds,
        initialBattle,
        roundActions: actions,
        createdAt: normalizeIsoDate(row.created_at, `match ${row.id} created_at`),
      };
    });
  }

  fighterStats(): FighterStat[] {
    const rows = this.database.prepare('SELECT winner_ids, fighter_ids FROM matches').all() as Array<{
      winner_ids: string;
      fighter_ids: string;
    }>;
    const stats = new Map<string, { matches: number; wins: number }>();
    for (const row of rows) {
      const fighters = parseStringArray(row.fighter_ids, 'match fighter_ids');
      const winners = new Set(parseStringArray(row.winner_ids, 'match winner_ids'));
      for (const fighter of fighters) {
        const current = stats.get(fighter) ?? { matches: 0, wins: 0 };
        current.matches += 1;
        if (winners.has(fighter)) current.wins += 1;
        stats.set(fighter, current);
      }
    }
    return [...stats.entries()].map(([fighterId, value]) => ({
      fighterId,
      ...value,
      winRate: value.matches > 0 ? value.wins / value.matches : 0,
    }));
  }

  saveMedia(input: SaveMediaInput): MediaRecord {
    const { bytes, hash } = ensureMediaInput(input);
    const existing = this.getMediaRecord(input.id);
    if (existing) {
      if (existing.sha256 !== hash
        || existing.mimeType !== input.mimeType
        || existing.width !== input.width
        || existing.height !== input.height
        || existing.byteSize !== bytes.length) {
        throw new Error('Media id already refers to different content or metadata.');
      }
      return existing;
    }

    const relativePath = relativeMediaPath(hash, input.mimeType);
    const target = ensurePathWithoutSymlinks(this.dataDirectory, join(this.dataDirectory, relativePath));
    ensurePrivateDirectory(dirname(target));
    let createdTarget = false;
    if (existsSync(target)) {
      const targetStat = lstatSync(target);
      if (!targetStat.isFile() || targetStat.isSymbolicLink() || hashFile(target) !== hash) {
        throw new Error('Existing content-addressed media file is invalid.');
      }
    } else {
      const temporary = ensureWithin(this.dataDirectory, join(this.dataDirectory, 'media', '.tmp', randomUUID()));
      writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
      try {
        renameSync(temporary, target);
        createdTarget = true;
        chmodSync(target, 0o600);
      } catch (error) {
        rmSync(temporary, { force: true });
        if (createdTarget) rmSync(target, { force: true });
        throw error;
      }
    }

    try {
      this.database.prepare(`
        INSERT INTO media (id, relative_path, mime_type, width, height, byte_size, sha256)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(input.id, relativePath, input.mimeType, input.width, input.height, bytes.length, hash);
    } catch (error) {
      if (createdTarget) rmSync(target, { force: true });
      throw error;
    }
    hardenSqliteFiles(this.dataDirectory);
    const saved = this.getMediaRecord(input.id);
    if (!saved) throw new Error('Media metadata was not saved.');
    return saved;
  }

  getMediaRecord(id: string): MediaRecord | null {
    if (!UUID_V4.test(id)) return null;
    const row = this.database.prepare('SELECT * FROM media WHERE id = ?').get(id) as MediaRow | undefined;
    return row ? rowToMediaRecord(row) : null;
  }

  listMediaRecords(): MediaRecord[] {
    const rows = this.database.prepare('SELECT * FROM media ORDER BY created_at, id').all() as unknown as MediaRow[];
    return rows.map(rowToMediaRecord);
  }

  getMedia(id: string): StoredMedia | null {
    if (!UUID_V4.test(id)) return null;
    const row = this.database.prepare('SELECT * FROM media WHERE id = ?').get(id) as MediaRow | undefined;
    if (!row) return null;
    if (!safeRelativePath(row.relative_path)) throw new Error(`Unsafe stored media path for ${id}.`);
    const absolutePath = ensurePathWithoutSymlinks(this.dataDirectory, join(this.dataDirectory, row.relative_path));
    const stat = existsSync(absolutePath) ? lstatSync(absolutePath) : null;
    if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`Stored media file is missing for ${id}.`);
    const record = rowToMediaRecord(row);
    if (stat.size !== record.byteSize || hashFile(absolutePath) !== record.sha256) throw new Error(`Stored media file is corrupt for ${id}.`);
    return { record, absolutePath };
  }

  private mediaIsReferenced(id: string): boolean {
    if (this.listCards().some((card) => card.portrait?.mediaId === id)) return true;
    if (this.listMatchRecords().some((match) => match.initialBattle
      && Object.values(match.initialBattle.fighters).some((fighter) => fighter.card.portrait?.mediaId === id))) return true;
    const checkpoint = this.loadRoomCheckpoint();
    return checkpoint !== null && containsMediaId(checkpoint, id);
  }

  deleteMedia(id: string): boolean {
    const row = this.database.prepare('SELECT * FROM media WHERE id = ?').get(id) as MediaRow | undefined;
    if (!row) return false;
    if (this.mediaIsReferenced(id)) throw new Error('Media is still referenced by a card or match replay.');
    this.database.prepare('DELETE FROM media WHERE id = ?').run(id);
    const remaining = this.database.prepare('SELECT COUNT(*) AS count FROM media WHERE relative_path = ?').get(row.relative_path) as { count: number };
    if (remaining.count === 0 && safeRelativePath(row.relative_path)) {
      const path = ensurePathWithoutSymlinks(this.dataDirectory, join(this.dataDirectory, row.relative_path));
      if (existsSync(path)) unlinkSync(path);
    }
    hardenSqliteFiles(this.dataDirectory);
    return true;
  }

  loadRoomCheckpoint(): unknown | null {
    const row = this.database.prepare('SELECT payload FROM room_checkpoint WHERE id = 1').get() as { payload: string } | undefined;
    return row ? parseJson(row.payload, 'room checkpoint') : null;
  }

  saveRoomCheckpoint(value: unknown): void {
    const payload = JSON.stringify(value);
    if (payload === undefined) throw new Error('Room checkpoint is not JSON serializable.');
    if (Buffer.byteLength(payload) > MAX_CHECKPOINT_BYTES) throw new Error('Room checkpoint is too large.');
    this.database.prepare(`
      INSERT INTO room_checkpoint (id, payload, updated_at)
      VALUES (1, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = CURRENT_TIMESTAMP
    `).run(payload);
    hardenSqliteFiles(this.dataDirectory);
  }

  clearRoomCheckpoint(): void {
    this.database.prepare('DELETE FROM room_checkpoint WHERE id = 1').run();
    hardenSqliteFiles(this.dataDirectory);
  }

  diagnostics(): StoreDiagnostics {
    const counts = this.database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM cards) AS cards,
        (SELECT COUNT(*) FROM cards WHERE COALESCE(json_extract(payload, '$.enabled'), 1) != 0) AS enabled_cards,
        (SELECT COUNT(*) FROM cards WHERE json_extract(payload, '$.rarity') = 'standard') AS standard_cards,
        (SELECT COUNT(*) FROM cards WHERE json_extract(payload, '$.rarity') = 'standard' AND COALESCE(json_extract(payload, '$.enabled'), 1) != 0) AS enabled_standard_cards,
        (SELECT COUNT(*) FROM matches) AS matches,
        (SELECT COUNT(*) FROM media) AS media,
        (SELECT COUNT(*) FROM room_checkpoint) AS checkpoints
    `).get() as { cards: number; enabled_cards: number; standard_cards: number; enabled_standard_cards: number; matches: number; media: number; checkpoints: number };
    const quickCheck = this.database.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
    return {
      schemaVersion: this.schemaVersion(),
      integrity: String(quickCheck?.quick_check ?? Object.values(quickCheck ?? {})[0] ?? 'unknown'),
      cards: counts.cards,
      enabledCards: counts.enabled_cards,
      standardCards: counts.standard_cards,
      enabledStandardCards: counts.enabled_standard_cards,
      matches: counts.matches,
      media: counts.media,
      hasRoomCheckpoint: counts.checkpoints > 0,
    };
  }

  createPortableExport(options: { includeMatches?: boolean } = {}): PortableExportFile {
    const includesMatches = options.includeMatches ?? false;
    const cards = this.listCardRecords();
    const matches = includesMatches ? this.listMatchRecords() : [];
    if (cards.length > PORTABLE_EXPORT_LIMITS.cards) throw new Error('Too many cards for a portable export.');
    if (matches.length > PORTABLE_EXPORT_LIMITS.matches) throw new Error('Too many matches for a portable export.');

    const mediaIds = new Set<string>();
    for (const card of [
      ...cards.map((item) => item.card),
      ...matches.flatMap((match) => match.initialBattle ? Object.values(match.initialBattle.fighters).map((fighter) => fighter.card) : []),
    ]) {
      if (card.portrait) mediaIds.add(card.portrait.mediaId);
    }
    if (mediaIds.size > PORTABLE_EXPORT_LIMITS.mediaFiles) throw new Error('Too many media files for a portable export.');
    let totalMediaBytes = 0;
    const media: PortableMediaRecord[] = [...mediaIds].sort().map((id) => {
      const stored = this.getMedia(id);
      if (!stored) throw new Error(`Referenced media is missing: ${id}`);
      const bytes = readFileSync(stored.absolutePath);
      totalMediaBytes += bytes.length;
      if (totalMediaBytes > PORTABLE_EXPORT_LIMITS.totalMediaBytes) throw new Error('Portable export media is too large.');
      return { ...stored.record, dataBase64: bytes.toString('base64') };
    });

    const payload: PortableExportPayload = {
      format: PORTABLE_EXPORT_FORMAT,
      version: PORTABLE_EXPORT_VERSION,
      appVersion: APP_VERSION,
      exportedAt: new Date().toISOString(),
      includesMatches,
      cards,
      matches,
      media,
    };
    return { ...payload, checksum: hashBytes(stableJson(payload)) };
  }

  serializePortableExport(options: { includeMatches?: boolean } = {}): string {
    const serialized = `${JSON.stringify(this.createPortableExport(options), null, 2)}\n`;
    if (Buffer.byteLength(serialized) > PORTABLE_EXPORT_LIMITS.jsonBytes) throw new Error('Portable export JSON is too large.');
    return serialized;
  }

  async importPortableExport(value: unknown, options: PortableImportOptions = {}): Promise<PortableImportResult> {
    const serializedSize = Buffer.byteLength(JSON.stringify(value));
    if (serializedSize > PORTABLE_EXPORT_LIMITS.jsonBytes) throw new Error('Portable export JSON is too large.');
    const validated = validatePortableFile(value);
    const mode = options.mode ?? 'merge';
    if (mode !== 'merge' && mode !== 'replace') throw new Error('Portable import mode must be merge or replace.');
    const resultingCards = mode === 'replace'
      ? new Map<string, CardDefinition>()
      : new Map(this.listCards().map((card) => [card.id, card]));
    for (const record of validated.file.cards) resultingCards.set(record.card.id, record.card);
    if ([...resultingCards.values()].filter(isEnabledStandard).length < MINIMUM_STANDARD_CARDS) {
      throw new Error(`Import requires at least ${MINIMUM_STANDARD_CARDS} enabled Standard cards for four-player Balanced games.`);
    }
    const recoveryRoot = resolve(options.recoveryDirectory
      ?? process.env.GAME_BACKUP_DIR
      ?? `${this.dataDirectory}-backups`);
    const recovery = await createConsistentBackup(this.dataDirectory, recoveryRoot, 'pre-import');
    const importedMediaRows: Array<{ media: PortableMediaRecord; relativePath: string }> = [];
    const createdMediaPaths = new Set<string>();
    const previousMediaPaths = mode === 'replace'
      ? new Set((this.database.prepare('SELECT DISTINCT relative_path FROM media').all() as Array<{ relative_path: string }>)
        .map((row) => row.relative_path))
      : new Set<string>();
    try {
      for (const media of validated.file.media) {
        const existing = this.getMediaRecord(media.id);
        if (mode === 'merge' && existing && (
          existing.sha256 !== media.sha256
          || existing.mimeType !== media.mimeType
          || existing.width !== media.width
          || existing.height !== media.height
          || existing.byteSize !== media.byteSize
        )) throw new Error(`Media id collision for ${media.id}.`);

        const bytes = validated.mediaBytes.get(media.id);
        if (!bytes) throw new Error(`Validated media bytes are missing for ${media.id}.`);
        const relativePath = relativeMediaPath(media.sha256, media.mimeType);
        const target = ensurePathWithoutSymlinks(this.dataDirectory, join(this.dataDirectory, relativePath));
        ensurePrivateDirectory(dirname(target));
        if (!existsSync(target)) {
          const temporary = ensureWithin(this.dataDirectory, join(this.dataDirectory, 'media', '.tmp', randomUUID()));
          writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
          try {
            renameSync(temporary, target);
            createdMediaPaths.add(target);
            chmodSync(target, 0o600);
          } catch (error) {
            rmSync(temporary, { force: true });
            throw error;
          }
        } else {
          const stat = lstatSync(target);
          if (!stat.isFile() || stat.isSymbolicLink() || hashFile(target) !== media.sha256) {
            throw new Error(`Content-addressed media collision for ${media.id}.`);
          }
        }
        importedMediaRows.push({ media, relativePath });
      }

      this.database.exec('BEGIN IMMEDIATE');
      try {
        if (mode === 'replace') this.database.exec('DELETE FROM room_checkpoint; DELETE FROM matches; DELETE FROM cards; DELETE FROM media;');
        const mediaStatement = this.database.prepare(`
          INSERT INTO media (id, relative_path, mime_type, width, height, byte_size, sha256, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            relative_path = excluded.relative_path,
            mime_type = excluded.mime_type,
            width = excluded.width,
            height = excluded.height,
            byte_size = excluded.byte_size,
            sha256 = excluded.sha256,
            created_at = excluded.created_at
        `);
        for (const { media, relativePath } of importedMediaRows) {
          mediaStatement.run(media.id, relativePath, media.mimeType, media.width, media.height, media.byteSize, media.sha256, media.createdAt);
        }

        const cardStatement = this.database.prepare(`
          INSERT INTO cards (id, payload, revision, origin, builtin_hash, updated_at)
          VALUES (?, ?, ?, 'imported', NULL, ?)
          ON CONFLICT(id) DO UPDATE SET
            payload = excluded.payload,
            revision = cards.revision + 1,
            origin = 'imported',
            builtin_hash = NULL,
            updated_at = excluded.updated_at
        `);
        for (const card of validated.file.cards) cardStatement.run(card.card.id, JSON.stringify(card.card), card.revision, card.updatedAt);

        const matchStatement = this.database.prepare(`
          INSERT OR IGNORE INTO matches
          (id, seed, mode, playlist, rounds, winner_ids, fighter_ids, card_snapshots, initial_battle, round_actions, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const match of validated.file.matches) {
          matchStatement.run(
            match.id,
            match.seed,
            match.mode,
            match.playlist,
            match.rounds,
            JSON.stringify(match.winnerIds),
            JSON.stringify(match.fighterIds),
            JSON.stringify(match.initialBattle
              ? Object.values(match.initialBattle.fighters).map((fighter) => fighter.card)
              : []),
            JSON.stringify(match.initialBattle),
            JSON.stringify(match.roundActions),
            match.createdAt,
          );
        }
        this.database.exec('COMMIT');
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      }
    } catch (error) {
      for (const path of createdMediaPaths) rmSync(path, { force: true });
      throw error;
    }

    if (mode === 'replace') {
      const retainedPaths = new Set(importedMediaRows.map((row) => row.relativePath));
      const referenceCount = this.database.prepare('SELECT COUNT(*) AS count FROM media WHERE relative_path = ?');
      for (const relativePath of previousMediaPaths) {
        if (retainedPaths.has(relativePath) || !safeRelativePath(relativePath)) continue;
        const referenced = referenceCount.get(relativePath) as { count: number };
        if (referenced.count > 0) continue;
        const path = ensurePathWithoutSymlinks(this.dataDirectory, join(this.dataDirectory, relativePath));
        if (existsSync(path)) unlinkSync(path);
      }
    }
    hardenSqliteFiles(this.dataDirectory);
    return {
      cardsImported: validated.file.cards.length,
      matchesImported: validated.file.matches.length,
      mediaImported: validated.file.media.length,
      recoveryPath: recovery.path,
    };
  }

  close(): void {
    hardenSqliteFiles(this.dataDirectory);
    this.database.close();
  }
}
