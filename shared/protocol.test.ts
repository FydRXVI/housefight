import { describe, expect, it } from 'vitest';
import { isClientMessage } from './protocol.js';

describe('client protocol validation', () => {
  it('accepts every valid message family', () => {
    const messages = [
      { type: 'join', nickname: 'Ça va يا شباب', color: '#b7ff38' },
      { type: 'configure', config: { mode: 'teams', playlist: 'party' } },
      { type: 'add-bot' },
      { type: 'remove-bot', playerId: 'player' },
      { type: 'remove-player', playerId: 'player' },
      { type: 'switch-team', playerId: 'player' },
      { type: 'start' },
      { type: 'select-fighter', matchId: '12ABCDEF', fighterId: 'fighter' },
      { type: 'choose-action', matchId: '12ABCDEF', round: 3, action: { abilityId: 'hit', targetIds: ['target'] } },
      { type: 'lock-action', matchId: '12ABCDEF', round: 3 },
      { type: 'ready-resolution', matchId: '12ABCDEF', round: 3 },
      { type: 'resume' },
      { type: 'rematch' },
      { type: 'ping', sentAt: 123 },
    ];
    expect(messages.every(isClientMessage)).toBe(true);
  });

  it('rejects unknown, oversized, and malformed payloads', () => {
    const messages = [
      null,
      { type: 'cheat' },
      { type: 'join', nickname: 'x'.repeat(81), color: '#fff' },
      { type: 'configure', config: { mode: 'royale', playlist: 'party' } },
      { type: 'select-fighter', fighterId: 'fighter' },
      { type: 'select-fighter', matchId: 'not-a-match', fighterId: 'fighter' },
      { type: 'choose-action', matchId: '12ABCDEF', round: 1, action: { abilityId: 'hit', targetIds: 'everyone' } },
      { type: 'choose-action', matchId: '12ABCDEF', round: 1, action: { abilityId: 'hit', targetIds: Array(5).fill('target') } },
      { type: 'choose-action', matchId: '12ABCDEF', action: { abilityId: 'hit', targetIds: ['target'] } },
      { type: 'choose-action', matchId: '12ABCDEF', round: 0, action: { abilityId: 'hit', targetIds: ['target'] } },
      { type: 'lock-action' },
      { type: 'lock-action', matchId: '12ABCDEF', round: 13 },
      { type: 'ready-resolution', matchId: 'lowercase', round: 3 },
      { type: 'ping', sentAt: Number.NaN },
    ];
    expect(messages.some(isClientMessage)).toBe(false);
    expect(messages.every((message) => !isClientMessage(message))).toBe(true);
  });
});
