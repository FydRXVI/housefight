import { SeededRng } from './rng.js';
import type {
  AbilityAvailability,
  AbilityDefinition,
  ActionChoice,
  BattleEvent,
  BattleParticipant,
  BattleState,
  CombatantState,
  Condition,
  Effect,
  ResolutionResult,
  StatusInstance,
  StatusKind,
} from './types.js';

const NEGATIVE_STATUSES = new Set<StatusKind>([
  'damage-down',
  'vulnerable',
  'taunt',
  'dot',
  'disabled',
]);

const POSITIVE_STATUSES = new Set<StatusKind>([
  'damage-up',
  'resistant',
  'dodge',
  'reflect',
  'hot',
  'empowered',
]);

/** These effects cannot influence the round in which they are created. */
const DEFERRED_STATUSES = new Set<StatusKind>(['dot', 'hot', 'taunt', 'disabled']);

const MAX_ROUNDS = 12;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function eventId(events: BattleEvent[]): string {
  return `event-${events.length + 1}`;
}

function pushEvent(events: BattleEvent[], event: Omit<BattleEvent, 'id'>): void {
  events.push({ ...event, id: eventId(events) });
}

export function createBattle(
  participants: BattleParticipant[],
  mode: BattleState['mode'],
  seed: number,
): BattleState {
  const rng = new SeededRng(seed);
  const fighters = Object.fromEntries(
    participants.map((participant) => [
      participant.id,
      {
        id: participant.id,
        name: participant.name,
        teamId: participant.teamId,
        card: participant.card,
        hp: participant.card.hp,
        shield: 0,
        statuses: [],
        cooldowns: {},
        usedAbilities: [],
        damagedByLastRound: [],
      } satisfies CombatantState,
    ]),
  );

  return {
    seed,
    rngState: rng.getState(),
    mode,
    round: 1,
    fighters,
    finished: false,
    winnerPlayerIds: null,
  };
}

export function getAbilityAvailability(
  fighter: CombatantState,
  ability: AbilityDefinition,
  round: number,
): AbilityAvailability {
  if (fighter.hp <= 0) return { available: false, reason: 'KO' };
  if ((ability.availableFromRound ?? 1) > round) {
    return { available: false, reason: `ROUND ${ability.availableFromRound}` };
  }
  if ((fighter.cooldowns[ability.id] ?? 0) > 0) {
    return { available: false, reason: `${fighter.cooldowns[ability.id]} ROUND` };
  }
  if (ability.oncePerMatch && fighter.usedAbilities.includes(ability.id)) {
    return { available: false, reason: 'USED' };
  }
  const disabled = fighter.statuses.find(
    (status) => status.kind === 'disabled' && status.abilityId === ability.id,
  );
  if (disabled) return { available: false, reason: disabled.label.toUpperCase() };
  return { available: true };
}

export function eligibleTargets(
  state: BattleState,
  actorId: string,
  ability: AbilityDefinition,
): string[] {
  const actor = state.fighters[actorId];
  if (!actor) return [];
  const living = Object.values(state.fighters).filter((fighter) => fighter.hp > 0);
  const enemies = living.filter((fighter) => fighter.teamId !== actor.teamId);
  const allies = living.filter((fighter) => fighter.teamId === actor.teamId);

  switch (ability.target) {
    case 'self':
      return [actorId];
    case 'ally':
      return allies.map((fighter) => fighter.id);
    case 'enemy':
    case 'random-enemy':
    case 'all-enemies':
      return enemies.map((fighter) => fighter.id);
  }
}

function statusTotal(fighter: CombatantState, kind: StatusKind): number {
  return fighter.statuses
    .filter((status) => status.kind === kind)
    .reduce((total, status) => total + (status.value ?? 0), 0);
}

function findAbility(fighter: CombatantState, abilityId: string): AbilityDefinition | undefined {
  return fighter.card.abilities.find((ability) => ability.id === abilityId);
}

function validateActions(state: BattleState, actions: ActionChoice[]): ActionChoice[] {
  const byActor = new Map(actions.map((action) => [action.actorId, action]));
  return Object.values(state.fighters)
    .filter((fighter) => fighter.hp > 0)
    .flatMap((fighter) => {
      const action = byActor.get(fighter.id);
      if (!action) return [];
      const ability = findAbility(fighter, action.abilityId);
      if (!ability || !getAbilityAvailability(fighter, ability, state.round).available) return [];
      return [action];
    });
}

function resolvedTargetIds(
  state: BattleState,
  action: ActionChoice,
  ability: AbilityDefinition,
  rng: SeededRng,
): string[] {
  const valid = eligibleTargets(state, action.actorId, ability);
  const actor = state.fighters[action.actorId];
  if (!actor) return [];

  if (ability.target === 'self') return [actor.id];
  if (ability.target === 'all-enemies') return valid;
  if (ability.target === 'random-enemy') return valid.length > 0 ? [rng.pick(valid)] : [];

  const taunt = actor.statuses.find(
    (status) => status.kind === 'taunt' && state.fighters[status.sourceId]?.hp && valid.includes(status.sourceId),
  );
  if (ability.target === 'enemy' && taunt) return [taunt.sourceId];

  const requested = action.targetIds.find((targetId) => valid.includes(targetId));
  return requested ? [requested] : valid.slice(0, 1);
}

function conditionPasses(
  condition: Condition,
  actor: CombatantState,
  target: CombatantState,
  round: number,
  rng: SeededRng,
): boolean {
  switch (condition.kind) {
    case 'target-hp-below':
      return target.hp / target.card.hp < condition.percent;
    case 'self-hp-below':
      return actor.hp / actor.card.hp < condition.percent;
    case 'round-at-least':
      return round >= condition.round;
    case 'target-has-status':
      return target.statuses.some((status) => status.kind === condition.status);
    case 'damaged-by-target-last-round':
      return actor.damagedByLastRound.includes(target.id);
    case 'chance':
      return rng.next() < condition.probability;
  }
}

function applyDamage(
  actor: CombatantState,
  target: CombatantState,
  baseAmount: number,
  mobMultiplier: number,
  rng: SeededRng,
  events: BattleEvent[],
  damagedThisRound: Map<string, Set<string>>,
): number {
  const dodge = clamp(statusTotal(target, 'dodge'), 0, 0.9);
  if (dodge > 0 && rng.next() < dodge) {
    pushEvent(events, {
      type: 'miss',
      tone: 'defence',
      actorId: actor.id,
      targetId: target.id,
      message: `${target.name} vanished at exactly the right moment.`,
    });
    return 0;
  }

  const outgoing = 1 + statusTotal(actor, 'damage-up') - statusTotal(actor, 'damage-down');
  const incoming = 1 + statusTotal(target, 'vulnerable') - statusTotal(target, 'resistant');
  const empowered = actor.statuses.find((status) => status.kind === 'empowered');
  const flatBonus = empowered?.value ?? 0;
  const raw = Math.max(0, Math.round((baseAmount + flatBonus) * outgoing * incoming * mobMultiplier));
  if (empowered) actor.statuses = actor.statuses.filter((status) => status.id !== empowered.id);

  const absorbed = Math.min(target.shield, raw);
  const dealt = raw - absorbed;
  target.shield -= absorbed;
  target.hp = Math.max(0, target.hp - dealt);
  if (dealt > 0) {
    const sources = damagedThisRound.get(target.id) ?? new Set<string>();
    sources.add(actor.id);
    damagedThisRound.set(target.id, sources);
  }

  pushEvent(events, {
    type: 'damage',
    tone: dealt >= 35 ? 'danger' : 'attack',
    actorId: actor.id,
    targetId: target.id,
    amount: dealt,
    message: absorbed > 0
      ? `${target.name} takes ${dealt}; ${absorbed} is swallowed by Shield.`
      : `${target.name} takes ${dealt} damage.`,
  });

  const reflected = Math.round(dealt * clamp(statusTotal(target, 'reflect'), 0, 1));
  if (reflected > 0) {
    actor.hp = Math.max(0, actor.hp - reflected);
    const sources = damagedThisRound.get(actor.id) ?? new Set<string>();
    sources.add(target.id);
    damagedThisRound.set(actor.id, sources);
    pushEvent(events, {
      type: 'damage',
      tone: 'danger',
      actorId: target.id,
      targetId: actor.id,
      amount: reflected,
      message: `${actor.name} catches ${reflected} reflected damage.`,
    });
  }

  return dealt;
}

function applyEffects(
  state: BattleState,
  actor: CombatantState,
  defaultTarget: CombatantState,
  effects: Effect[],
  mobMultiplier: number,
  rng: SeededRng,
  events: BattleEvent[],
  damagedThisRound: Map<string, Set<string>>,
): void {
  for (const effect of effects) {
    if (effect.chance !== undefined && rng.next() >= effect.chance) continue;
    const target = effect.recipient === 'self' ? actor : defaultTarget;

    switch (effect.kind) {
      case 'damage': {
        const hits = effect.repeat ? rng.int(effect.repeat.min, effect.repeat.max) : 1;
        if (hits > 1) {
          pushEvent(events, {
            type: 'system',
            tone: 'special',
            actorId: actor.id,
            targetId: target.id,
            message: `${hits} hits. This may be excessive.`,
          });
        }
        for (let hit = 0; hit < hits; hit += 1) {
          applyDamage(actor, target, effect.amount, mobMultiplier, rng, events, damagedThisRound);
        }
        break;
      }
      case 'heal': {
        const before = target.hp;
        target.hp = Math.min(target.card.hp, target.hp + effect.amount);
        const amount = target.hp - before;
        pushEvent(events, {
          type: 'heal',
          tone: 'heal',
          actorId: actor.id,
          targetId: target.id,
          amount,
          message: `${target.name} recovers ${amount} HP.`,
        });
        break;
      }
      case 'shield':
        target.shield += effect.amount;
        pushEvent(events, {
          type: 'shield',
          tone: 'defence',
          actorId: actor.id,
          targetId: target.id,
          amount: effect.amount,
          message: `${target.name} gains ${effect.amount} Shield.`,
        });
        break;
      case 'status': {
        const instance: StatusInstance = {
          ...effect.status,
          id: `status-${state.round}-${events.length}-${rng.int(100, 999)}`,
          sourceId: actor.id,
          duration: effect.status.duration + (DEFERRED_STATUSES.has(effect.status.kind) ? 1 : 0),
        };
        target.statuses.push(instance);
        pushEvent(events, {
          type: 'status',
          tone: NEGATIVE_STATUSES.has(instance.kind) ? 'danger' : 'defence',
          actorId: actor.id,
          targetId: target.id,
          message: `${target.name} is ${instance.label}.`,
        });
        break;
      }
      case 'disable': {
        const candidates = target.card.abilities.filter(
          (ability) => !target.usedAbilities.includes(ability.id),
        );
        if (candidates.length === 0) break;
        const disabledAbility = rng.pick(candidates);
        const instance: StatusInstance = {
          id: `status-${state.round}-${events.length}-${rng.int(100, 999)}`,
          sourceId: actor.id,
          kind: 'disabled',
          label: `${disabledAbility.name} disabled`,
          duration: effect.duration + 1,
          abilityId: disabledAbility.id,
        };
        target.statuses.push(instance);
        pushEvent(events, {
          type: 'status',
          tone: 'danger',
          actorId: actor.id,
          targetId: target.id,
          message: `${target.name} loses ${disabledAbility.name} for ${effect.duration} round.`,
        });
        break;
      }
      case 'cleanse': {
        let remaining = effect.count ?? Number.POSITIVE_INFINITY;
        target.statuses = target.statuses.filter((status) => {
          if (remaining > 0 && NEGATIVE_STATUSES.has(status.kind)) {
            remaining -= 1;
            return false;
          }
          return true;
        });
        pushEvent(events, {
          type: 'status',
          tone: 'heal',
          actorId: actor.id,
          targetId: target.id,
          message: `${target.name} clears the bad energy.`,
        });
        break;
      }
      case 'steal-status': {
        const count = effect.count ?? 1;
        const stolen = target.statuses.filter((status) => POSITIVE_STATUSES.has(status.kind)).slice(0, count);
        target.statuses = target.statuses.filter((status) => !stolen.some((item) => item.id === status.id));
        for (const status of stolen) {
          const copy = { ...status, id: `${status.id}-stolen`, sourceId: actor.id };
          actor.statuses.push(copy);
        }
        pushEvent(events, {
          type: 'status',
          tone: 'special',
          actorId: actor.id,
          targetId: target.id,
          message: stolen.length > 0 ? `${actor.name} steals ${stolen[0]?.label}.` : 'Nothing useful to steal. Awkward.',
        });
        break;
      }
      case 'self-damage':
        actor.hp = Math.max(0, actor.hp - effect.amount);
        pushEvent(events, {
          type: 'damage',
          tone: 'danger',
          actorId: actor.id,
          targetId: actor.id,
          amount: effect.amount,
          message: `${actor.name} takes ${effect.amount} self-inflicted damage.`,
        });
        break;
      case 'conditional': {
        const branch = conditionPasses(effect.condition, actor, target, state.round, rng)
          ? effect.effects
          : (effect.otherwise ?? []);
        applyEffects(state, actor, target, branch, mobMultiplier, rng, events, damagedThisRound);
        break;
      }
    }
  }
}

function mobMultiplier(attackers: number): number {
  if (attackers >= 3) return 0.7;
  if (attackers === 2) return 0.85;
  return 1;
}

function containsDirectDamage(effects: Effect[]): boolean {
  return effects.some((effect) => {
    if (effect.recipient === 'self' || effect.kind === 'self-damage') return false;
    if (effect.kind === 'damage') return true;
    if (effect.kind === 'conditional') {
      return containsDirectDamage(effect.effects) || containsDirectDamage(effect.otherwise ?? []);
    }
    return false;
  });
}

function determineWinner(state: BattleState, events: BattleEvent[]): void {
  const living = Object.values(state.fighters).filter((fighter) => fighter.hp > 0);
  const livingTeams = [...new Set(living.map((fighter) => fighter.teamId))];

  if (livingTeams.length === 0) {
    state.finished = true;
    state.winnerPlayerIds = [];
    pushEvent(events, { type: 'ko', tone: 'ko', message: 'DOUBLE KO. Nobody gets to be smug.' });
    return;
  }

  if (livingTeams.length === 1) {
    state.finished = true;
    const winningTeam = livingTeams[0];
    state.winnerPlayerIds = Object.values(state.fighters)
      .filter((fighter) => fighter.teamId === winningTeam)
      .map((fighter) => fighter.id);
    pushEvent(events, { type: 'ko', tone: 'ko', message: 'That is the fight. Absolutely no appeals.' });
    return;
  }

  if (state.round >= MAX_ROUNDS) {
    const totals = new Map<string, number>();
    for (const fighter of living) {
      totals.set(fighter.teamId, (totals.get(fighter.teamId) ?? 0) + fighter.hp + fighter.shield);
    }
    const best = Math.max(...totals.values());
    const winningTeams = [...totals.entries()].filter(([, total]) => total === best).map(([team]) => team);
    state.finished = true;
    state.winnerPlayerIds = winningTeams.length === 1
      ? Object.values(state.fighters).filter((fighter) => fighter.teamId === winningTeams[0]).map((fighter) => fighter.id)
      : [];
    pushEvent(events, { type: 'system', tone: 'special', message: 'The house clock called it at round 12.' });
  }
}

export function resolveRound(stateInput: BattleState, actionInput: ActionChoice[]): ResolutionResult {
  if (stateInput.finished) return { state: structuredClone(stateInput), events: [] };

  const state = structuredClone(stateInput);
  const rng = SeededRng.fromState(state.rngState);
  const events: BattleEvent[] = [];
  const damagedThisRound = new Map<string, Set<string>>();
  const actions = validateActions(state, actionInput);
  const lockedAlive = new Set(Object.values(state.fighters).filter((fighter) => fighter.hp > 0).map((fighter) => fighter.id));

  pushEvent(events, {
    type: 'round',
    tone: 'neutral',
    message: `Round ${state.round}. Everybody committed to this.`,
  });

  for (const fighter of Object.values(state.fighters)) {
    const timedStatuses = fighter.statuses
      .filter((status) => status.kind === 'hot' || status.kind === 'dot')
      .sort((left, right) => (left.kind === 'hot' ? 0 : 1) - (right.kind === 'hot' ? 0 : 1));
    for (const status of timedStatuses) {
      if (status.kind === 'dot' && fighter.hp > 0) {
        fighter.hp = Math.max(0, fighter.hp - (status.value ?? 0));
        if ((status.value ?? 0) > 0 && status.sourceId !== fighter.id) {
          const sources = damagedThisRound.get(fighter.id) ?? new Set<string>();
          sources.add(status.sourceId);
          damagedThisRound.set(fighter.id, sources);
        }
        pushEvent(events, {
          type: 'damage',
          tone: 'danger',
          actorId: status.sourceId,
          targetId: fighter.id,
          amount: status.value ?? 0,
          message: `${fighter.name} takes ${status.value ?? 0} from ${status.label}.`,
        });
      }
      if (status.kind === 'hot' && fighter.hp > 0) {
        const before = fighter.hp;
        fighter.hp = Math.min(fighter.card.hp, fighter.hp + (status.value ?? 0));
        pushEvent(events, {
          type: 'heal',
          tone: 'heal',
          actorId: status.sourceId,
          targetId: fighter.id,
          amount: fighter.hp - before,
          message: `${fighter.name} recovers ${fighter.hp - before} from ${status.label}.`,
        });
      }
    }
  }

  const prepared = actions
    .map((action) => {
      const actor = state.fighters[action.actorId];
      const ability = actor ? findAbility(actor, action.abilityId) : undefined;
      if (!actor || !ability) return null;
      return {
        action,
        actor,
        ability,
        targets: resolvedTargetIds(state, action, ability, rng),
        tie: rng.next(),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((left, right) => left.ability.priority - right.ability.priority || left.tie - right.tie);

  const directAttackers = new Map<string, Set<string>>();
  if (state.mode === 'ffa') {
    for (const item of prepared) {
      if (!['enemy', 'random-enemy'].includes(item.ability.target) || !containsDirectDamage(item.ability.effects)) continue;
      for (const targetId of item.targets) {
        const set = directAttackers.get(targetId) ?? new Set<string>();
        set.add(item.actor.id);
        directAttackers.set(targetId, set);
      }
    }
    for (const [targetId, attackers] of directAttackers.entries()) {
      if (attackers.size < 2) continue;
      const target = state.fighters[targetId];
      pushEvent(events, {
        type: 'system',
        tone: 'defence',
        targetId,
        message: `${target?.name ?? 'A fighter'} is MOBBED by ${attackers.size} attackers — direct damage ×${mobMultiplier(attackers.size).toFixed(2)}.`,
      });
    }
  }

  for (const item of prepared) {
    if (!lockedAlive.has(item.actor.id)) continue;
    item.actor.cooldowns[item.ability.id] = item.ability.cooldown + 1;
    if (item.ability.oncePerMatch && !item.actor.usedAbilities.includes(item.ability.id)) {
      item.actor.usedAbilities.push(item.ability.id);
    }
    pushEvent(events, {
      type: 'ability',
      tone: item.ability.oncePerMatch ? 'special' : 'neutral',
      actorId: item.actor.id,
      message: `${item.actor.name} uses ${item.ability.name}.`,
    });

    const targetEffects = item.ability.effects.filter(
      (effect) => effect.recipient !== 'self' && effect.kind !== 'self-damage',
    );
    for (const targetId of item.targets) {
      const target = state.fighters[targetId];
      if (!target) continue;
      const attackers = directAttackers.get(targetId)?.size ?? 1;
      applyEffects(
        state,
        item.actor,
        target,
        targetEffects,
        state.mode === 'ffa' ? mobMultiplier(attackers) : 1,
        rng,
        events,
        damagedThisRound,
      );
    }

    const selfEffects = item.ability.effects.filter(
      (effect) => effect.recipient === 'self' || effect.kind === 'self-damage',
    );
    if (selfEffects.length > 0) {
      applyEffects(state, item.actor, item.actor, selfEffects, 1, rng, events, damagedThisRound);
    }
  }

  for (const fighter of Object.values(state.fighters)) {
    fighter.damagedByLastRound = [...(damagedThisRound.get(fighter.id) ?? [])];
    for (const abilityId of Object.keys(fighter.cooldowns)) {
      fighter.cooldowns[abilityId] = Math.max(0, (fighter.cooldowns[abilityId] ?? 0) - 1);
    }
    fighter.statuses = fighter.statuses
      .map((status) => ({ ...status, duration: status.duration - 1 }))
      .filter((status) => status.duration > 0);
    if (fighter.hp <= 0 && lockedAlive.has(fighter.id)) {
      pushEvent(events, {
        type: 'ko',
        tone: 'ko',
        targetId: fighter.id,
        message: `${fighter.name} is KO.`,
      });
    }
  }

  determineWinner(state, events);
  if (!state.finished) state.round += 1;
  state.rngState = rng.getState();
  return { state, events };
}
