import { SeededRng } from './rng.js';
import { eligibleTargets, getAbilityAvailability, resolveRound } from './engine.js';
import type {
  AbilityDefinition,
  ActionChoice,
  BattleState,
  CombatantState,
  Condition,
  Effect,
  StatusKind,
} from './types.js';

const POSITIVE_STATUSES = new Set<StatusKind>([
  'damage-up',
  'resistant',
  'dodge',
  'reflect',
  'hot',
  'empowered',
]);

const NEGATIVE_STATUSES = new Set<StatusKind>([
  'damage-down',
  'vulnerable',
  'taunt',
  'dot',
  'disabled',
]);

interface ScoredAction {
  ability: AbilityDefinition;
  targetIds: string[];
  score: number;
}

export type BotPolicy = 'random' | 'varied' | 'tactical';

export interface BotBattleOptions {
  policy?: BotPolicy;
  onAction?: (action: Readonly<ActionChoice>, round: number) => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function hpRatio(fighter: CombatantState): number {
  return clamp(fighter.hp / fighter.card.hp, 0, 1);
}

function statusValue(fighter: CombatantState, kind: StatusKind): number {
  return fighter.statuses
    .filter((status) => status.kind === kind)
    .reduce((total, status) => total + (status.value ?? 0), 0);
}

/**
 * Evaluate only information that a player can see before lock-in. Chance branches
 * use their stated probability; no future RNG values or other players' choices are
 * inspected.
 */
function conditionProbability(
  condition: Condition,
  actor: CombatantState,
  target: CombatantState,
  round: number,
): number {
  switch (condition.kind) {
    case 'target-hp-below':
      return hpRatio(target) < condition.percent ? 1 : 0;
    case 'self-hp-below':
      return hpRatio(actor) < condition.percent ? 1 : 0;
    case 'round-at-least':
      return round >= condition.round ? 1 : 0;
    case 'target-has-status':
      return target.statuses.some((status) => status.kind === condition.status) ? 1 : 0;
    case 'damaged-by-target-last-round':
      return actor.damagedByLastRound.includes(target.id) ? 1 : 0;
    case 'chance':
      return condition.probability;
  }
}

function statusScore(
  actor: CombatantState,
  target: CombatantState,
  kind: StatusKind,
  value: number,
  duration: number,
): number {
  const friendly = actor.teamId === target.teamId;
  const useful = friendly ? POSITIVE_STATUSES.has(kind) : NEGATIVE_STATUSES.has(kind);
  const harmful = friendly ? NEGATIVE_STATUSES.has(kind) : POSITIVE_STATUSES.has(kind);
  const direction = useful ? 1 : harmful ? -1 : 0;
  const duplicateFactor = target.statuses.some((status) => status.kind === kind) ? 0.55 : 1;
  const urgency = 1 - hpRatio(target);
  const deferred = kind === 'dot' || kind === 'hot' || kind === 'taunt' || kind === 'disabled';
  // Immediate hostile setup is normally applied after this ability's own hit,
  // so a duration-2 Vulnerable is chiefly one future-round setup in a duel.
  // Friendly priority-0 buffs can help teammates in the current round as well.
  const usefulDuration = deferred || friendly ? duration : Math.max(1, duration - 1);

  let magnitude: number;
  switch (kind) {
    case 'dot':
      magnitude = value * usefulDuration * 0.85;
      break;
    case 'hot':
      magnitude = value * usefulDuration * (0.75 + urgency * 0.45);
      break;
    case 'empowered':
      magnitude = value * 1.6;
      break;
    case 'taunt':
      magnitude = 8 * usefulDuration;
      break;
    case 'disabled':
      magnitude = 16 * usefulDuration;
      break;
    default:
      magnitude = value * 55 * usefulDuration;
      break;
  }
  return direction * magnitude * duplicateFactor;
}

function effectScore(
  state: BattleState,
  actor: CombatantState,
  defaultTarget: CombatantState,
  effects: Effect[],
): number {
  let score = 0;

  for (const effect of effects) {
    const target = effect.recipient === 'self' || effect.kind === 'self-damage'
      ? actor
      : defaultTarget;
    const friendly = actor.teamId === target.teamId;
    const chance = effect.chance ?? 1;
    let value = 0;

    switch (effect.kind) {
      case 'damage': {
        const hits = effect.repeat ? (effect.repeat.min + effect.repeat.max) / 2 : 1;
        const empowered = statusValue(actor, 'empowered');
        const outgoing = Math.max(0, 1 + statusValue(actor, 'damage-up') - statusValue(actor, 'damage-down'));
        const incoming = Math.max(0, 1 + statusValue(target, 'vulnerable') - statusValue(target, 'resistant'));
        const dodge = clamp(statusValue(target, 'dodge'), 0, 0.9);
        const expected = (effect.amount * hits + empowered) * outgoing * incoming * (1 - dodge);
        const remaining = target.hp + target.shield;
        const koBonus = expected >= remaining ? 32 : Math.max(0, 8 - remaining * 0.08);
        const reflected = expected * clamp(statusValue(target, 'reflect'), 0, 1);
        value = friendly ? -expected * 1.5 : expected + koBonus - reflected * 0.8;
        break;
      }
      case 'heal': {
        const recovered = Math.min(effect.amount, Math.max(0, target.card.hp - target.hp));
        const urgency = 1 - hpRatio(target);
        value = (friendly ? 1 : -1) * recovered * (1.1 + urgency * 0.65);
        break;
      }
      case 'shield': {
        const urgency = 1 - hpRatio(target);
        const saturation = 1 / (1 + target.shield / target.card.hp);
        value = (friendly ? 1 : -1) * effect.amount * (0.42 + urgency * 0.9) * saturation;
        break;
      }
      case 'status':
        value = statusScore(
          actor,
          target,
          effect.status.kind,
          effect.status.value ?? 0,
          effect.status.duration,
        );
        break;
      case 'disable': {
        const remainingAbilities = target.card.abilities.filter(
          (ability) => !target.usedAbilities.includes(ability.id),
        ).length;
        value = (friendly ? -1 : 1) * (remainingAbilities > 0 ? 14 + effect.duration * 7 : 0);
        break;
      }
      case 'cleanse': {
        const removable = target.statuses.filter((status) => NEGATIVE_STATUSES.has(status.kind)).length;
        const count = Math.min(removable, effect.count ?? removable);
        value = (friendly ? 1 : -1) * count * 13;
        break;
      }
      case 'steal-status': {
        const stealable = target.statuses.filter((status) => POSITIVE_STATUSES.has(status.kind)).length;
        value = (friendly ? -1 : 1) * Math.min(stealable, effect.count ?? 1) * 15;
        break;
      }
      case 'self-damage': {
        const survivalPenalty = 1 + (1 - hpRatio(actor)) * 0.9;
        value = -effect.amount * survivalPenalty;
        break;
      }
      case 'conditional': {
        const probability = conditionProbability(effect.condition, actor, target, state.round);
        value = probability * effectScore(state, actor, target, effect.effects)
          + (1 - probability) * effectScore(state, actor, target, effect.otherwise ?? []);
        break;
      }
    }

    score += value * chance;
  }

  return score;
}

function scoreAbility(
  state: BattleState,
  actor: CombatantState,
  ability: AbilityDefinition,
  targetIds: string[],
): number {
  const validTargets = targetIds
    .map((targetId) => state.fighters[targetId])
    .filter((target): target is CombatantState => target !== undefined);
  const targetEffects = ability.effects.filter(
    (effect) => effect.recipient !== 'self' && effect.kind !== 'self-damage',
  );
  const selfEffects = ability.effects.filter(
    (effect) => effect.recipient === 'self' || effect.kind === 'self-damage',
  );

  const targetScore = ability.target === 'random-enemy'
    ? validTargets.length > 0
      ? validTargets.reduce((total, target) => total + effectScore(state, actor, target, targetEffects), 0)
        / validTargets.length
      : 0
    : validTargets.reduce(
        (total, target) => total + effectScore(state, actor, target, targetEffects),
        0,
      );

  const selfScore = effectScore(state, actor, actor, selfEffects);
  const scarcityPenalty = ability.oncePerMatch ? 2 : 0;
  const cooldownPenalty = ability.cooldown * 0.6;
  return targetScore + selfScore - scarcityPenalty - cooldownPenalty;
}

function candidateActions(
  state: BattleState,
  actor: CombatantState,
  ability: AbilityDefinition,
): Omit<ScoredAction, 'score'>[] {
  const targets = eligibleTargets(state, actor.id, ability);
  switch (ability.target) {
    case 'self':
      return [{ ability, targetIds: [actor.id] }];
    case 'ally':
    case 'enemy':
      return targets.map((targetId) => ({ ability, targetIds: [targetId] }));
    case 'all-enemies':
      return [{ ability, targetIds: targets }];
    case 'random-enemy':
      // The engine, not the bot, samples this target after everyone locks.
      return [{ ability, targetIds: [] }];
  }
}

export function chooseBotAction(
  state: BattleState,
  actorId: string,
  rng: SeededRng,
  policy: BotPolicy = 'varied',
): ActionChoice | null {
  const actor = state.fighters[actorId];
  if (!actor || actor.hp <= 0) return null;
  const available = actor.card.abilities.filter(
    (ability) => getAbilityAvailability(actor, ability, state.round).available,
  );
  if (available.length === 0) return null;

  if (policy === 'random') {
    const ability = rng.pick(available);
    const candidates = candidateActions(state, actor, ability);
    const selected = candidates.length > 0 ? rng.pick(candidates) : undefined;
    return selected
      ? { actorId, abilityId: selected.ability.id, targetIds: selected.targetIds }
      : null;
  }

  const scored = available
    .flatMap((ability) => candidateActions(state, actor, ability))
    .map((candidate) => {
      const scoringTargets = candidate.ability.target === 'random-enemy'
        ? eligibleTargets(state, actor.id, candidate.ability)
        : candidate.targetIds;
      return {
        ...candidate,
        score: scoreAbility(state, actor, candidate.ability, scoringTargets),
      };
    })
    .sort((left, right) => right.score - left.score || left.ability.id.localeCompare(right.ability.id));
  const bestPerAbility = available.flatMap((ability) => {
    const candidates = scored.filter((candidate) => candidate.ability.id === ability.id);
    if (candidates.length === 0) return [];
    // Targeting stays sharp (roughly "finish the visibly vulnerable fighter"),
    // while ability choice remains varied enough to model real players rather
    // than a deterministic solver.
    const selectedTarget = weightedPick(candidates, policy === 'tactical' ? 1.5 : 4, rng);
    return selectedTarget ? [selectedTarget] : [];
  });
  const bestScore = Math.max(...bestPerAbility.map((candidate) => candidate.score));
  const usefulAbilities = bestScore > 0
    ? bestPerAbility.filter((candidate) => candidate.score > 0)
    : bestPerAbility;
  const selected = weightedPick(usefulAbilities, policy === 'tactical' ? 2.5 : 7, rng);
  if (!selected) return null;

  return { actorId, abilityId: selected.ability.id, targetIds: selected.targetIds };
}

function weightedPick<T extends { score: number }>(items: readonly T[], temperature: number, rng: SeededRng): T | undefined {
  if (items.length === 0) return undefined;
  const best = Math.max(...items.map((item) => item.score));
  const weights = items.map((item) => Math.exp(Math.max(-50, (item.score - best) / temperature)));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let roll = rng.next() * total;
  for (let index = 0; index < items.length; index += 1) {
    roll -= weights[index] ?? 0;
    if (roll <= 0) return items[index];
  }
  return items.at(-1);
}

export function runBotBattle(
  initial: BattleState,
  actionSeed = initial.seed ^ 0x9e3779b9,
  options: BotBattleOptions = {},
): BattleState {
  let state = structuredClone(initial);
  const rng = new SeededRng(actionSeed);
  while (!state.finished) {
    const actions = Object.values(state.fighters)
      .map((fighter) => chooseBotAction(state, fighter.id, rng, options.policy))
      .filter((action): action is ActionChoice => action !== null);
    for (const action of actions) options.onAction?.(action, state.round);
    state = resolveRound(state, actions).state;
  }
  return state;
}
