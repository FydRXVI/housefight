import assert from 'node:assert/strict';
import WebSocket from 'ws';
import type { ClientMessage, ClientSnapshot, ServerMessage } from '../shared/protocol.js';

class TestClient {
  readonly socket: WebSocket;
  state: ClientSnapshot | null = null;
  private readonly listeners = new Set<() => void>();

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      if (message.type === 'state') {
        this.state = message.state;
        for (const listener of this.listeners) listener();
      }
    });
  }

  static async connect(): Promise<TestClient> {
    const socket = new WebSocket('ws://127.0.0.1:4242/ws');
    const client = new TestClient(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    await client.waitFor((state) => state.phase === 'lobby');
    return client;
  }

  send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  waitFor(predicate: (state: ClientSnapshot) => boolean, timeout = 8_000): Promise<ClientSnapshot> {
    if (this.state && predicate(this.state)) return Promise.resolve(this.state);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(check);
        reject(new Error('Timed out waiting for room state.'));
      }, timeout);
      const check = () => {
        if (this.state && predicate(this.state)) {
          clearTimeout(timer);
          this.listeners.delete(check);
          resolve(this.state);
        }
      };
      this.listeners.add(check);
    });
  }

  close(): void {
    this.socket.close();
  }
}

const health = await fetch('http://127.0.0.1:4242/api/health');
assert.equal(health.status, 200);

const host = await TestClient.connect();
host.send({ type: 'join', nickname: 'Host', color: '#b7ff38' });
const hostLobby = await host.waitFor((state) => state.selfId !== null);
const hostId = hostLobby.selfId as string;

const rival = await TestClient.connect();
rival.send({ type: 'join', nickname: 'Rival', color: '#ff6f61' });
const rivalLobby = await rival.waitFor((state) => state.selfId !== null && state.players.length === 2);
const rivalId = rivalLobby.selfId as string;
await host.waitFor((state) => state.players.length === 2);

host.send({ type: 'start' });
const hostDraft = await host.waitFor((state) => state.phase === 'draft' && state.draftOptions?.length === 3);
const rivalDraft = await rival.waitFor((state) => state.phase === 'draft' && state.draftOptions?.length === 3);
const drawnIds = [...(hostDraft.draftOptions ?? []), ...(rivalDraft.draftOptions ?? [])].map((card) => card.id);
assert.equal(new Set(drawnIds).size, 6, 'draft cards must be unique across players');

const hostPick = hostDraft.draftOptions?.[0];
const rivalPick = rivalDraft.draftOptions?.[0];
const matchId = hostDraft.matchId;
assert.ok(hostPick && rivalPick && matchId);
host.send({ type: 'select-fighter', matchId, fighterId: hostPick.id });
const hiddenView = await rival.waitFor((state) => state.phase === 'draft' && state.players.some((player) => player.id === hostId && player.locked));
assert.equal(hiddenView.players.find((player) => player.id === hostId)?.fighterId, null, 'opponent pick leaked before reveal');

rival.send({ type: 'select-fighter', matchId, fighterId: rivalPick.id });
await host.waitFor((state) => state.phase === 'reveal' && state.battle !== null);
const planning = await host.waitFor((state) => state.phase === 'planning', 8_000);
await rival.waitFor((state) => state.phase === 'planning', 8_000);
const hostFighter = planning.battle?.fighters[hostId];
const rivalFighter = planning.battle?.fighters[rivalId];
const round = planning.battle?.round;
assert.ok(hostFighter && rivalFighter && round);

host.send({ type: 'choose-action', matchId, round, action: { abilityId: hostFighter.card.abilities[0]?.id ?? '', targetIds: [rivalId] } });
rival.send({ type: 'choose-action', matchId, round, action: { abilityId: rivalFighter.card.abilities[0]?.id ?? '', targetIds: [hostId] } });
await host.waitFor((state) => state.intents.some((intent) => intent.playerId === hostId));
await rival.waitFor((state) => state.intents.some((intent) => intent.playerId === rivalId));
host.send({ type: 'lock-action', matchId, round });
rival.send({ type: 'lock-action', matchId, round });
const resolution = await host.waitFor((state) => state.phase === 'resolution');
assert.ok(resolution.lastEvents.some((event) => event.type === 'damage'));
assert.equal(resolution.intents.some((intent) => intent.playerId === rivalId), false, 'opponent intent leaked');

host.close();
rival.close();
console.log('HTTP, private draft, reveal, planning, intent filtering, and resolution smoke test passed.');
