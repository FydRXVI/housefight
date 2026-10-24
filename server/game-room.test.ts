import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveRound } from '../engine/engine.js';
import type { ActionChoice, BattleState, CardDefinition } from '../engine/types.js';
import { fakeCards } from '../fixtures/fake-card-pack/cards.js';
import type { ClientMessage, ClientSnapshot, ServerMessage } from '../shared/protocol.js';
import { GameRoom } from './game-room.js';
import type { GameStore, MatchRecord } from './storage.js';

class MemoryStore {
  checkpoint: unknown | null;
  readonly records: MatchRecord[] = [];
  failNextCheckpoint = false;
  failNextRecord = false;

  constructor(checkpoint: unknown | null = null, private readonly cards: CardDefinition[] = fakeCards) {
    this.checkpoint = structuredClone(checkpoint);
  }

  listCards(): CardDefinition[] {
    return structuredClone(this.cards);
  }

  recordMatch(record: MatchRecord): void {
    if (this.failNextRecord) {
      this.failNextRecord = false;
      throw new Error('simulated match write failure');
    }
    this.records.push(structuredClone(record));
  }

  loadRoomCheckpoint(): unknown | null {
    return structuredClone(this.checkpoint);
  }

  saveRoomCheckpoint(value: unknown): void {
    if (this.failNextCheckpoint) {
      this.failNextCheckpoint = false;
      throw new Error('simulated checkpoint failure');
    }
    this.checkpoint = structuredClone(value);
  }

  clearRoomCheckpoint(): void {
    this.checkpoint = null;
  }
}

class TestSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  readonly messages: ServerMessage[] = [];

  send(payload: string | Buffer): void {
    this.messages.push(JSON.parse(payload.toString()) as ServerMessage);
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit('close', code, Buffer.from(reason));
  }

  receive(message: ClientMessage | Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(message)));
  }

  get state(): ClientSnapshot {
    const message = this.messages.findLast((candidate) => candidate.type === 'state');
    if (!message || message.type !== 'state') throw new Error('The test socket has no state message.');
    return message.state;
  }

  get welcome(): Extract<ServerMessage, { type: 'welcome' }> {
    const message = this.messages.findLast((candidate) => candidate.type === 'welcome');
    if (!message || message.type !== 'welcome') throw new Error('The test socket has no welcome message.');
    return message;
  }
}

let rooms: GameRoom[];

function createRoom(store = new MemoryStore()): { room: GameRoom; store: MemoryStore } {
  const room = new GameRoom(store as unknown as GameStore, ['http://house.test']);
  rooms.push(room);
  return { room, store };
}

function connect(room: GameRoom, token: string | null = null, role: 'player' | 'arena' = 'player'): TestSocket {
  const socket = new TestSocket();
  room.attach(socket as unknown as WebSocket, token, role);
  return socket;
}

function join(socket: TestSocket, name: string, spectator = false): string {
  socket.receive({ type: 'join', nickname: name, color: '#123abc', spectator });
  const playerId = socket.state.selfId;
  if (!playerId) throw new Error(`${name} did not receive a player id.`);
  return playerId;
}

function addBot(host: TestSocket): string {
  const before = new Set(host.state.players.map((player) => player.id));
  host.receive({ type: 'add-bot' });
  const bot = host.state.players.find((player) => player.isBot && !before.has(player.id));
  if (!bot) throw new Error('The bot was not added.');
  return bot.id;
}

function selectFirstDraftOption(socket: TestSocket): void {
  const state = socket.state;
  const fighter = state.draftOptions?.[0];
  if (!fighter || !state.matchId) throw new Error('No draft option was available.');
  socket.receive({ type: 'select-fighter', matchId: state.matchId, fighterId: fighter.id });
}

async function advanceCurrentDeadline(socket: TestSocket): Promise<void> {
  const state = socket.state;
  if (state.deadline === null) throw new Error(`The ${state.phase} phase has no deadline.`);
  await vi.advanceTimersByTimeAsync(Math.max(0, state.deadline - state.serverTime) + 1);
}

async function advanceUntilFinished(socket: TestSocket): Promise<void> {
  let transitions = 0;
  while (socket.state.phase !== 'finished' && transitions < 100) {
    await advanceCurrentDeadline(socket);
    transitions += 1;
  }
  if (socket.state.phase !== 'finished') throw new Error('The match did not finish within 100 timed transitions.');
}

function chooseFirstEnemyAction(socket: TestSocket): void {
  const state = socket.state;
  const selfId = state.selfId;
  const battle = state.battle;
  if (!selfId || !battle || !state.matchId) throw new Error('The player has no active fighter.');
  const actor = battle.fighters[selfId];
  if (!actor) throw new Error('The player fighter is missing.');
  const ability = actor.card.abilities.find((candidate) => candidate.target === 'enemy');
  const target = Object.values(battle.fighters).find((candidate) => candidate.teamId !== actor.teamId && candidate.hp > 0);
  if (!ability || !target) throw new Error('No enemy action was available.');
  socket.receive({
    type: 'choose-action',
    matchId: state.matchId,
    round: battle.round,
    action: { abilityId: ability.id, targetIds: [target.id] },
  });
}

function lockCurrentAction(socket: TestSocket): void {
  const state = socket.state;
  if (!state.matchId || !state.battle) throw new Error('There is no current battle action to lock.');
  socket.receive({ type: 'lock-action', matchId: state.matchId, round: state.battle.round });
}

beforeEach(() => {
  rooms = [];
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-19T18:00:00.000Z'));
});

afterEach(() => {
  for (const room of rooms) room.shutdown();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('GameRoom multiplayer and recovery boundaries', () => {
  it('gives players 30 seconds to read the draft and 12 seconds to review each resolution', async () => {
    const { room } = createRoom();
    const host = connect(room);
    join(host, 'Pacing Host');
    addBot(host);
    host.receive({ type: 'start' });
    expect((host.state.deadline ?? 0) - host.state.serverTime).toBe(30_000);

    selectFirstDraftOption(host);
    await advanceCurrentDeadline(host);
    chooseFirstEnemyAction(host);
    lockCurrentAction(host);
    expect(host.state.phase).toBe('resolution');
    expect((host.state.deadline ?? 0) - host.state.serverTime).toBe(12_000);
  });

  it('skips the resolution only after every human is ready, while bots never count', async () => {
    const { room } = createRoom();
    const host = connect(room);
    join(host, 'Ready Host');
    const guest = connect(room);
    join(guest, 'Ready Guest');
    host.receive({ type: 'start' });
    selectFirstDraftOption(host);
    selectFirstDraftOption(guest);
    await advanceCurrentDeadline(host);
    await advanceCurrentDeadline(host);
    expect(host.state.phase).toBe('resolution');
    const matchId = host.state.matchId;
    const round = host.state.battle?.round;
    if (!matchId || !round) throw new Error('Resolution did not start.');

    host.receive({ type: 'ready-resolution', matchId, round });
    expect(host.state.phase).toBe('resolution');
    expect(host.state.resolutionReadyPlayerIds).toEqual([host.state.selfId]);
    guest.receive({ type: 'ready-resolution', matchId, round });
    expect(host.state.phase).toBe('planning');
    expect(host.state.resolutionReadyPlayerIds).toEqual([]);

    host.receive({ type: 'ready-resolution', matchId, round });
    expect(host.state.error).toBe('The round review is closed.');

    const botRoom = createRoom();
    const soloHost = connect(botRoom.room);
    join(soloHost, 'Solo Human');
    addBot(soloHost);
    soloHost.receive({ type: 'start' });
    selectFirstDraftOption(soloHost);
    await advanceCurrentDeadline(soloHost);
    await advanceCurrentDeadline(soloHost);
    const botMatchId = soloHost.state.matchId;
    const botRound = soloHost.state.battle?.round;
    if (!botMatchId || !botRound) throw new Error('Bot resolution did not start.');
    soloHost.receive({ type: 'ready-resolution', matchId: botMatchId, round: botRound });
    expect(soloHost.state.phase).toBe('planning');
  });

  it('keeps disabled vault cards out of every private draft hand', () => {
    const disabled = { ...(fakeCards[0] as CardDefinition), enabled: false };
    const enabled = fakeCards.slice(1, 7).map((card) => ({ ...card, enabled: true }));
    const { room } = createRoom(new MemoryStore(null, [disabled, ...enabled]));
    const host = connect(room);
    join(host, 'Enabled Host');
    const guest = connect(room);
    join(guest, 'Enabled Guest');
    host.receive({ type: 'start' });

    const dealt = [...(host.state.draftOptions ?? []), ...(guest.state.draftOptions ?? [])];
    expect(dealt).toHaveLength(6);
    expect(new Set(dealt.map((card) => card.id))).toEqual(new Set(enabled.map((card) => card.id)));
    expect(dealt.some((card) => card.id === disabled.id)).toBe(false);
  });

  it('restores a human host with the same seat and never promotes the bot on refresh', () => {
    const { room } = createRoom();
    const host = connect(room);
    const hostToken = host.welcome.token;
    const hostId = join(host, 'Host');
    const botId = addBot(host);

    host.close();
    const arena = connect(room, null, 'arena');
    expect(arena.state.players.find((player) => player.id === hostId)).toMatchObject({ connected: false, isHost: false });
    expect(arena.state.players.find((player) => player.id === botId)).toMatchObject({ connected: true, isHost: false });

    const refreshed = connect(room, hostToken);
    expect(refreshed.welcome.playerId).toBe(hostId);
    expect(refreshed.state.players.find((player) => player.id === hostId)).toMatchObject({ connected: true, isHost: true });
    expect(refreshed.state.players.find((player) => player.id === botId)?.isHost).toBe(false);
  });

  it('keeps a seat connected until the last socket using its token closes', () => {
    const { room } = createRoom();
    const first = connect(room);
    const token = first.welcome.token;
    const playerId = join(first, 'Multi-tab Host');
    const duplicate = connect(room, token);

    first.close();
    expect(duplicate.state.players.find((player) => player.id === playerId)).toMatchObject({ connected: true, isHost: true });

    duplicate.close();
    const arena = connect(room, null, 'arena');
    expect(arena.state.players.find((player) => player.id === playerId)).toMatchObject({ connected: false, isHost: false });
  });

  it('does not pause a timed match until the final socket for the final human closes', () => {
    const { room } = createRoom();
    const first = connect(room);
    const token = first.welcome.token;
    join(first, 'Multi-tab Host');
    addBot(first);
    first.receive({ type: 'start' });
    const duplicate = connect(room, token);

    first.close();
    expect(duplicate.state.phase).toBe('draft');
    duplicate.close();

    const arena = connect(room, null, 'arena');
    expect(arena.state).toMatchObject({ phase: 'paused', resumePhase: 'draft', deadline: null });
  });

  it('rotates unknown tokens instead of accepting attacker-selected bearer tokens', () => {
    const { room } = createRoom();
    const attackerToken = 'attacker-selected-token';
    const first = connect(room, attackerToken);
    const issuedToken = first.welcome.token;
    const playerId = join(first, 'Legitimate Player');

    expect(issuedToken).not.toBe(attackerToken);
    const attacker = connect(room, attackerToken);
    expect(attacker.welcome).toMatchObject({ playerId: null });
    expect(attacker.welcome.token).not.toBe(attackerToken);
    expect(attacker.welcome.token).not.toBe(issuedToken);

    const restored = connect(room, issuedToken);
    expect(restored.welcome.playerId).toBe(playerId);
  });

  it('recovers a lobby after a crash and elects the first returning non-host human', () => {
    const original = createRoom();
    const host = connect(original.room);
    const originalHostId = join(host, 'Original Host');
    const guest = connect(original.room);
    const guestToken = guest.welcome.token;
    const guestId = join(guest, 'Returning Guest');
    const crashCheckpoint = structuredClone(original.store.checkpoint);

    const recovered = createRoom(new MemoryStore(crashCheckpoint));
    const returningGuest = connect(recovered.room, guestToken);

    expect(returningGuest.welcome.playerId).toBe(guestId);
    expect(returningGuest.state.players.find((player) => player.id === guestId)).toMatchObject({ connected: true, isHost: true });
    expect(returningGuest.state.players.find((player) => player.id === originalHostId)).toMatchObject({ connected: false, isHost: false });
  });

  it('hands off host control without pausing while another human remains connected', async () => {
    const { room } = createRoom();
    const host = connect(room);
    const hostId = join(host, 'Departing Host');
    const guest = connect(room);
    const guestId = join(guest, 'New Host');
    host.receive({ type: 'start' });
    selectFirstDraftOption(host);
    selectFirstDraftOption(guest);
    expect(host.state.phase).toBe('reveal');

    host.close();
    expect(guest.state.phase).toBe('reveal');
    expect(guest.state.players.find((player) => player.id === hostId)?.connected).toBe(false);
    expect(guest.state.players.find((player) => player.id === guestId)?.isHost).toBe(true);

    await advanceCurrentDeadline(guest);
    expect(guest.state.phase).toBe('planning');
  });

  it('lets the host remove a disconnected lobby seat and invalidates its old token', () => {
    const { room } = createRoom();
    const host = connect(room);
    join(host, 'Host');
    const guest = connect(room);
    const guestToken = guest.welcome.token;
    const guestId = join(guest, 'Disconnected Guest');
    guest.close();

    host.receive({ type: 'remove-player', playerId: guestId });
    expect(host.state.players.some((player) => player.id === guestId)).toBe(false);

    const staleReconnect = connect(room, guestToken);
    expect(staleReconnect.welcome.playerId).toBeNull();
    expect(staleReconnect.welcome.token).not.toBe(guestToken);
  });

  it('keeps arena displays and spectators read-only and hides draft options from both', () => {
    const { room } = createRoom();
    const arena = connect(room, null, 'arena');
    arena.receive({ type: 'add-bot' });
    expect(arena.state.error).toBe('Arena connections are display-only.');
    expect(arena.state.players).toHaveLength(0);

    const host = connect(room);
    const hostToken = host.welcome.token;
    join(host, 'Host');
    addBot(host);
    host.receive({ type: 'start' });
    const spectator = connect(room);
    const spectatorId = join(spectator, 'Spectator', true);
    const tokenedArena = connect(room, hostToken, 'arena');

    expect(arena.state.draftOptions).toBeNull();
    expect(tokenedArena.welcome.playerId).toBeNull();
    expect(tokenedArena.state.draftOptions).toBeNull();
    expect(tokenedArena.state.selectedFighterId).toBeNull();
    expect(tokenedArena.state.cursedHijack).toBe(false);
    expect(spectator.state.draftOptions).toBeNull();
    spectator.receive({
      type: 'select-fighter',
      matchId: spectator.state.matchId ?? '',
      fighterId: fakeCards[0]?.id ?? 'nova',
    });
    expect(spectator.state.error).toBe('Fighter selection is closed.');
    expect(spectator.state.players.find((player) => player.id === spectatorId)?.fighterId).toBeNull();
  });

  it('keeps duplicate spectator sockets on one ephemeral seat and removes it after the last closes', () => {
    const { room } = createRoom();
    const spectator = connect(room);
    const spectatorToken = spectator.welcome.token;
    const spectatorId = join(spectator, 'Living-room Display', true);
    const duplicate = connect(room, spectatorToken);

    spectator.close();
    expect(duplicate.state.players.some((player) => player.id === spectatorId)).toBe(true);
    duplicate.close();

    const arena = connect(room, null, 'arena');
    expect(arena.state.players.some((player) => player.id === spectatorId)).toBe(false);
  });

  it('caps the connected spectator gallery and frees capacity on disconnect', () => {
    const { room } = createRoom();
    const spectators = Array.from({ length: 32 }, (_, index) => {
      const socket = connect(room);
      join(socket, `Spectator ${index}`, true);
      return socket;
    });
    const overflow = connect(room);
    overflow.receive({ type: 'join', nickname: 'Overflow', color: '#123abc', spectator: true });
    expect(overflow.state.selfId).toBeNull();
    expect(overflow.state.error).toBe('The spectator gallery is full.');

    spectators[0]?.close();
    overflow.receive({ type: 'join', nickname: 'Replacement', color: '#123abc', spectator: true });
    expect(overflow.state.selfId).not.toBeNull();
    expect(overflow.state.players.filter((player) => player.spectator)).toHaveLength(32);
  });

  it('persists explicit 2v2 assignments and reveals intents only to the acting team', async () => {
    const { room } = createRoom();
    const players = ['Alpha', 'Bravo', 'Charlie', 'Delta'].map((name) => {
      const socket = connect(room);
      const id = join(socket, name);
      return { socket, id };
    });
    const host = players[0]?.socket;
    if (!host) throw new Error('The host is missing.');
    host.receive({ type: 'configure', config: { mode: 'teams', playlist: 'balanced' } });

    const bravo = players[1];
    const charlie = players[2];
    if (!bravo || !charlie) throw new Error('The team players are missing.');
    host.receive({ type: 'switch-team', playerId: bravo.id });
    host.receive({ type: 'switch-team', playerId: charlie.id });
    expect(host.state.players.filter((player) => !player.spectator).map((player) => player.teamId)).toEqual([
      'team-a',
      'team-a',
      'team-b',
      'team-b',
    ]);

    host.receive({ type: 'start' });
    for (const player of players) selectFirstDraftOption(player.socket);
    expect(host.state.phase).toBe('reveal');
    await advanceCurrentDeadline(host);
    expect(host.state.phase).toBe('planning');

    for (const player of players) chooseFirstEnemyAction(player.socket);
    const teamAIds = players.slice(0, 2).map((player) => player.id).sort();
    const teamBIds = players.slice(2).map((player) => player.id).sort();
    expect(players[0]?.socket.state.intents.map((intent) => intent.playerId).sort()).toEqual(teamAIds);
    expect(players[1]?.socket.state.intents.map((intent) => intent.playerId).sort()).toEqual(teamAIds);
    expect(players[2]?.socket.state.intents.map((intent) => intent.playerId).sort()).toEqual(teamBIds);
    expect(players[3]?.socket.state.intents.map((intent) => intent.playerId).sort()).toEqual(teamBIds);

    const arena = connect(room, null, 'arena');
    expect(arena.state.intents).toEqual([]);
    for (const player of players) {
      expect(host.state.battle?.fighters[player.id]?.teamId).toBe(
        teamAIds.includes(player.id) ? 'team-a' : 'team-b',
      );
    }
  });

  it('pauses a timed phase for the last human and resumes only through the returning host', async () => {
    const { room } = createRoom();
    const host = connect(room);
    const hostToken = host.welcome.token;
    const hostId = join(host, 'Host');
    addBot(host);
    host.receive({ type: 'start' });
    const beforeDisconnect = host.state;
    const originalRemaining = (beforeDisconnect.deadline ?? 0) - beforeDisconnect.serverTime;

    const spectator = connect(room);
    join(spectator, 'Spectator', true);
    host.close();
    expect(spectator.state).toMatchObject({ phase: 'paused', resumePhase: 'draft', deadline: null });
    expect(spectator.state.players.find((player) => player.id === hostId)).toMatchObject({ connected: false, isHost: false });

    spectator.receive({ type: 'resume' });
    expect(spectator.state.error).toBe('Only the host can do that.');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spectator.state.phase).toBe('paused');

    const returningHost = connect(room, hostToken);
    expect(returningHost.state.players.find((player) => player.id === hostId)).toMatchObject({ connected: true, isHost: true });
    returningHost.receive({ type: 'resume' });
    expect(returningHost.state).toMatchObject({ phase: 'draft', resumePhase: null });
    expect(returningHost.state.deadline).not.toBeNull();
    const resumedRemaining = (returningHost.state.deadline ?? 0) - returningHost.state.serverTime;
    expect(resumedRemaining).toBeGreaterThanOrEqual(750);
    expect(resumedRemaining).toBeLessThanOrEqual(originalRemaining);
  });

  it('restores a valid mid-match checkpoint with battle events and recorded round actions intact', async () => {
    const original = createRoom();
    const host = connect(original.room);
    const hostToken = host.welcome.token;
    join(host, 'Recovering Host');
    addBot(host);
    host.receive({ type: 'start' });
    selectFirstDraftOption(host);
    await advanceCurrentDeadline(host);
    await advanceCurrentDeadline(host);
    expect(host.state.phase).toBe('resolution');
    const expectedBattle = structuredClone(host.state.battle);
    const expectedEvents = structuredClone(host.state.lastEvents);

    host.close();
    const recoveredStore = new MemoryStore(original.store.checkpoint);
    const recovered = createRoom(recoveredStore);
    const returningHost = connect(recovered.room, hostToken);

    expect(returningHost.state).toMatchObject({ phase: 'paused', resumePhase: 'resolution' });
    expect(returningHost.state.battle).toEqual(expectedBattle);
    expect(returningHost.state.lastEvents).toEqual(expectedEvents);
    returningHost.receive({ type: 'resume' });
    expect(returningHost.state.phase).toBe('resolution');
  });

  it('falls back to legal bot choices for a human who misses the planning deadline', async () => {
    const { room } = createRoom();
    const host = connect(room);
    const hostId = join(host, 'Host');
    const botId = addBot(host);
    host.receive({ type: 'start' });
    selectFirstDraftOption(host);
    await advanceCurrentDeadline(host);
    expect(host.state.phase).toBe('planning');

    await advanceCurrentDeadline(host);
    expect(host.state.phase).toBe('resolution');
    const actors = host.state.lastEvents
      .filter((event) => event.type === 'ability')
      .map((event) => event.actorId);
    expect(actors).toContain(hostId);
    expect(actors).toContain(botId);
    expect(host.state.battle?.round).toBe(2);
  });

  it.each([3, 4])('runs a complete fallback round for a %i-player FFA room', async (fighterCount) => {
    const { room } = createRoom();
    const host = connect(room);
    const hostId = join(host, 'FFA Host');
    host.receive({ type: 'configure', config: { mode: 'ffa', playlist: 'balanced' } });
    for (let index = 1; index < fighterCount; index += 1) addBot(host);
    host.receive({ type: 'start' });
    selectFirstDraftOption(host);
    await advanceCurrentDeadline(host);
    await advanceCurrentDeadline(host);

    expect(host.state.phase).toBe('resolution');
    expect(host.state.battle?.mode).toBe('ffa');
    expect(Object.keys(host.state.battle?.fighters ?? {})).toHaveLength(fighterCount);
    expect(new Set(Object.values(host.state.battle?.fighters ?? {}).map((fighter) => fighter.teamId)).size).toBe(fighterCount);
    expect(host.state.lastEvents.some((event) => event.type === 'ability' && event.actorId === hostId)).toBe(true);
  });

  it('treats a repeated lock message as stale instead of resolving twice', async () => {
    const { room } = createRoom();
    const host = connect(room);
    join(host, 'Host');
    addBot(host);
    host.receive({ type: 'start' });
    selectFirstDraftOption(host);
    await advanceCurrentDeadline(host);
    chooseFirstEnemyAction(host);
    lockCurrentAction(host);
    expect(host.state.phase).toBe('resolution');
    const resolvedBattle = structuredClone(host.state.battle);

    lockCurrentAction(host);
    expect(host.state.error).toBe('Planning is closed.');
    expect(host.state.battle).toEqual(resolvedBattle);
  });

  it('rejects a previous match selection arriving during a later draft', async () => {
    const { room } = createRoom();
    const host = connect(room);
    join(host, 'Host');
    addBot(host);
    host.receive({ type: 'start' });
    const oldMatchId = host.state.matchId;
    const oldFighterId = host.state.draftOptions?.[0]?.id;
    if (!oldMatchId || !oldFighterId) throw new Error('The first draft was not ready.');
    selectFirstDraftOption(host);
    await advanceUntilFinished(host);

    host.receive({ type: 'rematch' });
    host.receive({ type: 'start' });
    expect(host.state.phase).toBe('draft');
    expect(host.state.matchId).not.toBe(oldMatchId);
    expect(host.state.selectedFighterId).toBeNull();

    host.receive({ type: 'select-fighter', matchId: oldMatchId, fighterId: oldFighterId });
    expect(host.state.error).toBe('Stale match command ignored.');
    expect(host.state.phase).toBe('draft');
    expect(host.state.selectedFighterId).toBeNull();
  });

  it('rejects old-round action and lock packets during a later planning phase', async () => {
    const { room } = createRoom();
    const host = connect(room);
    const hostId = join(host, 'Host');
    addBot(host);
    host.receive({ type: 'start' });
    selectFirstDraftOption(host);
    await advanceCurrentDeadline(host);
    const firstPlanning = host.state;
    const matchId = firstPlanning.matchId;
    const battle = firstPlanning.battle;
    const actor = battle?.fighters[hostId];
    const ability = actor?.card.abilities.find((candidate) => candidate.target === 'enemy');
    const target = Object.values(battle?.fighters ?? {}).find((candidate) => candidate.teamId !== actor?.teamId);
    if (!matchId || !battle || !actor || !ability || !target) throw new Error('Round one was not ready.');
    const staleAction: ClientMessage = {
      type: 'choose-action',
      matchId,
      round: battle.round,
      action: { abilityId: ability.id, targetIds: [target.id] },
    };
    const staleLock: ClientMessage = { type: 'lock-action', matchId, round: battle.round };

    await advanceCurrentDeadline(host);
    expect(host.state.phase).toBe('resolution');
    expect(host.state.battle?.finished).toBe(false);
    await advanceCurrentDeadline(host);
    expect(host.state.phase).toBe('planning');
    expect(host.state.battle?.round).toBe(battle.round + 1);
    const beforeBattle = structuredClone(host.state.battle);
    const beforeIntents = structuredClone(host.state.intents);

    host.receive(staleAction);
    expect(host.state.error).toBe('Stale round command ignored.');
    expect(host.state.battle).toEqual(beforeBattle);
    expect(host.state.intents).toEqual(beforeIntents);
    expect(host.state.intents.some((intent) => intent.playerId === hostId)).toBe(false);

    host.receive(staleLock);
    expect(host.state.error).toBe('Stale round command ignored.');
    expect(host.state.phase).toBe('planning');
    expect(host.state.battle).toEqual(beforeBattle);
    expect(host.state.intents).toEqual(beforeIntents);
  });

  it('cancels the next deadline and preserves a resumable phase after checkpoint failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { room, store } = createRoom();
    const host = connect(room);
    join(host, 'Host');
    addBot(host);
    host.receive({ type: 'start' });
    selectFirstDraftOption(host);
    expect(host.state.phase).toBe('reveal');

    store.failNextCheckpoint = true;
    await advanceCurrentDeadline(host);
    expect(host.state.phase).toBe('paused');
    expect(host.state.resumePhase).toBe('planning');
    expect(host.state.error).toContain('simulated checkpoint failure');

    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.state.phase).toBe('paused');
    host.receive({ type: 'resume' });
    expect(host.state.phase).toBe('planning');
    expect(host.state.deadline).not.toBeNull();
  });

  it('retries the finished transition after a match-record write fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { room, store } = createRoom();
    const host = connect(room);
    join(host, 'Host');
    addBot(host);
    host.receive({ type: 'start' });
    selectFirstDraftOption(host);

    let transitions = 0;
    while (!(host.state.phase === 'resolution' && host.state.battle?.finished) && transitions < 100) {
      await advanceCurrentDeadline(host);
      transitions += 1;
    }
    expect(host.state.phase).toBe('resolution');
    expect(host.state.battle?.finished).toBe(true);

    store.failNextRecord = true;
    await advanceCurrentDeadline(host);
    expect(host.state).toMatchObject({ phase: 'paused', resumePhase: 'resolution' });
    expect(host.state.error).toContain('simulated match write failure');
    expect(store.records).toHaveLength(0);

    host.receive({ type: 'resume' });
    await advanceCurrentDeadline(host);
    expect(host.state.phase).toBe('finished');
    expect(store.records).toHaveLength(1);
  });

  it('clears a corrupt checkpoint instead of restoring executable malformed actions', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const original = createRoom();
    const host = connect(original.room);
    const hostId = join(host, 'Host');
    const botId = addBot(host);
    host.receive({ type: 'start' });
    selectFirstDraftOption(host);
    await advanceCurrentDeadline(host);
    expect(host.state.phase).toBe('planning');

    const corrupt = structuredClone(original.store.checkpoint);
    if (!corrupt || typeof corrupt !== 'object' || Array.isArray(corrupt)) throw new Error('The checkpoint was not an object.');
    Reflect.set(corrupt, 'actions', [[hostId, {
      action: { actorId: hostId, abilityId: 'not-a-real-ability', targetIds: [botId] },
      locked: true,
    }]]);
    const corruptStore = new MemoryStore(corrupt);
    const recovered = createRoom(corruptStore);
    expect(corruptStore.checkpoint).toBeNull();
    const arena = connect(recovered.room, null, 'arena');

    expect(arena.state).toMatchObject({ phase: 'lobby', players: [] });
  });

  it('records enough information to replay an entire timed match byte-for-byte', async () => {
    const { room, store } = createRoom();
    const host = connect(room);
    join(host, 'Replay Host');
    addBot(host);
    host.receive({ type: 'start' });
    selectFirstDraftOption(host);

    await advanceUntilFinished(host);
    expect(host.state.phase).toBe('finished');
    expect(store.records).toHaveLength(1);

    const record = store.records[0];
    if (!record) throw new Error('The completed match was not recorded.');
    let replay: BattleState = structuredClone(record.initialBattle);
    for (const actions of record.roundActions) {
      replay = resolveRound(replay, structuredClone(actions) as ActionChoice[]).state;
    }
    expect(record.roundActions.length).toBeGreaterThan(0);
    expect(replay).toEqual(host.state.battle);
  });
});
