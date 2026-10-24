import type {
  ActionChoice,
  BattleEvent,
  BattleState,
  CardDefinition,
  GameMode,
  Playlist,
} from '../engine/types.js';

export type TimedGamePhase = 'draft' | 'reveal' | 'planning' | 'resolution';
export type GamePhase = 'lobby' | TimedGamePhase | 'paused' | 'finished';

export interface RoomConfig {
  mode: GameMode;
  playlist: Playlist;
}

export interface PublicPlayer {
  id: string;
  name: string;
  color: string;
  connected: boolean;
  spectator: boolean;
  isBot: boolean;
  isHost: boolean;
  teamId: string | null;
  fighterId: string | null;
  locked: boolean;
}

export interface TeamIntent {
  playerId: string;
  abilityId: string;
  targetIds: string[];
  locked: boolean;
}

export interface ClientSnapshot {
  roomCode: string;
  joinUrls: string[];
  phase: GamePhase;
  config: RoomConfig;
  players: PublicPlayer[];
  selfId: string | null;
  serverTime: number;
  deadline: number | null;
  draftOptions: CardDefinition[] | null;
  selectedFighterId: string | null;
  cursedHijack: boolean;
  battle: BattleState | null;
  lastEvents: BattleEvent[];
  resolutionReadyPlayerIds: string[];
  intents: TeamIntent[];
  matchId: string | null;
  resumePhase: TimedGamePhase | null;
  error: string | null;
}

export type ClientMessage =
  | { type: 'join'; nickname: string; color: string; spectator?: boolean }
  | { type: 'configure'; config: RoomConfig }
  | { type: 'add-bot' }
  | { type: 'remove-bot'; playerId: string }
  | { type: 'remove-player'; playerId: string }
  | { type: 'switch-team'; playerId: string }
  | { type: 'start' }
  | { type: 'select-fighter'; matchId: string; fighterId: string }
  | { type: 'choose-action'; matchId: string; round: number; action: Omit<ActionChoice, 'actorId'> }
  | { type: 'lock-action'; matchId: string; round: number }
  | { type: 'ready-resolution'; matchId: string; round: number }
  | { type: 'resume' }
  | { type: 'rematch' }
  | { type: 'ping'; sentAt: number };

export type ServerMessage =
  | { type: 'welcome'; token: string; playerId: string | null }
  | { type: 'state'; state: ClientSnapshot }
  | { type: 'pong'; sentAt: number; serverTime: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isShortString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && [...value].length <= maximum;
}

function isMatchId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9A-F]{8}$/.test(value);
}

function isRound(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 12;
}

export function isClientMessage(value: unknown): value is ClientMessage {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  switch (value.type) {
    case 'join':
      return isShortString(value.nickname, 80)
        && isShortString(value.color, 16)
        && (value.spectator === undefined || typeof value.spectator === 'boolean');
    case 'configure':
      return isRecord(value.config)
        && typeof value.config.mode === 'string'
        && ['duel', 'ffa', 'teams'].includes(value.config.mode)
        && typeof value.config.playlist === 'string'
        && ['balanced', 'party'].includes(value.config.playlist);
    case 'add-bot':
    case 'start':
    case 'resume':
    case 'rematch':
      return true;
    case 'remove-bot':
    case 'remove-player':
    case 'switch-team':
      return isShortString(value.playerId, 80) && value.playerId.length > 0;
    case 'select-fighter':
      return isMatchId(value.matchId)
        && isShortString(value.fighterId, 40)
        && value.fighterId.length > 0;
    case 'choose-action':
      return isMatchId(value.matchId)
        && isRound(value.round)
        && isRecord(value.action)
        && isShortString(value.action.abilityId, 64)
        && value.action.abilityId.length > 0
        && Array.isArray(value.action.targetIds)
        && value.action.targetIds.length <= 4
        && value.action.targetIds.every((target) => isShortString(target, 80) && target.length > 0);
    case 'lock-action':
    case 'ready-resolution':
      return isMatchId(value.matchId) && isRound(value.round);
    case 'ping':
      return typeof value.sentAt === 'number' && Number.isFinite(value.sentAt);
    default:
      return false;
  }
}
