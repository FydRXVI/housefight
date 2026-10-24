import { randomInt, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { chooseBotAction } from '../engine/bots.js';
import { createDraft } from '../engine/draft.js';
import { createBattle, eligibleTargets, getAbilityAvailability, resolveRound } from '../engine/engine.js';
import { SeededRng } from '../engine/rng.js';
import type { ActionChoice, BattleEvent, BattleState, CardDefinition } from '../engine/types.js';
import { isCardDefinition } from '../shared/card-validation.js';
import type {
  ClientMessage,
  ClientSnapshot,
  GamePhase,
  PublicPlayer,
  RoomConfig,
  ServerMessage,
  TeamIntent,
  TimedGamePhase,
} from '../shared/protocol.js';
import { isClientMessage } from '../shared/protocol.js';
import type { GameStore } from './storage.js';

const ROOM_CODE = 'HOUSE';
const MAX_ACTIVE_PLAYERS = 4;
const MAX_SPECTATORS = 32;
const DRAFT_DURATION = 30_000;
const REVEAL_DURATION = 4_200;
const PLANNING_DURATION = 12_000;
const RESOLUTION_DURATION = 12_000;
const COLORS = ['#b7ff38', '#ff6f61', '#52e7ea', '#9b82ff', '#ffd84d', '#ff4db8'];
const BOT_NAMES = ['Mischief.exe', 'AuntieBot', 'Wi-Fi Thief', 'Chairperson'];

interface RoomPlayer {
  id: string;
  token: string;
  name: string;
  color: string;
  connected: boolean;
  spectator: boolean;
  isBot: boolean;
  teamId: 'team-a' | 'team-b' | null;
}

interface ClientConnection {
  token: string;
  playerId: string | null;
  role: 'player' | 'arena';
  error: string | null;
}

interface PendingAction {
  action: ActionChoice;
  locked: boolean;
}

interface RoomCheckpoint {
  version: 1;
  savedAt: number;
  phase: GamePhase;
  resumePhase: TimedGamePhase | null;
  remainingMs: number | null;
  config: RoomConfig;
  players: RoomPlayer[];
  hostId: string | null;
  draftOptions: Array<[string, CardDefinition[]]>;
  selections: Array<[string, string]>;
  cursedPlayerId: string | null;
  battle: BattleState | null;
  initialBattle: BattleState | null;
  actions: Array<[string, PendingAction]>;
  lastEvents: BattleEvent[];
  /** Optional so checkpoints created before the ready button remain recoverable. */
  resolutionReadyPlayerIds?: string[];
  matchId: string | null;
  matchSeed: number;
  roundActions: ActionChoice[][];
}

const TIMED_PHASES = new Set<TimedGamePhase>(['draft', 'reveal', 'planning', 'resolution']);
const GAME_PHASES = new Set<GamePhase>(['lobby', 'draft', 'reveal', 'planning', 'resolution', 'paused', 'finished']);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MATCH_ID = /^[0-9A-F]{8}$/;
const STATUS_KINDS = new Set([
  'damage-up',
  'damage-down',
  'vulnerable',
  'resistant',
  'dodge',
  'reflect',
  'taunt',
  'dot',
  'hot',
  'empowered',
  'disabled',
]);
const EVENT_TYPES = new Set(['round', 'ability', 'damage', 'heal', 'shield', 'status', 'miss', 'ko', 'system']);
const EVENT_TONES = new Set(['neutral', 'attack', 'defence', 'heal', 'danger', 'ko', 'special']);
const MAX_CHECKPOINT_PLAYERS = MAX_ACTIVE_PLAYERS + MAX_SPECTATORS;
const MAX_CHECKPOINT_EVENTS = 512;
const MAX_CHECKPOINT_ROUNDS = 12;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedText(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === 'string' && [...value].length >= minimum && [...value].length <= maximum;
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function isRoomPlayer(value: unknown): value is RoomPlayer {
  return isRecord(value)
    && typeof value.id === 'string'
    && UUID_V4.test(value.id)
    && typeof value.token === 'string'
    && UUID_V4.test(value.token)
    && isBoundedText(value.name, 1, 80)
    && typeof value.color === 'string'
    && /^#[\da-f]{6}$/i.test(value.color)
    && typeof value.connected === 'boolean'
    && typeof value.spectator === 'boolean'
    && typeof value.isBot === 'boolean'
    && (value.teamId === null || value.teamId === 'team-a' || value.teamId === 'team-b')
    && (!value.spectator || (!value.isBot && value.teamId === null))
    && (value.spectator || value.teamId !== null)
    && (!value.isBot || value.connected);
}

function isBattleState(
  value: unknown,
  players: RoomPlayer[],
  selections: Map<string, string>,
  mode: RoomConfig['mode'],
): value is BattleState {
  if (!isRecord(value)
    || !isIntegerInRange(value.seed, 1, 2_147_483_646)
    || !isIntegerInRange(value.rngState, 0, 4_294_967_295)
    || value.mode !== mode
    || !isIntegerInRange(value.round, 1, MAX_CHECKPOINT_ROUNDS)
    || typeof value.finished !== 'boolean'
    || !isRecord(value.fighters)) return false;

  const activePlayers = players.filter((player) => !player.spectator);
  const activeById = new Map(activePlayers.map((player) => [player.id, player]));
  const fighterEntries = Object.entries(value.fighters);
  if (fighterEntries.length !== activePlayers.length
    || fighterEntries.length < 2
    || fighterEntries.length > MAX_ACTIVE_PLAYERS
    || fighterEntries.some(([id]) => !activeById.has(id))) return false;
  const fighterIds = new Set(fighterEntries.map(([id]) => id));

  for (const [id, fighter] of fighterEntries) {
    if (!isRecord(fighter)
      || fighter.id !== id
      || !isBoundedText(fighter.name, 1, 80)
      || typeof fighter.teamId !== 'string'
      || !isCardDefinition(fighter.card)
      || typeof fighter.hp !== 'number'
      || !Number.isFinite(fighter.hp)
      || fighter.hp < 0
      || fighter.hp > fighter.card.hp
      || typeof fighter.shield !== 'number'
      || !Number.isFinite(fighter.shield)
      || fighter.shield < 0
      || fighter.shield > 100_000
      || !Array.isArray(fighter.statuses)
      || fighter.statuses.length > 64
      || !isRecord(fighter.cooldowns)
      || !Array.isArray(fighter.usedAbilities)
      || !Array.isArray(fighter.damagedByLastRound)) return false;

    const player = activeById.get(id);
    if (!player
      || fighter.name !== player.name
      || selections.get(id) !== fighter.card.id
      || (mode === 'teams' ? fighter.teamId !== player.teamId : fighter.teamId !== id)) return false;

    const abilityIds = new Set(fighter.card.abilities.map((ability) => ability.id));
    if (!fighter.statuses.every((status) => isRecord(status)
      && isBoundedText(status.id, 1, 160)
      && typeof status.kind === 'string'
      && STATUS_KINDS.has(status.kind)
      && isBoundedText(status.label, 1, 80)
      && isIntegerInRange(status.duration, 1, 24)
      && (status.value === undefined
        || (typeof status.value === 'number' && Number.isFinite(status.value) && status.value >= 0 && status.value <= 500))
      && (status.abilityId === undefined || (typeof status.abilityId === 'string' && abilityIds.has(status.abilityId)))
      && typeof status.sourceId === 'string'
      && fighterIds.has(status.sourceId))) return false;

    const cooldowns = Object.entries(fighter.cooldowns);
    if (cooldowns.length > fighter.card.abilities.length
      || !cooldowns.every(([abilityId, duration]) => abilityIds.has(abilityId) && isIntegerInRange(duration, 0, 12))) return false;
    if (fighter.usedAbilities.length > fighter.card.abilities.length
      || new Set(fighter.usedAbilities).size !== fighter.usedAbilities.length
      || !fighter.usedAbilities.every((abilityId) => typeof abilityId === 'string' && abilityIds.has(abilityId))) return false;
    if (fighter.damagedByLastRound.length > MAX_ACTIVE_PLAYERS
      || new Set(fighter.damagedByLastRound).size !== fighter.damagedByLastRound.length
      || !fighter.damagedByLastRound.every((attackerId) => typeof attackerId === 'string' && fighterIds.has(attackerId))) return false;
  }

  if (value.winnerPlayerIds !== null
    && (!Array.isArray(value.winnerPlayerIds)
      || value.winnerPlayerIds.length > MAX_ACTIVE_PLAYERS
      || new Set(value.winnerPlayerIds).size !== value.winnerPlayerIds.length
      || !value.winnerPlayerIds.every((id) => typeof id === 'string' && fighterIds.has(id)))) return false;
  return value.finished ? value.winnerPlayerIds !== null : value.winnerPlayerIds === null;
}

function isActionChoice(value: unknown, battle: BattleState): value is ActionChoice {
  if (!isRecord(value)
    || typeof value.actorId !== 'string'
    || typeof value.abilityId !== 'string'
    || !Array.isArray(value.targetIds)
    || value.targetIds.length > MAX_ACTIVE_PLAYERS
    || !value.targetIds.every((targetId) => typeof targetId === 'string' && battle.fighters[targetId])) return false;
  const actor = battle.fighters[value.actorId];
  return Boolean(actor?.card.abilities.some((ability) => ability.id === value.abilityId));
}

function isBattleEvent(value: unknown, fighterIds: Set<string>): value is BattleEvent {
  return isRecord(value)
    && isBoundedText(value.id, 1, 160)
    && typeof value.type === 'string'
    && EVENT_TYPES.has(value.type)
    && isBoundedText(value.message, 1, 1_000)
    && typeof value.tone === 'string'
    && EVENT_TONES.has(value.tone)
    && (value.actorId === undefined || (typeof value.actorId === 'string' && fighterIds.has(value.actorId)))
    && (value.targetId === undefined || (typeof value.targetId === 'string' && fighterIds.has(value.targetId)))
    && (value.amount === undefined
      || (typeof value.amount === 'number' && Number.isFinite(value.amount) && value.amount >= 0 && value.amount <= 100_000));
}

function isRoomCheckpoint(value: unknown): value is RoomCheckpoint {
  if (!isRecord(value)
    || value.version !== 1
    || typeof value.savedAt !== 'number'
    || !Number.isFinite(value.savedAt)
    || value.savedAt < 0
    || typeof value.phase !== 'string'
    || !GAME_PHASES.has(value.phase as GamePhase)
    || !isRecord(value.config)
    || !Array.isArray(value.players)
    || value.players.length > MAX_CHECKPOINT_PLAYERS
    || !Array.isArray(value.draftOptions)
    || !Array.isArray(value.selections)
    || !Array.isArray(value.actions)
    || !Array.isArray(value.lastEvents)
    || value.lastEvents.length > MAX_CHECKPOINT_EVENTS
    || !Array.isArray(value.roundActions)
    || value.roundActions.length > MAX_CHECKPOINT_ROUNDS
    || !isIntegerInRange(value.matchSeed, 1, 2_147_483_646)) return false;

  const phase = value.phase as GamePhase;
  const resumePhase = value.resumePhase;
  const remainingMs = value.remainingMs;
  if (resumePhase !== null && (typeof resumePhase !== 'string' || !TIMED_PHASES.has(resumePhase as TimedGamePhase))) return false;
  if (remainingMs !== null && !isIntegerInRange(remainingMs, 0, 86_400_000)) return false;
  if (phase === 'paused') {
    if (resumePhase === null || remainingMs === null) return false;
  } else if (TIMED_PHASES.has(phase as TimedGamePhase)) {
    if (resumePhase !== null || remainingMs === null) return false;
  } else if (resumePhase !== null || remainingMs !== null) return false;

  if (typeof value.config.mode !== 'string'
    || !['duel', 'ffa', 'teams'].includes(value.config.mode)
    || typeof value.config.playlist !== 'string'
    || !['balanced', 'party'].includes(value.config.playlist)) return false;
  const config = value.config as unknown as RoomConfig;

  const players = value.players;
  if (!players.every(isRoomPlayer)) return false;
  const playerIds = players.map((player) => player.id);
  const playerTokens = players.map((player) => player.token);
  if (new Set(playerIds).size !== playerIds.length || new Set(playerTokens).size !== playerTokens.length) return false;
  const activePlayers = players.filter((player) => !player.spectator);
  const activeIds = new Set(activePlayers.map((player) => player.id));
  if (activePlayers.length > MAX_ACTIVE_PLAYERS) return false;
  if (value.hostId !== null
    && (typeof value.hostId !== 'string'
      || !activePlayers.some((player) => player.id === value.hostId && !player.isBot))) return false;

  const resolutionReadyPlayerIds = value.resolutionReadyPlayerIds ?? [];
  if (!Array.isArray(resolutionReadyPlayerIds)
    || resolutionReadyPlayerIds.length > activePlayers.length
    || new Set(resolutionReadyPlayerIds).size !== resolutionReadyPlayerIds.length
    || !resolutionReadyPlayerIds.every((id) => typeof id === 'string'
      && activePlayers.some((player) => player.id === id && !player.isBot))) return false;

  const draftMap = new Map<string, CardDefinition[]>();
  const allDraftCardIds = new Set<string>();
  for (const entry of value.draftOptions) {
    if (!Array.isArray(entry)
      || entry.length !== 2
      || typeof entry[0] !== 'string'
      || !activeIds.has(entry[0])
      || draftMap.has(entry[0])
      || !Array.isArray(entry[1])
      || entry[1].length < 1
      || entry[1].length > 3
      || !entry[1].every(isCardDefinition)) return false;
    for (const card of entry[1]) {
      if (allDraftCardIds.has(card.id)) return false;
      allDraftCardIds.add(card.id);
    }
    draftMap.set(entry[0], entry[1]);
  }

  const selections = new Map<string, string>();
  for (const entry of value.selections) {
    if (!Array.isArray(entry)
      || entry.length !== 2
      || typeof entry[0] !== 'string'
      || typeof entry[1] !== 'string'
      || !activeIds.has(entry[0])
      || selections.has(entry[0])
      || !draftMap.get(entry[0])?.some((card) => card.id === entry[1])) return false;
    selections.set(entry[0], entry[1]);
  }

  if (value.cursedPlayerId !== null
    && (typeof value.cursedPlayerId !== 'string' || !activeIds.has(value.cursedPlayerId))) return false;
  if (value.matchId !== null && (typeof value.matchId !== 'string' || !MATCH_ID.test(value.matchId))) return false;

  const effectivePhase = phase === 'paused' ? resumePhase as TimedGamePhase : phase;
  if (effectivePhase !== 'resolution' && resolutionReadyPlayerIds.length > 0) return false;
  if (effectivePhase === 'lobby') {
    if (draftMap.size !== 0
      || selections.size !== 0
      || value.cursedPlayerId !== null
      || value.matchId !== null) return false;
  } else {
    if (value.matchId === null || draftMap.size !== activePlayers.length) return false;
    if (config.mode === 'duel' && activePlayers.length !== 2) return false;
    if (config.mode === 'ffa' && (activePlayers.length < 3 || activePlayers.length > 4)) return false;
    if (config.mode === 'teams'
      && (activePlayers.length !== 4
        || activePlayers.filter((player) => player.teamId === 'team-a').length !== 2)) return false;
  }

  if (effectivePhase !== 'lobby' && effectivePhase !== 'draft' && selections.size !== activePlayers.length) return false;
  const battle = value.battle === null ? null : value.battle;
  const initialBattle = value.initialBattle === null ? null : value.initialBattle;
  if (battle !== null && !isBattleState(battle, players, selections, config.mode)) return false;
  if (initialBattle !== null && !isBattleState(initialBattle, players, selections, config.mode)) return false;

  const battleRequired = effectivePhase === 'reveal'
    || effectivePhase === 'planning'
    || effectivePhase === 'resolution'
    || effectivePhase === 'finished';
  if (battleRequired !== (battle !== null && initialBattle !== null)) return false;
  if (!battleRequired && (battle !== null || initialBattle !== null)) return false;
  if (battle && initialBattle) {
    if (battle.seed !== value.matchSeed
      || initialBattle.seed !== value.matchSeed
      || initialBattle.round !== 1
      || initialBattle.finished
      || initialBattle.winnerPlayerIds !== null
      || Object.values(initialBattle.fighters).some((fighter) => fighter.hp !== fighter.card.hp
        || fighter.shield !== 0
        || fighter.statuses.length !== 0
        || Object.keys(fighter.cooldowns).length !== 0
        || fighter.usedAbilities.length !== 0
        || fighter.damagedByLastRound.length !== 0)) return false;
    if (effectivePhase === 'finished' ? !battle.finished : effectivePhase !== 'resolution' && battle.finished) return false;
  }

  if (value.actions.length > activePlayers.length) return false;
  const actionActors = new Set<string>();
  for (const entry of value.actions) {
    if (!battle
      || !Array.isArray(entry)
      || entry.length !== 2
      || typeof entry[0] !== 'string'
      || actionActors.has(entry[0])
      || !isRecord(entry[1])
      || typeof entry[1].locked !== 'boolean'
      || !isActionChoice(entry[1].action, battle)
      || entry[1].action.actorId !== entry[0]) return false;
    actionActors.add(entry[0]);
  }

  if (!battle && value.roundActions.length > 0) return false;
  for (const round of value.roundActions) {
    if (!battle || !Array.isArray(round) || round.length > activePlayers.length) return false;
    const actors = new Set<string>();
    for (const action of round) {
      if (!isActionChoice(action, battle) || actors.has(action.actorId)) return false;
      actors.add(action.actorId);
    }
  }

  const fighterIds = new Set(Object.keys(battle?.fighters ?? {}));
  if ((!battle && value.lastEvents.length > 0)
    || !value.lastEvents.every((event) => isBattleEvent(event, fighterIds))) return false;
  const eventIds = value.lastEvents.map((event) => event.id);
  if (new Set(eventIds).size !== eventIds.length) return false;

  if ((effectivePhase === 'lobby' || effectivePhase === 'draft')
    && (value.actions.length > 0 || value.lastEvents.length > 0 || value.roundActions.length > 0)) return false;
  if (effectivePhase === 'reveal' && value.actions.length > 0) return false;
  return true;
}

function safeName(value: string): string {
  const normalized = value.normalize('NFC');
  const safe = [...normalized]
    .filter((character) => character !== '<'
      && character !== '>'
      && character.charCodeAt(0) >= 32
      && !/[\u202a-\u202e\u2066-\u2069]/u.test(character))
    .join('')
    .trim();
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(safe)]
    .map((segment) => segment.segment);
  return graphemes.slice(0, 20).join('') || 'Mystery Guest';
}

function validColor(value: string): string {
  return /^#[\da-f]{6}$/i.test(value) ? value : COLORS[0] as string;
}

export class GameRoom {
  private readonly clients = new Map<WebSocket, ClientConnection>();
  private readonly players: RoomPlayer[] = [];
  private config: RoomConfig = { mode: 'duel', playlist: 'balanced' };
  private phase: GamePhase = 'lobby';
  private hostId: string | null = null;
  private deadline: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private draftOptions = new Map<string, CardDefinition[]>();
  private selections = new Map<string, string>();
  private cursedPlayerId: string | null = null;
  private battle: BattleState | null = null;
  private initialBattle: BattleState | null = null;
  private actions = new Map<string, PendingAction>();
  private lastEvents: BattleEvent[] = [];
  private resolutionReady = new Set<string>();
  private matchId: string | null = null;
  private matchSeed = 1;
  private resumePhase: TimedGamePhase | null = null;
  private resumeRemainingMs = 0;
  private roundActions: ActionChoice[][] = [];

  constructor(private readonly store: GameStore, private readonly joinUrls: string[] = []) {
    this.restoreCheckpoint();
  }

  attach(socket: WebSocket, token: string | null, role: 'player' | 'arena'): void {
    const existing = role === 'player' && token
      ? this.players.find((player) => player.token === token)
      : undefined;
    const connection: ClientConnection = {
      token: existing?.token ?? randomUUID(),
      playerId: existing?.id ?? null,
      role,
      error: null,
    };
    this.clients.set(socket, connection);
    if (existing && role === 'player') {
      existing.connected = true;
      if (!existing.spectator && (this.hostId === null || !this.isPlayerConnected(this.hostId))) {
        this.hostId = existing.id;
      }
    }
    this.persistCheckpoint();
    this.send(socket, { type: 'welcome', token: connection.token, playerId: connection.playerId });
    this.sendState(socket);

    socket.on('message', (raw) => {
      const payload = Array.isArray(raw)
        ? Buffer.concat(raw)
        : Buffer.isBuffer(raw)
          ? raw
          : Buffer.from(raw);
      if (payload.byteLength > 16_384) {
        socket.close(1009, 'Message too large');
        return;
      }
      try {
        const parsed: unknown = JSON.parse(payload.toString('utf8'));
        if (!isClientMessage(parsed)) throw new Error('Unknown message.');
        this.handle(socket, parsed);
      } catch (error) {
        connection.error = error instanceof Error ? error.message : 'Invalid message.';
        this.sendState(socket);
      }
    });

    socket.on('close', () => {
      this.clients.delete(socket);
      const player = this.playerFor(connection);
      const playerStillConnected = player ? this.isPlayerConnected(player.id) : false;
      if (player && !player.isBot && !playerStillConnected) player.connected = false;
      if (player?.id === this.hostId && !player.connected) {
        this.electHost();
      }
      const disconnectedActiveHuman = player
        && !player.isBot
        && !player.spectator
        && !player.connected;
      if (disconnectedActiveHuman && !this.hasConnectedHumanPlayer()) {
        this.pauseTimedPhase();
      }
      if (player?.spectator && !playerStillConnected) {
        const spectatorIndex = this.players.findIndex((candidate) => candidate.id === player.id);
        if (spectatorIndex >= 0) this.players.splice(spectatorIndex, 1);
      }
      this.persistCheckpoint();
      this.broadcast();
    });
  }

  shutdown(): void {
    if (!this.pauseTimedPhase() && this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const player of this.players) {
      if (!player.isBot) player.connected = false;
    }
    this.persistCheckpoint();
    for (const socket of this.clients.keys()) socket.close(1001, 'Server shutting down');
  }

  private handle(socket: WebSocket, message: ClientMessage): void {
    const connection = this.clients.get(socket);
    if (!connection) return;
    connection.error = null;
    if (connection.role === 'arena' && message.type !== 'ping') {
      throw new Error('Arena connections are display-only.');
    }

    switch (message.type) {
      case 'join':
        this.join(connection, message.nickname, message.color, message.spectator ?? false);
        break;
      case 'configure':
        this.configure(connection, message.config);
        break;
      case 'add-bot':
        this.addBot(connection);
        break;
      case 'remove-bot':
        this.removeBot(connection, message.playerId);
        break;
      case 'remove-player':
        this.removePlayer(connection, message.playerId);
        break;
      case 'switch-team':
        this.switchTeam(connection, message.playerId);
        break;
      case 'start':
        this.startDraft(connection);
        break;
      case 'select-fighter':
        this.selectFighter(connection, message.matchId, message.fighterId);
        break;
      case 'choose-action':
        this.chooseAction(connection, message.matchId, message.round, message.action);
        break;
      case 'lock-action':
        this.lockAction(connection, message.matchId, message.round);
        break;
      case 'ready-resolution':
        this.readyResolution(connection, message.matchId, message.round);
        break;
      case 'resume':
        this.resumeMatch(connection);
        break;
      case 'rematch':
        this.rematch(connection);
        break;
      case 'ping':
        this.send(socket, { type: 'pong', sentAt: message.sentAt, serverTime: Date.now() });
        return;
    }
    this.persistCheckpoint();
    this.broadcast();
  }

  private playerFor(connection: ClientConnection): RoomPlayer | undefined {
    return connection.playerId ? this.players.find((player) => player.id === connection.playerId) : undefined;
  }

  private requireCurrentMatch(matchId: string): void {
    if (!this.matchId || matchId !== this.matchId) throw new Error('Stale match command ignored.');
  }

  private requireCurrentRound(matchId: string, round: number): BattleState {
    this.requireCurrentMatch(matchId);
    if (!this.battle || round !== this.battle.round) throw new Error('Stale round command ignored.');
    return this.battle;
  }

  private activePlayers(): RoomPlayer[] {
    return this.players.filter((player) => !player.spectator);
  }

  private isPlayerConnected(playerId: string): boolean {
    return [...this.clients.values()].some((connection) => connection.role === 'player' && connection.playerId === playerId);
  }

  private hasConnectedHumanPlayer(): boolean {
    return this.activePlayers().some((player) => !player.isBot
      && player.connected
      && this.isPlayerConnected(player.id));
  }

  private pauseTimedPhase(): boolean {
    if (!TIMED_PHASES.has(this.phase as TimedGamePhase) || this.deadline === null) return false;
    if (this.timer) clearTimeout(this.timer);
    this.resumePhase = this.phase as TimedGamePhase;
    this.resumeRemainingMs = Math.max(750, this.deadline - Date.now());
    this.phase = 'paused';
    this.deadline = null;
    this.timer = null;
    return true;
  }

  private electHost(): void {
    this.hostId = this.activePlayers().find((candidate) => !candidate.isBot && candidate.connected)?.id ?? null;
  }

  private requireHost(connection: ClientConnection): RoomPlayer {
    const player = this.playerFor(connection);
    if (!player || player.id !== this.hostId) throw new Error('Only the host can do that.');
    return player;
  }

  private join(connection: ClientConnection, nickname: string, color: string, spectator: boolean): void {
    if (connection.playerId) return;
    if (this.phase !== 'lobby' && !spectator) throw new Error('A match is already in progress. Join as a spectator.');
    if (spectator && this.players.filter((player) => player.spectator && player.connected).length >= MAX_SPECTATORS) {
      throw new Error('The spectator gallery is full.');
    }
    if (!spectator && this.activePlayers().length >= MAX_ACTIVE_PLAYERS) throw new Error('The active roster is full.');
    const activeCount = this.activePlayers().length;
    const player: RoomPlayer = {
      id: randomUUID(),
      token: connection.token,
      name: safeName(nickname),
      color: validColor(color),
      connected: true,
      spectator,
      isBot: false,
      teamId: spectator ? null : activeCount % 2 === 0 ? 'team-a' : 'team-b',
    };
    this.players.push(player);
    connection.playerId = player.id;
    if (!spectator && !this.hostId) this.hostId = player.id;
  }

  private configure(connection: ClientConnection, config: RoomConfig): void {
    this.requireHost(connection);
    if (this.phase !== 'lobby') throw new Error('Settings are locked during a match.');
    if (!['duel', 'ffa', 'teams'].includes(config.mode)) throw new Error('Invalid game mode.');
    if (!['balanced', 'party'].includes(config.playlist)) throw new Error('Invalid playlist.');
    this.config = { mode: config.mode, playlist: config.playlist };
  }

  private addBot(connection: ClientConnection): void {
    this.requireHost(connection);
    if (this.phase !== 'lobby') throw new Error('Bots can only join in the lobby.');
    if (this.activePlayers().length >= MAX_ACTIVE_PLAYERS) throw new Error('The active roster is full.');
    const botIndex = this.players.filter((player) => player.isBot).length;
    const activeCount = this.activePlayers().length;
    this.players.push({
      id: randomUUID(),
      token: randomUUID(),
      name: BOT_NAMES[botIndex % BOT_NAMES.length] as string,
      color: COLORS[(this.players.length + 1) % COLORS.length] as string,
      connected: true,
      spectator: false,
      isBot: true,
      teamId: activeCount % 2 === 0 ? 'team-a' : 'team-b',
    });
  }

  private removeBot(connection: ClientConnection, playerId: string): void {
    this.requireHost(connection);
    if (this.phase !== 'lobby') throw new Error('Bots can only leave in the lobby.');
    const index = this.players.findIndex((player) => player.id === playerId && player.isBot);
    if (index >= 0) this.players.splice(index, 1);
  }

  private removePlayer(connection: ClientConnection, playerId: string): void {
    this.requireHost(connection);
    if (this.phase !== 'lobby') throw new Error('Players can only be removed in the lobby.');
    const index = this.players.findIndex((player) => player.id === playerId && player.id !== this.hostId);
    if (index < 0) throw new Error('That player cannot be removed.');
    const [removed] = this.players.splice(index, 1);
    if (removed) {
      for (const [socket, client] of this.clients.entries()) {
        if (client.playerId === removed.id) {
          client.playerId = null;
          client.error = 'The host removed this seat.';
          this.send(socket, { type: 'welcome', token: client.token, playerId: null });
        }
      }
    }
  }

  private switchTeam(connection: ClientConnection, playerId: string): void {
    this.requireHost(connection);
    if (this.phase !== 'lobby') throw new Error('Teams can only change in the lobby.');
    const player = this.activePlayers().find((candidate) => candidate.id === playerId);
    if (!player) throw new Error('Unknown fighter.');
    player.teamId = player.teamId === 'team-a' ? 'team-b' : 'team-a';
  }

  private validateRoster(): void {
    const count = this.activePlayers().length;
    if (this.config.mode === 'duel' && count !== 2) throw new Error('1v1 needs exactly 2 fighters.');
    if (this.config.mode === 'ffa' && (count < 3 || count > 4)) throw new Error('FFA needs 3 or 4 fighters.');
    if (this.config.mode === 'teams') {
      if (count !== 4) throw new Error('Teams needs exactly 4 fighters.');
      const teamACount = this.activePlayers().filter((player) => player.teamId === 'team-a').length;
      if (teamACount !== 2) throw new Error('Teams needs two fighters on each side.');
    }
  }

  private startDraft(connection: ClientConnection): void {
    this.requireHost(connection);
    if (this.phase !== 'lobby') throw new Error('The match has already started.');
    this.validateRoster();
    const active = this.activePlayers();
    this.matchSeed = randomInt(1, 2_147_483_647);
    this.matchId = randomUUID().slice(0, 8).toUpperCase();
    const enabledCards = this.store.listCards().filter((card) => card.enabled !== false);
    const result = createDraft(active.map((player) => player.id), enabledCards, this.config.playlist, new SeededRng(this.matchSeed));
    this.draftOptions = new Map(Object.entries(result.options));
    this.cursedPlayerId = result.cursedPlayerId;
    this.selections.clear();
    this.actions.clear();
    this.battle = null;
    this.initialBattle = null;
    this.lastEvents = [];
    this.resolutionReady.clear();
    this.roundActions = [];
    this.resumePhase = null;
    this.resumeRemainingMs = 0;
    this.phase = 'draft';

    for (const player of active) {
      const options = this.draftOptions.get(player.id) ?? [];
      if (player.id === this.cursedPlayerId || player.isBot) {
        const selected = options[new SeededRng(this.matchSeed ^ player.id.length).int(0, options.length - 1)];
        if (selected) this.selections.set(player.id, selected.id);
      }
    }
    this.schedule(DRAFT_DURATION, () => this.beginReveal());
    if (this.selections.size === active.length) this.beginReveal();
  }

  private selectFighter(connection: ClientConnection, matchId: string, fighterId: string): void {
    this.requireCurrentMatch(matchId);
    const player = this.playerFor(connection);
    if (!player || player.spectator || this.phase !== 'draft') throw new Error('Fighter selection is closed.');
    if (player.id === this.cursedPlayerId) throw new Error('The curse already chose for you.');
    const options = this.draftOptions.get(player.id) ?? [];
    if (!options.some((card) => card.id === fighterId)) throw new Error('That fighter is not in your draw.');
    this.selections.set(player.id, fighterId);
    if (this.selections.size === this.activePlayers().length) this.beginReveal();
  }

  private teamIdFor(player: RoomPlayer, index: number): string {
    if (this.config.mode === 'teams') return player.teamId ?? (index % 2 === 0 ? 'team-a' : 'team-b');
    return player.id;
  }

  private beginReveal(): void {
    if (this.phase !== 'draft') return;
    if (this.timer) clearTimeout(this.timer);
    const cards = this.store.listCards();
    const active = this.activePlayers();
    for (const player of active) {
      if (!this.selections.has(player.id)) {
        const options = this.draftOptions.get(player.id) ?? [];
        const fallback = options[0];
        if (fallback) this.selections.set(player.id, fallback.id);
      }
    }
    const participants = active.map((player, index) => {
      const fighterId = this.selections.get(player.id);
      const card = cards.find((candidate) => candidate.id === fighterId);
      if (!card) throw new Error(`Missing selected card for ${player.name}.`);
      return { id: player.id, name: player.name, teamId: this.teamIdFor(player, index), card };
    });
    this.battle = createBattle(participants, this.config.mode, this.matchSeed);
    this.initialBattle = structuredClone(this.battle);
    this.phase = 'reveal';
    this.schedule(REVEAL_DURATION, () => this.beginPlanning());
  }

  private beginPlanning(): void {
    if (!this.battle || this.battle.finished) {
      this.finishMatch();
      return;
    }
    this.phase = 'planning';
    this.resolutionReady.clear();
    this.actions.clear();
    const botRng = new SeededRng(this.matchSeed ^ this.battle.round * 7_919);
    for (const player of this.activePlayers().filter((candidate) => candidate.isBot)) {
      const action = chooseBotAction(this.battle, player.id, botRng);
      if (action) this.actions.set(player.id, { action, locked: true });
    }
    this.schedule(PLANNING_DURATION, () => this.resolveCurrentRound());
  }

  private chooseAction(
    connection: ClientConnection,
    matchId: string,
    round: number,
    input: Omit<ActionChoice, 'actorId'>,
  ): void {
    const battle = this.requireCurrentRound(matchId, round);
    const player = this.playerFor(connection);
    if (!player || player.spectator || this.phase !== 'planning') throw new Error('Planning is closed.');
    const pending = this.actions.get(player.id);
    if (pending?.locked) throw new Error('Your action is locked.');
    const fighter = battle.fighters[player.id];
    const ability = fighter?.card.abilities.find((candidate) => candidate.id === input.abilityId);
    if (!fighter || !ability || !getAbilityAvailability(fighter, ability, battle.round).available) {
      throw new Error('That ability is unavailable.');
    }
    const allowedTargets = eligibleTargets(battle, player.id, ability);
    const targetIds = input.targetIds.filter((targetId) => allowedTargets.includes(targetId));
    if (!['self', 'all-enemies', 'random-enemy'].includes(ability.target) && targetIds.length === 0) {
      throw new Error('Choose a valid target.');
    }
    this.actions.set(player.id, {
      action: { actorId: player.id, abilityId: input.abilityId, targetIds },
      locked: false,
    });
  }

  private lockAction(connection: ClientConnection, matchId: string, round: number): void {
    const battle = this.requireCurrentRound(matchId, round);
    const player = this.playerFor(connection);
    if (!player || this.phase !== 'planning') throw new Error('Planning is closed.');
    const pending = this.actions.get(player.id);
    if (!pending) throw new Error('Choose an ability and target first.');
    pending.locked = true;
    const livingIds = Object.values(battle.fighters).filter((fighter) => fighter.hp > 0).map((fighter) => fighter.id);
    if (livingIds.every((playerId) => this.actions.get(playerId)?.locked)) this.resolveCurrentRound();
  }

  private readyResolution(connection: ClientConnection, matchId: string, round: number): void {
    const battle = this.requireCurrentRound(matchId, round);
    const player = this.playerFor(connection);
    if (!player || player.spectator || player.isBot || this.phase !== 'resolution') {
      throw new Error('The round review is closed.');
    }
    this.resolutionReady.add(player.id);
    const humanIds = this.activePlayers().filter((candidate) => !candidate.isBot).map((candidate) => candidate.id);
    if (!humanIds.every((playerId) => this.resolutionReady.has(playerId))) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.deadline = null;
    this.resolutionReady.clear();
    if (battle.finished) this.finishMatch();
    else this.beginPlanning();
  }

  private resolveCurrentRound(): void {
    if (!this.battle || this.phase !== 'planning') return;
    if (this.timer) clearTimeout(this.timer);
    const fallbackRng = new SeededRng(this.matchSeed ^ this.battle.round * 104_729);
    for (const fighter of Object.values(this.battle.fighters).filter((candidate) => candidate.hp > 0)) {
      if (!this.actions.has(fighter.id)) {
        const fallback = chooseBotAction(this.battle, fighter.id, fallbackRng);
        if (fallback) this.actions.set(fighter.id, { action: fallback, locked: true });
      }
    }
    const chosenActions = [...this.actions.values()].map((pending) => pending.action);
    this.roundActions.push(structuredClone(chosenActions));
    const result = resolveRound(this.battle, chosenActions);
    this.battle = result.state;
    this.lastEvents = result.events;
    this.resolutionReady.clear();
    this.phase = 'resolution';
    this.schedule(RESOLUTION_DURATION, () => {
      if (this.battle?.finished) this.finishMatch();
      else this.beginPlanning();
    });
  }

  private finishMatch(): void {
    if (!this.battle) return;
    if (!this.initialBattle) throw new Error('The match replay origin is missing.');
    this.phase = 'finished';
    this.resolutionReady.clear();
    this.deadline = null;
    this.timer = null;
    const winnerFighterIds = (this.battle.winnerPlayerIds ?? []).flatMap((playerId) => {
      const fighterId = this.battle?.fighters[playerId]?.card.id;
      return fighterId ? [fighterId] : [];
    });
    this.store.recordMatch({
      id: this.matchId ?? randomUUID(),
      seed: this.battle.seed,
      mode: this.config.mode,
      playlist: this.config.playlist,
      rounds: this.battle.round,
      winnerIds: winnerFighterIds,
      fighterIds: Object.values(this.battle.fighters).map((fighter) => fighter.card.id),
      initialBattle: this.initialBattle,
      roundActions: this.roundActions,
    });
    this.broadcast();
  }

  private rematch(connection: ClientConnection): void {
    this.requireHost(connection);
    if (this.phase !== 'finished') throw new Error('Finish this fight first.');
    this.phase = 'lobby';
    this.deadline = null;
    this.draftOptions.clear();
    this.selections.clear();
    this.actions.clear();
    this.cursedPlayerId = null;
    this.battle = null;
    this.initialBattle = null;
    this.lastEvents = [];
    this.resolutionReady.clear();
    this.matchId = null;
    this.roundActions = [];
    this.resumePhase = null;
    this.resumeRemainingMs = 0;
  }

  private resumeMatch(connection: ClientConnection): void {
    const host = this.requireHost(connection);
    if (host.isBot || host.spectator || !host.connected || !this.isPlayerConnected(host.id)) {
      throw new Error('A connected human host must resume the match.');
    }
    if (this.phase !== 'paused' || !this.resumePhase) throw new Error('There is no recovered match to resume.');
    const phase = this.resumePhase;
    const remaining = Math.max(750, this.resumeRemainingMs);
    this.resumePhase = null;
    this.resumeRemainingMs = 0;
    this.phase = phase;

    switch (phase) {
      case 'draft':
        this.schedule(remaining, () => this.beginReveal());
        break;
      case 'reveal':
        this.schedule(remaining, () => this.beginPlanning());
        break;
      case 'planning':
        this.schedule(remaining, () => this.resolveCurrentRound());
        break;
      case 'resolution':
        this.schedule(remaining, () => {
          if (this.battle?.finished) this.finishMatch();
          else this.beginPlanning();
        });
        break;
    }
  }

  private restoreCheckpoint(): void {
    const stored = this.store.loadRoomCheckpoint();
    if (stored === null) return;
    if (!isRoomCheckpoint(stored)) {
      console.warn('Ignoring an invalid room checkpoint. Durable cards and match history are unaffected.');
      this.store.clearRoomCheckpoint();
      return;
    }

    this.config = structuredClone(stored.config);
    this.players.splice(0, this.players.length, ...structuredClone(stored.players)
      .filter((player) => !player.spectator)
      .map((player, index) => ({
        ...player,
        connected: player.isBot,
        teamId: player.teamId ?? (index % 2 === 0 ? 'team-a' : 'team-b'),
      })));
    this.hostId = stored.hostId;
    this.draftOptions = new Map(structuredClone(stored.draftOptions));
    this.selections = new Map(structuredClone(stored.selections));
    this.cursedPlayerId = stored.cursedPlayerId;
    this.battle = structuredClone(stored.battle);
    this.initialBattle = structuredClone(stored.initialBattle ?? null);
    this.actions = new Map(structuredClone(stored.actions));
    this.lastEvents = structuredClone(stored.lastEvents);
    this.resolutionReady = new Set(stored.resolutionReadyPlayerIds ?? []);
    this.matchId = stored.matchId;
    this.matchSeed = stored.matchSeed;
    this.roundActions = structuredClone(stored.roundActions);
    this.deadline = null;
    this.timer = null;

    if (stored.phase === 'paused') {
      this.phase = 'paused';
      this.resumePhase = stored.resumePhase;
      this.resumeRemainingMs = Math.max(750, stored.remainingMs ?? 1_000);
    } else if (TIMED_PHASES.has(stored.phase as TimedGamePhase)) {
      this.phase = 'paused';
      this.resumePhase = stored.phase as TimedGamePhase;
      this.resumeRemainingMs = Math.max(750, stored.remainingMs ?? 1_000);
    } else {
      this.phase = stored.phase;
      this.resumePhase = null;
      this.resumeRemainingMs = 0;
    }
    console.log(this.phase === 'paused'
      ? `Recovered match ${this.matchId ?? 'in progress'}; waiting for the host to resume.`
      : `Recovered room state in ${this.phase}.`);
  }

  private persistCheckpoint(): void {
    const remainingMs = this.phase === 'paused'
      ? this.resumeRemainingMs
      : this.deadline === null
        ? null
        : Math.max(0, this.deadline - Date.now());
    const checkpoint: RoomCheckpoint = {
      version: 1,
      savedAt: Date.now(),
      phase: this.phase,
      resumePhase: this.resumePhase,
      remainingMs,
      config: this.config,
      players: this.players,
      hostId: this.hostId,
      draftOptions: [...this.draftOptions.entries()],
      selections: [...this.selections.entries()],
      cursedPlayerId: this.cursedPlayerId,
      battle: this.battle,
      initialBattle: this.initialBattle,
      actions: [...this.actions.entries()],
      lastEvents: this.lastEvents,
      resolutionReadyPlayerIds: [...this.resolutionReady],
      matchId: this.matchId,
      matchSeed: this.matchSeed,
      roundActions: this.roundActions,
    };
    this.store.saveRoomCheckpoint(checkpoint);
  }

  private pauseAfterTimerError(error: unknown, fallbackPhase: TimedGamePhase | null): void {
    const pausedCurrentPhase = this.pauseTimedPhase();
    if (!pausedCurrentPhase && fallbackPhase) {
      if (this.timer) clearTimeout(this.timer);
      this.resumePhase = fallbackPhase;
      this.resumeRemainingMs = 1_000;
      this.phase = 'paused';
      this.deadline = null;
      this.timer = null;
    } else if (!pausedCurrentPhase && this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const message = error instanceof Error ? error.message : 'Unknown timer failure.';
    const clientMessage = this.phase === 'paused'
      ? `Game paused safely: ${message}`
      : `Game transition completed, but saving failed: ${message}`;
    console.error(clientMessage);
    for (const connection of this.clients.values()) connection.error = clientMessage;
    try {
      this.persistCheckpoint();
    } catch (checkpointError) {
      console.error('Could not persist the paused checkpoint.', checkpointError);
    }
    try {
      this.broadcast();
    } catch (broadcastError) {
      console.error('Could not broadcast the timer failure.', broadcastError);
    }
  }

  private schedule(duration: number, next: () => void): void {
    if (this.timer) clearTimeout(this.timer);
    const scheduledPhase = TIMED_PHASES.has(this.phase as TimedGamePhase)
      ? this.phase as TimedGamePhase
      : null;
    this.deadline = Date.now() + duration;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        next();
      } catch (error) {
        this.pauseAfterTimerError(error, scheduledPhase);
        return;
      }
      try {
        this.persistCheckpoint();
        this.broadcast();
      } catch (error) {
        this.pauseAfterTimerError(error, null);
      }
    }, duration);
    this.timer.unref();
  }

  private teamFor(playerId: string): string | null {
    return this.battle?.fighters[playerId]?.teamId ?? null;
  }

  private publicPlayers(): PublicPlayer[] {
    const visiblePhase = this.phase === 'paused' ? this.resumePhase : this.phase;
    return this.players.map((player, index) => ({
      id: player.id,
      name: player.name,
      color: player.color,
      connected: player.connected,
      spectator: player.spectator,
      isBot: player.isBot,
      isHost: player.id === this.hostId,
      teamId: this.teamFor(player.id) ?? (this.config.mode === 'teams' && !player.spectator
        ? player.teamId ?? (index % 2 === 0 ? 'team-a' : 'team-b')
        : null),
      fighterId: visiblePhase === 'draft' ? null : (this.selections.get(player.id) ?? null),
      locked: visiblePhase === 'draft'
        ? this.selections.has(player.id)
        : (this.actions.get(player.id)?.locked ?? false),
    }));
  }

  private visibleIntents(viewerId: string | null, role: ClientConnection['role']): TeamIntent[] {
    if (!viewerId || role === 'arena') return [];
    const viewerTeam = this.teamFor(viewerId);
    return [...this.actions.entries()].flatMap(([playerId, pending]) => {
      const canSee = playerId === viewerId
        || (this.config.mode === 'teams' && viewerTeam !== null && this.teamFor(playerId) === viewerTeam);
      return canSee ? [{ playerId, ...pending.action, locked: pending.locked }] : [];
    });
  }

  private snapshot(connection: ClientConnection): ClientSnapshot {
    const playerId = connection.playerId;
    return {
      roomCode: ROOM_CODE,
      joinUrls: this.joinUrls,
      phase: this.phase,
      config: this.config,
      players: this.publicPlayers(),
      selfId: playerId,
      serverTime: Date.now(),
      deadline: this.deadline,
      draftOptions: connection.role === 'player' && playerId && this.phase === 'draft'
        ? (this.draftOptions.get(playerId) ?? null)
        : null,
      selectedFighterId: connection.role === 'player' && playerId ? (this.selections.get(playerId) ?? null) : null,
      cursedHijack: connection.role === 'player' && playerId === this.cursedPlayerId,
      battle: this.battle,
      lastEvents: this.lastEvents,
      resolutionReadyPlayerIds: [...this.resolutionReady],
      intents: this.visibleIntents(playerId, connection.role),
      matchId: this.matchId,
      resumePhase: this.resumePhase,
      error: connection.error,
    };
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  private sendState(socket: WebSocket): void {
    const connection = this.clients.get(socket);
    if (connection) this.send(socket, { type: 'state', state: this.snapshot(connection) });
  }

  private broadcast(): void {
    for (const socket of this.clients.keys()) this.sendState(socket);
  }
}
