import { describe, expect, it } from 'vitest';
import { fakeCards } from '../fixtures/fake-card-pack/cards.js';
import { chooseBotAction, runBotBattle } from './bots.js';
import { createBattle, eligibleTargets } from './engine.js';
import { SeededRng } from './rng.js';
import type { AbilityDefinition, BattleParticipant, CardDefinition } from './types.js';

function card(id: string, abilities: AbilityDefinition[]): CardDefinition {
  return {
    id,
    name: id,
    title: 'Bot fixture',
    quote: 'Beep.',
    archetype: 'Test',
    hp: 100,
    rarity: 'standard',
    accent: '#ffffff',
    accentAlt: '#000000',
    avatarSeed: 1,
    abilities,
  };
}

function strike(id: string, amount: number): AbilityDefinition {
  return {
    id,
    name: id,
    description: 'Damage.',
    target: 'enemy',
    priority: 2,
    cooldown: 0,
    effects: [{ kind: 'damage', amount }],
  };
}

function participant(id: string, teamId: string, definition: CardDefinition): BattleParticipant {
  return { id, teamId, name: id, card: definition };
}

describe('public-state bot policy', () => {
  it('uses a visible execute condition against the enemy it can finish', () => {
    const finisher: AbilityDefinition = {
      id: 'finish',
      name: 'Finish',
      description: 'More damage below 40%.',
      target: 'enemy',
      priority: 3,
      cooldown: 0,
      effects: [
        { kind: 'damage', amount: 30 },
        {
          kind: 'conditional',
          condition: { kind: 'target-hp-below', percent: 0.4 },
          effects: [{ kind: 'damage', amount: 30 }],
        },
      ],
    };
    const state = createBattle([
      participant('bot', 'bot', card('bot-card', [strike('jab', 25), finisher])),
      participant('healthy', 'healthy', card('healthy-card', [strike('healthy-hit', 1)])),
      participant('low', 'low', card('low-card', [strike('low-hit', 1)])),
    ], 'ffa', 1);
    state.fighters.low!.hp = 30;

    expect(chooseBotAction(state, 'bot', new SeededRng(5))).toEqual({
      actorId: 'bot',
      abilityId: 'finish',
      targetIds: ['low'],
    });
  });

  it('sends ally support to the teammate with the greatest visible need', () => {
    const heal: AbilityDefinition = {
      id: 'heal',
      name: 'Heal',
      description: 'Restore 40.',
      target: 'ally',
      priority: 0,
      cooldown: 0,
      effects: [{ kind: 'heal', amount: 40 }],
    };
    const state = createBattle([
      participant('bot', 'a', card('bot-card', [strike('hit', 20), heal])),
      participant('ally', 'a', card('ally-card', [strike('ally-hit', 1)])),
      participant('enemy', 'b', card('enemy-card', [strike('enemy-hit', 1)])),
    ], 'teams', 2);
    state.fighters.ally!.hp = 20;

    expect(chooseBotAction(state, 'bot', new SeededRng(6))).toMatchObject({
      abilityId: 'heal',
      targetIds: ['ally'],
    });
  });

  it('does not waste healing on a full-health team when damage is available', () => {
    const heal: AbilityDefinition = {
      id: 'heal',
      name: 'Heal',
      description: 'Restore 40.',
      target: 'ally',
      priority: 0,
      cooldown: 0,
      effects: [{ kind: 'heal', amount: 40 }],
    };
    const state = createBattle([
      participant('bot', 'a', card('bot-card', [strike('hit', 20), heal])),
      participant('ally', 'a', card('ally-card', [strike('ally-hit', 1)])),
      participant('enemy', 'b', card('enemy-card', [strike('enemy-hit', 1)])),
    ], 'teams', 3);

    expect(chooseBotAction(state, 'bot', new SeededRng(7))).toMatchObject({
      abilityId: 'hit',
      targetIds: ['enemy'],
    });
  });

  it('returns only legal declared targets while preserving random-enemy secrecy', () => {
    const random: AbilityDefinition = {
      id: 'random',
      name: 'Random',
      description: 'Engine-selected target.',
      target: 'random-enemy',
      priority: 2,
      cooldown: 0,
      effects: [{ kind: 'damage', amount: 100 }],
    };
    const state = createBattle([
      participant('bot', 'a', card('bot-card', [random])),
      participant('enemy-one', 'b', card('enemy-one-card', [strike('one', 1)])),
      participant('enemy-two', 'c', card('enemy-two-card', [strike('two', 1)])),
    ], 'ffa', 4);
    const action = chooseBotAction(state, 'bot', new SeededRng(8));
    const definition = state.fighters.bot!.card.abilities[0]!;

    expect(action?.targetIds).toEqual([]);
    expect(eligibleTargets(state, 'bot', definition)).toEqual(['enemy-one', 'enemy-two']);
  });

  it('is exactly reproducible from battle and action seeds', () => {
    const nova = fakeCards.find((candidate) => candidate.id === 'nova')!;
    const jo = fakeCards.find((candidate) => candidate.id === 'jo')!;
    const initial = createBattle([
      participant('nova', 'nova', nova),
      participant('jo', 'jo', jo),
    ], 'duel', 9_001);

    expect(runBotBattle(initial, 9_002)).toEqual(runBotBattle(initial, 9_002));
  });
});
