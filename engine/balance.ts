import { createBattle } from './engine.js';
import { runBotBattle } from './bots.js';
import type { BattleParticipant, CardDefinition, Condition, Effect } from './types.js';

export interface BalanceEstimate {
  hp: number;
  attack: number;
  defence: number;
  utility: number;
  reliability: number;
  total: number;
}

export interface SimulationReport {
  cardId: string;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  winRate: number;
  averageRounds: number;
  matchups: MatchupSimulationReport[];
}

export interface MatchupSimulationReport {
  opponentId: string;
  opponentName: string;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  equityRate: number;
  averageRounds: number;
}

type NumericEffectKind = 'damage' | 'heal' | 'shield';
const REFERENCE_HIT = 25;

function conditionProbability(condition: Condition): number {
  // Chance conditions have an exact expectation. Health, round and status
  // conditions depend on play, so the static budget values both branches
  // equally instead of pretending the bonus branch never exists.
  return condition.kind === 'chance' ? condition.probability : 0.5;
}

function repeatMean(effect: Effect): number {
  return effect.kind === 'damage' && effect.repeat
    ? (effect.repeat.min + effect.repeat.max) / 2
    : 1;
}

function numericEffectValue(effect: Effect, kind: NumericEffectKind): number {
  const chance = effect.chance ?? 1;
  let value = 0;

  if (effect.kind === kind) {
    value = effect.amount * repeatMean(effect);
  } else if (effect.kind === 'self-damage' && kind === 'shield') {
    value = -effect.amount;
  } else if (effect.kind === 'status') {
    const statusValue = effect.status.value ?? 0;
    const timedValue = statusValue * effect.status.duration;
    if (kind === 'damage') {
      if (effect.status.kind === 'dot') value = timedValue;
      if (effect.status.kind === 'empowered') value = statusValue;
      if (['damage-up', 'vulnerable'].includes(effect.status.kind)) value = REFERENCE_HIT * timedValue;
      if (effect.status.kind === 'reflect') value = REFERENCE_HIT * timedValue;
    }
    if (kind === 'heal' && effect.status.kind === 'hot') value = timedValue;
    if (kind === 'shield' && ['damage-down', 'resistant', 'dodge'].includes(effect.status.kind)) {
      value = REFERENCE_HIT * timedValue;
    }
  } else if (effect.kind === 'conditional') {
    const pass = conditionProbability(effect.condition);
    const onPass = effect.effects.reduce((total, nested) => total + numericEffectValue(nested, kind), 0);
    const otherwise = (effect.otherwise ?? [])
      .reduce((total, nested) => total + numericEffectValue(nested, kind), 0);
    value = onPass * pass + otherwise * (1 - pass);
  }

  return value * chance;
}

function effectValue(card: CardDefinition, kind: NumericEffectKind): number {
  return card.abilities
    .flatMap((ability) => ability.effects)
    .reduce((total, effect) => total + numericEffectValue(effect, kind), 0);
}

function utilityEffectValue(effect: Effect): number {
  const chance = effect.chance ?? 1;
  let value = 0;
  if (['status', 'disable', 'cleanse', 'steal-status'].includes(effect.kind)) {
    // Timed statuses have a larger budget footprint, while keeping a single
    // utility unit as the familiar baseline used by the admin UI.
    if (effect.kind === 'status') value = Math.max(1, effect.status.duration / 2);
    if (effect.kind === 'disable') value = Math.max(1, effect.duration / 2);
    if (effect.kind === 'cleanse' || effect.kind === 'steal-status') value = effect.count ?? 1;
  } else if (effect.kind === 'conditional') {
    const pass = conditionProbability(effect.condition);
    const onPass = effect.effects.reduce((total, nested) => total + utilityEffectValue(nested), 0);
    const otherwise = (effect.otherwise ?? [])
      .reduce((total, nested) => total + utilityEffectValue(nested), 0);
    value = onPass * pass + otherwise * (1 - pass);
  }
  return value * chance;
}

function uncertaintyCount(effect: Effect): number {
  let uncertainty = effect.chance === undefined ? 0 : 1;
  if (effect.kind === 'damage' && effect.repeat && effect.repeat.min !== effect.repeat.max) uncertainty += 1;
  if (effect.kind === 'conditional') {
    if (effect.condition.kind === 'chance') uncertainty += 1;
    uncertainty += effect.effects.reduce((total, nested) => total + uncertaintyCount(nested), 0);
    uncertainty += (effect.otherwise ?? [])
      .reduce((total, nested) => total + uncertaintyCount(nested), 0);
  }
  return uncertainty;
}

export function estimateCard(card: CardDefinition): BalanceEstimate {
  const hp = Math.round((card.hp / 105) * 100);
  const attack = Math.round((effectValue(card, 'damage') / 105) * 100);
  const defence = Math.round(((effectValue(card, 'shield') + effectValue(card, 'heal')) / 70) * 100);
  const utilityEffects = card.abilities
    .flatMap((ability) => ability.effects)
    .reduce((total, effect) => total + utilityEffectValue(effect), 0);
  const utility = Math.round(72 + utilityEffects * 8);
  const uncertainty = card.abilities
    .flatMap((ability) => ability.effects)
    .reduce((total, effect) => total + uncertaintyCount(effect), 0);
  const reliability = Math.max(65, 103 - uncertainty * 7);
  const total = Math.round(((hp + attack + defence + utility + reliability) / 5) * 10) / 10;
  return { hp, attack, defence, utility, reliability, total };
}

export function simulateCard(card: CardDefinition, opponents: CardDefinition[], games = 250): SimulationReport {
  const eligibleOpponents = opponents.filter((opponent) => opponent.id !== card.id);
  const requestedGames = Math.max(0, Math.floor(games));
  let wins = 0;
  let draws = 0;
  let rounds = 0;
  const matchupStats = new Map(eligibleOpponents.map((opponent) => [opponent.id, {
    opponent,
    games: 0,
    wins: 0,
    draws: 0,
    rounds: 0,
  }]));

  for (let index = 0; index < requestedGames && eligibleOpponents.length > 0; index += 1) {
    const pairIndex = Math.floor(index / 2);
    const opponent = eligibleOpponents[pairIndex % eligibleOpponents.length];
    if (!opponent) continue;
    const focus = { id: 'focus', name: card.name, teamId: 'focus', card };
    const rival = { id: 'opponent', name: opponent.name, teamId: 'opponent', card: opponent };
    const participants: BattleParticipant[] = index % 2 === 0 ? [focus, rival] : [rival, focus];
    const result = runBotBattle(createBattle(participants, 'duel', 10_000 + pairIndex));
    const focusWon = result.winnerPlayerIds?.includes('focus') ?? false;
    const opponentWon = result.winnerPlayerIds?.includes('opponent') ?? false;
    const isDraw = !focusWon && !opponentWon;
    if (focusWon) wins += 1;
    if (isDraw) draws += 1;
    rounds += result.round;
    const stats = matchupStats.get(opponent.id);
    if (stats) {
      stats.games += 1;
      stats.rounds += result.round;
      if (focusWon) stats.wins += 1;
      if (isDraw) stats.draws += 1;
    }
  }
  const completedGames = [...matchupStats.values()].reduce((total, stats) => total + stats.games, 0);
  const losses = completedGames - wins - draws;
  const matchups = [...matchupStats.values()].map((stats): MatchupSimulationReport => ({
    opponentId: stats.opponent.id,
    opponentName: stats.opponent.name,
    games: stats.games,
    wins: stats.wins,
    draws: stats.draws,
    losses: stats.games - stats.wins - stats.draws,
    equityRate: stats.games > 0 ? (stats.wins + stats.draws * 0.5) / stats.games : 0,
    averageRounds: stats.games > 0 ? stats.rounds / stats.games : 0,
  }));
  return {
    cardId: card.id,
    games: completedGames,
    wins,
    draws,
    losses,
    winRate: completedGames > 0 ? (wins + draws * 0.5) / completedGames : 0,
    averageRounds: completedGames > 0 ? rounds / completedGames : 0,
    matchups,
  };
}
