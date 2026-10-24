import type { ActionChoice, BattleState, CardDefinition, GameMode, Playlist } from '../engine/types.js';

export const PORTABLE_EXPORT_FORMAT = 'house-fight-portable' as const;
export const PORTABLE_EXPORT_VERSION = 1 as const;

export const PORTABLE_EXPORT_LIMITS = {
  cards: 500,
  matches: 50_000,
  mediaFiles: 500,
  mediaFileBytes: 10 * 1024 * 1024,
  totalMediaBytes: 100 * 1024 * 1024,
  jsonBytes: 140 * 1024 * 1024,
} as const;

export type PortableCardOrigin = 'builtin' | 'custom' | 'imported' | 'legacy';

export interface PortableCardRecord {
  card: CardDefinition;
  revision: number;
  origin: PortableCardOrigin;
  updatedAt: string;
}

export interface PortableMatchRecord {
  id: string;
  seed: number;
  mode: GameMode;
  playlist: Playlist;
  rounds: number;
  winnerIds: string[];
  fighterIds: string[];
  /** Null only for match rows created before deterministic replay history existed. */
  initialBattle: BattleState | null;
  roundActions: ActionChoice[][];
  createdAt: string;
}

export interface PortableMediaRecord {
  id: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  width: number;
  height: number;
  byteSize: number;
  sha256: string;
  dataBase64: string;
  createdAt: string;
}

export interface PortableExportPayload {
  format: typeof PORTABLE_EXPORT_FORMAT;
  version: typeof PORTABLE_EXPORT_VERSION;
  appVersion: string;
  exportedAt: string;
  includesMatches: boolean;
  cards: PortableCardRecord[];
  matches: PortableMatchRecord[];
  media: PortableMediaRecord[];
}

export interface PortableExportFile extends PortableExportPayload {
  /** SHA-256 of the canonical JSON representation of PortableExportPayload. */
  checksum: string;
}

export type PortableImportMode = 'merge' | 'replace';

export interface PortableImportOptions {
  mode?: PortableImportMode;
  /** Directory for the automatic pre-import recovery snapshot. */
  recoveryDirectory?: string;
}

export interface PortableImportResult {
  cardsImported: number;
  matchesImported: number;
  mediaImported: number;
  recoveryPath: string;
}
