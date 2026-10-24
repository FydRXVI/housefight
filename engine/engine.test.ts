import { describe, expect, it } from 'vitest';
import { estimateCard, simulateCard } from './balance.js';
import { chooseBotAction } from './bots.js';
import { createDraft } from './draft.js';
import { createBattle, getAbilityAvailability, resolveRound } from './engine.js';
import { SeededRng } from './rng.js';
import { fakeCards } from '../fixtures/fake-card-pack/cards.js';
import type { AbilityDefinition, BattleParticipant, CardDefinition } from './types.js';

function testCard(
  id: string,
  hp: number,
  abilities: AbilityDefinition[],
): CardDefinition {
  return {
    id,
    name: id.toUpperCase(),
    title: 'Test Fighter',
    quote: 'For science.',
    archetype: 'Test',
    hp,
    rarity: 'standard',
    accent: '#fff',
    accentAlt: '#000',
    avatarSeed: 1,
    abilities,
  };
}

const strike = (id: string, amount: number, cooldown = 0, priority: 0 | 1 | 2 | 3 = 2): AbilityDefinition => ({
  id,
  name: 'Strike',
  description: 'Hit.',
  target: 'enemy',
  priority,
  cooldown,
  effects: [{ kind: 'damage', amount }],
});

function participant(id: string, teamId: string, card: CardDefinition): BattleParticipant {
  return { id, teamId, name: id.toUpperCase(), card };
}

describe('deterministic combat engine', () => {
  it('resolves identically from the same state and choices', () => {
    const nova = fakeCards.find((card) => card.id === 'nova');
    const jo = fakeCards.find((card) => card.id === 'jo');
    expect(nova).toBeDefined();
    expect(jo).toBeDefined();
    const battle = createBattle([
      participant('p1', 'p1', nova as CardDefinition),
      participant('p2', 'p2', jo as CardDefinition),
    ], 'duel', 827_451_922);
    const actions = [
      { actorId: 'p1', abilityId: 'nova-1', targetIds: ['p2'] },
      { actorId: 'p2', abilityId: 'jo-2', targetIds: ['p1'] },
    ];

    expect(resolveRound(battle, actions)).toEqual(resolveRound(battle, actions));
  });

  it('allows every fighter alive at lock time to act, producing a double KO', () => {
    const a = testCard('a', 50, [strike('a-hit', 50)]);
    const b = testCard('b', 50, [strike('b-hit', 50)]);
    const battle = createBattle([participant('a', 'a', a), participant('b', 'b', b)], 'duel', 10);
    const result = resolveRound(battle, [
      { actorId: 'a', abilityId: 'a-hit', targetIds: ['b'] },
      { actorId: 'b', abilityId: 'b-hit', targetIds: ['a'] },
    ]);

    expect(result.state.fighters.a?.hp).toBe(0);
    expect(result.state.fighters.b?.hp).toBe(0);
    expect(result.state.finished).toBe(true);
    expect(result.state.winnerPlayerIds).toEqual([]);
    expect(result.events.some((event) => event.message.includes('DOUBLE KO'))).toBe(true);
  });

  it('honors protection priority before standard damage', () => {
    const guard: AbilityDefinition = {
      id: 'guard',
      name: 'Guard',
      description: 'Shield.',
      target: 'self',
      priority: 0,
      cooldown: 0,
      effects: [{ kind: 'shield', amount: 30 }],
    };
    const a = testCard('a', 60, [guard]);
    const b = testCard('b', 60, [strike('hit', 40, 0, 2)]);
    const result = resolveRound(
      createBattle([participant('a', 'a', a), participant('b', 'b', b)], 'duel', 11),
      [
        { actorId: 'a', abilityId: 'guard', targetIds: ['a'] },
        { actorId: 'b', abilityId: 'hit', targetIds: ['a'] },
      ],
    );
    expect(result.state.fighters.a?.hp).toBe(50);
    expect(result.state.fighters.a?.shield).toBe(0);
  });

  it('reduces direct FFA dogpile damage from three different attackers', () => {
    const victim = testCard('victim', 100, [strike('poke', 1)]);
    const attacker = (id: string) => testCard(id, 100, [strike(`${id}-hit`, 30)]);
    const battle = createBattle([
      participant('victim', 'victim', victim),
      participant('a', 'a', attacker('a')),
      participant('b', 'b', attacker('b')),
      participant('c', 'c', attacker('c')),
    ], 'ffa', 12);
    const result = resolveRound(battle, [
      { actorId: 'victim', abilityId: 'poke', targetIds: ['a'] },
      { actorId: 'a', abilityId: 'a-hit', targetIds: ['victim'] },
      { actorId: 'b', abilityId: 'b-hit', targetIds: ['victim'] },
      { actorId: 'c', abilityId: 'c-hit', targetIds: ['victim'] },
    ]);

    expect(result.state.fighters.victim?.hp).toBe(37);
    expect(result.events.some((event) => event.message.includes('MOBBED by 3 attackers'))).toBe(true);
  });

  it('never applies the FFA mob rule to legitimate team focus fire', () => {
    const target = testCard('target', 100, [strike('target-hit', 1)]);
    const attacker = (id: string) => testCard(id, 100, [strike(`${id}-hit`, 30)]);
    const result = resolveRound(createBattle([
      participant('a', 'team-a', attacker('a')),
      participant('b', 'team-b', target),
      participant('c', 'team-a', attacker('c')),
      participant('d', 'team-b', attacker('d')),
    ], 'teams', 29), [
      { actorId: 'a', abilityId: 'a-hit', targetIds: ['b'] },
      { actorId: 'c', abilityId: 'c-hit', targetIds: ['b'] },
      { actorId: 'b', abilityId: 'target-hit', targetIds: ['a'] },
      { actorId: 'd', abilityId: 'd-hit', targetIds: ['a'] },
    ]);
    expect(result.state.fighters.b?.hp).toBe(40);
    expect(result.events.some((event) => event.message.includes('MOBBED'))).toBe(false);
  });

  it('keeps cooldowns unavailable for the following planning round', () => {
    const a = testCard('a', 100, [strike('heavy', 10, 1), strike('light', 1)]);
    const b = testCard('b', 100, [strike('reply', 1)]);
    const roundTwo = resolveRound(
      createBattle([participant('a', 'a', a), participant('b', 'b', b)], 'duel', 13),
      [
        { actorId: 'a', abilityId: 'heavy', targetIds: ['b'] },
        { actorId: 'b', abilityId: 'reply', targetIds: ['a'] },
      ],
    ).state;
    const heavy = roundTwo.fighters.a?.card.abilities[0];
    expect(heavy).toBeDefined();
    expect(getAbilityAvailability(roundTwo.fighters.a as NonNullable<typeof roundTwo.fighters.a>, heavy as AbilityDefinition, roundTwo.round)).toEqual({
      available: false,
      reason: '1 ROUND',
    });
  });

  it('remembers who caused damage for next-round conditional effects', () => {
    const revenge: AbilityDefinition = {
      id: 'revenge',
      name: 'Revenge',
      description: 'Hit back harder.',
      target: 'enemy',
      priority: 2,
      cooldown: 0,
      effects: [{
        kind: 'conditional',
        condition: { kind: 'damaged-by-target-last-round' },
        effects: [{ kind: 'damage', amount: 40 }],
        otherwise: [{ kind: 'damage', amount: 10 }],
      }],
    };
    const a = testCard('a', 100, [revenge]);
    const b = testCard('b', 100, [strike('hit', 10)]);
    const afterOne = resolveRound(
      createBattle([participant('a', 'a', a), participant('b', 'b', b)], 'duel', 14),
      [
        { actorId: 'a', abilityId: 'revenge', targetIds: ['b'] },
        { actorId: 'b', abilityId: 'hit', targetIds: ['a'] },
      ],
    ).state;
    const afterTwo = resolveRound(afterOne, [
      { actorId: 'a', abilityId: 'revenge', targetIds: ['b'] },
      { actorId: 'b', abilityId: 'hit', targetIds: ['a'] },
    ]).state;

    expect(afterTwo.fighters.b?.hp).toBe(50);
  });

  it('expires one-round immediate defence after the application round', () => {
    const dodge: AbilityDefinition = {
      id: 'dodge',
      name: 'Dodge',
      description: 'Avoid this round.',
      target: 'self',
      priority: 0,
      cooldown: 0,
      effects: [{ kind: 'status', status: { kind: 'dodge', label: 'Untouchable', duration: 1, value: 1 } }],
    };
    const a = testCard('a', 100, [dodge, strike('a-hit', 10)]);
    const b = testCard('b', 100, [strike('b-hit', 30)]);
    const afterOne = resolveRound(createBattle([
      participant('a', 'a', a), participant('b', 'b', b),
    ], 'duel', 21), [
      { actorId: 'a', abilityId: 'dodge', targetIds: ['a'] },
      { actorId: 'b', abilityId: 'b-hit', targetIds: ['a'] },
    ]).state;
    expect(afterOne.fighters.a?.hp).toBe(100);
    expect(afterOne.fighters.a?.statuses.some((status) => status.kind === 'dodge')).toBe(false);

    const afterTwo = resolveRound(afterOne, [
      { actorId: 'a', abilityId: 'a-hit', targetIds: ['b'] },
      { actorId: 'b', abilityId: 'b-hit', targetIds: ['a'] },
    ]).state;
    expect(afterTwo.fighters.a?.hp).toBe(70);
  });

  it('keeps taunt and disable active for the following planning round', () => {
    const taunt: AbilityDefinition = {
      id: 'taunt', name: 'Taunt', description: 'Look at me.', target: 'enemy', priority: 2, cooldown: 0,
      effects: [{ kind: 'status', status: { kind: 'taunt', label: 'Distracted', duration: 1 } }],
    };
    const disable: AbilityDefinition = {
      id: 'disable', name: 'Disable', description: 'No move.', target: 'enemy', priority: 1, cooldown: 0,
      effects: [{ kind: 'disable', duration: 1 }],
    };
    const a = testCard('a', 100, [taunt, disable, strike('a-hit', 1)]);
    const b = testCard('b', 100, [strike('b-hit', 10)]);
    const c = testCard('c', 100, [strike('c-hit', 10)]);
    const afterTaunt = resolveRound(createBattle([
      participant('a', 'a', a), participant('b', 'b', b), participant('c', 'c', c),
    ], 'ffa', 22), [
      { actorId: 'a', abilityId: 'taunt', targetIds: ['b'] },
      { actorId: 'b', abilityId: 'b-hit', targetIds: ['c'] },
      { actorId: 'c', abilityId: 'c-hit', targetIds: ['a'] },
    ]).state;
    const afterRedirect = resolveRound(afterTaunt, [
      { actorId: 'b', abilityId: 'b-hit', targetIds: ['c'] },
    ]).state;
    expect(afterRedirect.fighters.a?.hp).toBe(80);
    expect(afterRedirect.fighters.c?.hp).toBe(90);

    const afterDisable = resolveRound(createBattle([
      participant('a', 'a', a), participant('b', 'b', b),
    ], 'duel', 23), [
      { actorId: 'a', abilityId: 'disable', targetIds: ['b'] },
      { actorId: 'b', abilityId: 'b-hit', targetIds: ['a'] },
    ]).state;
    const bHit = afterDisable.fighters.b?.card.abilities[0] as AbilityDefinition;
    expect(getAbilityAvailability(afterDisable.fighters.b as NonNullable<typeof afterDisable.fighters.b>, bHit, afterDisable.round).available).toBe(false);
    const afterDisabledRound = resolveRound(afterDisable, [
      { actorId: 'a', abilityId: 'a-hit', targetIds: ['b'] },
    ]).state;
    expect(getAbilityAvailability(afterDisabledRound.fighters.b as NonNullable<typeof afterDisabledRound.fighters.b>, bHit, afterDisabledRound.round).available).toBe(true);
  });

  it('ticks a two-round damage-over-time status exactly twice', () => {
    const dot: AbilityDefinition = {
      id: 'dot', name: 'Dot', description: 'Later.', target: 'enemy', priority: 2, cooldown: 0,
      effects: [{ kind: 'status', status: { kind: 'dot', label: 'Burning', duration: 2, value: 10 } }],
    };
    const a = testCard('a', 100, [dot]);
    const b = testCard('b', 100, [strike('b-hit', 1)]);
    const roundTwo = resolveRound(createBattle([
      participant('a', 'a', a), participant('b', 'b', b),
    ], 'duel', 24), [{ actorId: 'a', abilityId: 'dot', targetIds: ['b'] }]).state;
    const roundThree = resolveRound(roundTwo, []).state;
    const roundFour = resolveRound(roundThree, []).state;
    const roundFive = resolveRound(roundFour, []).state;
    expect([roundTwo.fighters.b?.hp, roundThree.fighters.b?.hp, roundFour.fighters.b?.hp, roundFive.fighters.b?.hp]).toEqual([100, 90, 80, 80]);
  });

  it('applies FFA mob reduction to nested and random direct attacks', () => {
    const nested = (id: string, target: AbilityDefinition['target'] = 'enemy'): AbilityDefinition => ({
      id: `${id}-nested`, name: 'Nested', description: 'Conditional hit.', target, priority: 2, cooldown: 0,
      effects: [{ kind: 'conditional', condition: { kind: 'round-at-least', round: 1 }, effects: [{ kind: 'damage', amount: 30 }] }],
    });
    const victim = testCard('victim', 100, [strike('victim-poke', 1)]);
    const a = testCard('a', 100, [nested('a')]);
    const b = testCard('b', 100, [nested('b')]);
    const c = testCard('c', 100, [nested('c', 'random-enemy')]);
    const result = resolveRound(createBattle([
      participant('victim', 'victim', victim), participant('a', 'a', a), participant('b', 'b', b), participant('c', 'c', c),
    ], 'ffa', 2), [
      { actorId: 'victim', abilityId: 'victim-poke', targetIds: ['a'] },
      { actorId: 'a', abilityId: 'a-nested', targetIds: ['victim'] },
      { actorId: 'b', abilityId: 'b-nested', targetIds: ['victim'] },
      { actorId: 'c', abilityId: 'c-nested', targetIds: [] },
    ]);
    const randomTarget = result.events.find((event) => event.actorId === 'c' && event.type === 'damage')?.targetId;
    const expectedVictimHp = randomTarget === 'victim' ? 37 : 48;
    expect(result.state.fighters.victim?.hp).toBe(expectedVictimHp);
  });

  it('emits KO once and attributes reflected damage to its source', () => {
    const reflect: AbilityDefinition = {
      id: 'reflect', name: 'Reflect', description: 'Bounce.', target: 'self', priority: 0, cooldown: 0,
      effects: [{ kind: 'status', status: { kind: 'reflect', label: 'Mirror', duration: 1, value: 0.5 } }],
    };
    const a = testCard('a', 100, [strike('a-hit', 40), strike('a-ko', 100)]);
    const b = testCard('b', 100, [reflect, strike('b-hit', 1)]);
    const c = testCard('c', 100, [strike('c-hit', 1)]);
    const reflected = resolveRound(createBattle([
      participant('a', 'a', a), participant('b', 'b', b),
    ], 'duel', 25), [
      { actorId: 'a', abilityId: 'a-hit', targetIds: ['b'] },
      { actorId: 'b', abilityId: 'reflect', targetIds: ['b'] },
    ]).state;
    expect(reflected.fighters.a?.damagedByLastRound).toContain('b');

    const first = resolveRound(createBattle([
      participant('a', 'a', a), participant('b', 'b', b), participant('c', 'c', c),
    ], 'ffa', 26), [
      { actorId: 'a', abilityId: 'a-ko', targetIds: ['b'] },
      { actorId: 'b', abilityId: 'b-hit', targetIds: ['a'] },
      { actorId: 'c', abilityId: 'c-hit', targetIds: ['a'] },
    ]);
    expect(first.events.filter((event) => event.type === 'ko' && event.targetId === 'b')).toHaveLength(1);
    const second = resolveRound(first.state, [
      { actorId: 'a', abilityId: 'a-hit', targetIds: ['c'] },
      { actorId: 'c', abilityId: 'c-hit', targetIds: ['a'] },
    ]);
    expect(second.events.some((event) => event.type === 'ko' && event.targetId === 'b')).toBe(false);
  });

  it('keeps random-enemy bot intent honestly targetless until resolution', () => {
    const random: AbilityDefinition = {
      id: 'random', name: 'Chaos', description: 'Random.', target: 'random-enemy', priority: 2, cooldown: 0,
      effects: [{ kind: 'damage', amount: 10 }],
    };
    const state = createBattle([
      participant('a', 'a', testCard('a', 100, [random])),
      participant('b', 'b', testCard('b', 100, [strike('b-hit', 1)])),
      participant('c', 'c', testCard('c', 100, [strike('c-hit', 1)])),
    ], 'ffa', 27);
    expect(chooseBotAction(state, 'a', new SeededRng(28))?.targetIds).toEqual([]);
  });

  it('resolves healing-over-time before damage-over-time regardless of insertion order', () => {
    const a = testCard('a', 100, [strike('a-hit', 1)]);
    const b = testCard('b', 100, [strike('b-hit', 1)]);
    const state = createBattle([participant('a', 'a', a), participant('b', 'b', b)], 'duel', 30);
    const fighter = state.fighters.a as NonNullable<typeof state.fighters.a>;
    fighter.hp = 10;
    fighter.statuses = [
      { id: 'dot', sourceId: 'b', kind: 'dot', label: 'Burning', duration: 1, value: 20 },
      { id: 'hot', sourceId: 'a', kind: 'hot', label: 'Soup', duration: 1, value: 20 },
    ];
    const result = resolveRound(state, []);
    expect(result.state.fighters.a?.hp).toBe(10);
  });

  it('allows a locked slow heal to rescue a fighter before death is finalized', () => {
    const heal: AbilityDefinition = {
      id: 'heal', name: 'Second Wind', description: 'Get back up.', target: 'self', priority: 3, cooldown: 0,
      effects: [{ kind: 'heal', amount: 22 }],
    };
    const a = testCard('a', 50, [heal]);
    const b = testCard('b', 100, [strike('b-hit', 60)]);
    const result = resolveRound(createBattle([
      participant('a', 'a', a), participant('b', 'b', b),
    ], 'duel', 31), [
      { actorId: 'a', abilityId: 'heal', targetIds: ['a'] },
      { actorId: 'b', abilityId: 'b-hit', targetIds: ['a'] },
    ]);
    expect(result.state.fighters.a?.hp).toBe(22);
    expect(result.state.finished).toBe(false);
  });
});

describe('draft', () => {
  it('deals three unique standard cards per player in balanced mode', () => {
    const result = createDraft(['a', 'b', 'c', 'd'], fakeCards, 'balanced', new SeededRng(99));
    const cards = Object.values(result.options).flat();
    expect(cards).toHaveLength(12);
    expect(new Set(cards.map((card) => card.id)).size).toBe(12);
    expect(cards.every((card) => card.rarity === 'standard')).toBe(true);
    expect(result.cursedPlayerId).toBeNull();
  });

  it('keeps Party bosses and curses possible but rarer than Standard cards', () => {
    const appearances = new Map(fakeCards.map((card) => [card.id, 0]));
    let cursedMatches = 0;
    const samples = 5_000;
    for (let seed = 1; seed <= samples; seed += 1) {
      const result = createDraft(['a', 'b'], fakeCards, 'party', new SeededRng(seed));
      for (const card of Object.values(result.options).flat()) {
        appearances.set(card.id, (appearances.get(card.id) ?? 0) + 1);
      }
      if (result.cursedPlayerId) cursedMatches += 1;
    }

    const boss = fakeCards.find((card) => card.rarity === 'boss');
    const curse = fakeCards.find((card) => card.rarity === 'cursed');
    const standardCounts = fakeCards
      .filter((card) => card.rarity === 'standard')
      .map((card) => appearances.get(card.id) ?? 0);
    expect(boss).toBeDefined();
    expect(curse).toBeDefined();
    expect(appearances.get(boss?.id ?? '')).toBeGreaterThan(0);
    expect(appearances.get(boss?.id ?? '')).toBeLessThan(Math.min(...standardCounts));
    expect(appearances.get(curse?.id ?? '')).toBeGreaterThan(0);
    expect(cursedMatches / samples).toBeGreaterThan(0.08);
    expect(cursedMatches / samples).toBeLessThan(0.12);
  });
});

describe('standard card pack', () => {
  it('evaluates a card against every opponent with seat rotation and fair draw equity', () => {
    const focus = testCard('sim-focus', 80, [strike('sim-focus-hit', 80)]);
    const opponentA = testCard('sim-a', 80, [strike('sim-a-hit', 80)]);
    const opponentB = testCard('sim-b', 80, [strike('sim-b-hit', 80)]);
    const report = simulateCard(focus, [opponentA, opponentB], 24);

    expect(report.games).toBe(24);
    expect(report.matchups).toHaveLength(2);
    expect(report.matchups.every((matchup) => matchup.games === 12)).toBe(true);
    expect(report.wins + report.draws + report.losses).toBe(report.games);
    expect(report.winRate).toBe((report.wins + report.draws * 0.5) / report.games);
    expect(simulateCard(focus, [opponentA, opponentB], 24)).toEqual(report);
  });

  it('budgets repeated, delayed and nested effects instead of ignoring them', () => {
    const plain = testCard('plain-budget', 105, [strike('plain-hit', 10)]);
    const structured = testCard('structured-budget', 105, [{
      id: 'structured-effects',
      name: 'Structured effects',
      description: 'Exercise the static estimator.',
      target: 'enemy',
      priority: 2,
      cooldown: 0,
      effects: [
        { kind: 'damage', amount: 10, repeat: { min: 2, max: 4 } },
        { kind: 'status', status: { kind: 'dot', label: 'Later damage', duration: 2, value: 5 } },
        {
          kind: 'conditional',
          condition: { kind: 'target-hp-below', percent: 0.5 },
          effects: [{ kind: 'damage', amount: 20 }],
          otherwise: [{ kind: 'damage', amount: 4 }],
        },
        {
          kind: 'conditional',
          condition: { kind: 'self-hp-below', percent: 0.5 },
          effects: [{ kind: 'shield', amount: 20 }, { kind: 'heal', amount: 10 }],
          otherwise: [{ kind: 'shield', amount: 10 }],
        },
      ],
    }]);

    const baseline = estimateCard(plain);
    const estimate = estimateCard(structured);
    expect(estimate.attack).toBe(50);
    expect(estimate.defence).toBe(29);
    expect(estimate.attack).toBeGreaterThan(baseline.attack);
    // Threshold conditions are predictable game state; only the variable
    // 2–4-hit repeat contributes uncertainty here.
    expect(estimate.reliability).toBe(96);
  });

  it('counts chance and variable repeats as reliability costs at any nesting depth', () => {
    const card = testCard('uncertain-budget', 105, [{
      id: 'uncertain-effects',
      name: 'Uncertain effects',
      description: 'Exercise uncertainty.',
      target: 'enemy',
      priority: 2,
      cooldown: 0,
      effects: [{
        kind: 'conditional',
        condition: { kind: 'chance', probability: 0.5 },
        effects: [{ kind: 'damage', amount: 10, chance: 0.5, repeat: { min: 1, max: 3 } }],
      }],
    }]);

    expect(estimateCard(card).reliability).toBe(82);
  });

  it('reflects status magnitude and self-damage in the static power budget', () => {
    const low = testCard('low-status-budget', 105, [{
      id: 'low-status', name: 'Low status', description: 'Small modifiers.', target: 'self', priority: 0, cooldown: 0,
      effects: [
        { kind: 'status', status: { kind: 'damage-up', label: 'Small boost', duration: 1, value: 0.1 } },
        { kind: 'status', status: { kind: 'resistant', label: 'Small guard', duration: 1, value: 0.1 } },
      ],
    }]);
    const high = testCard('high-status-budget', 105, [{
      id: 'high-status', name: 'High status', description: 'Large modifiers.', target: 'self', priority: 0, cooldown: 0,
      effects: [
        { kind: 'status', status: { kind: 'damage-up', label: 'Large boost', duration: 2, value: 0.2 } },
        { kind: 'status', status: { kind: 'resistant', label: 'Large guard', duration: 2, value: 0.2 } },
      ],
    }]);
    const costly = structuredClone(high);
    costly.id = 'costly-status-budget';
    costly.abilities[0]?.effects.push({ kind: 'self-damage', amount: 10 });

    expect(estimateCard(high).attack).toBeGreaterThan(estimateCard(low).attack);
    expect(estimateCard(high).defence).toBeGreaterThan(estimateCard(low).defence);
    expect(estimateCard(costly).defence).toBeLessThan(estimateCard(high).defence);
  });

  it('keeps the intentionally unfair and cursed fixtures distinct in the static budget', () => {
    const standards = fakeCards.filter((card) => card.rarity === 'standard').map(estimateCard);
    const boss = fakeCards.find((card) => card.rarity === 'boss');
    const cursed = fakeCards.find((card) => card.rarity === 'cursed');
    expect(boss).toBeDefined();
    expect(cursed).toBeDefined();
    expect(estimateCard(boss as CardDefinition).total).toBeGreaterThan(
      Math.max(...standards.map((estimate) => estimate.total)),
    );
    expect(estimateCard(cursed as CardDefinition).total).toBeLessThan(
      Math.min(...standards.map((estimate) => estimate.total)),
    );
  });

  it('gives Rami a thematic crowd-pressure option without changing his duel output', () => {
    const rami = fakeCards.find((card) => card.id === 'rami');
    const everybodyHeardThat = rami?.abilities.find((ability) => ability.id === 'rami-3');
    expect(everybodyHeardThat).toMatchObject({
      target: 'all-enemies',
      effects: [
        { kind: 'damage', amount: 14 },
        { kind: 'status', status: { kind: 'vulnerable', duration: 2, value: 0.2 } },
      ],
    });
  });

  it('uses four data-defined abilities with globally unique ids', () => {
    const abilities = fakeCards.flatMap((card) => card.abilities);
    expect(fakeCards.every((card) => card.abilities.length === 4)).toBe(true);
    expect(new Set(abilities.map((ability) => ability.id)).size).toBe(abilities.length);
  });
});
