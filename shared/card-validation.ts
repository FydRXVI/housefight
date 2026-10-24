import type {
  AbilityDefinition,
  CardDefinition,
  Condition,
  Effect,
  StatusKind,
} from '../engine/types.js';

const CARD_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ABILITY_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MEDIA_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COLOR = /^#[0-9a-f]{6}$/i;

const TARGETS = new Set(['enemy', 'ally', 'self', 'all-enemies', 'random-enemy']);
const RARITIES = new Set(['standard', 'boss', 'cursed']);
const RECIPIENTS = new Set(['target', 'self']);
const STATUS_KINDS = new Set<StatusKind>([
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
const PERCENT_STATUS_KINDS = new Set<StatusKind>([
  'damage-up', 'damage-down', 'vulnerable', 'resistant', 'dodge', 'reflect',
]);
const AMOUNT_STATUS_KINDS = new Set<StatusKind>(['dot', 'hot', 'empowered']);

export interface CardValidationResult {
  ok: boolean;
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function codePointLength(value: string): number {
  return [...value].length;
}

function containsUnsupportedControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 8
      || codePoint === 11
      || codePoint === 12
      || (codePoint >= 14 && codePoint <= 31)
      || codePoint === 127
      || (codePoint >= 0x202a && codePoint <= 0x202e)
      || (codePoint >= 0x2066 && codePoint <= 0x2069)) {
      return true;
    }
  }
  return false;
}

function textField(
  value: unknown,
  path: string,
  errors: string[],
  minimum: number,
  maximum: number,
): value is string {
  if (typeof value !== 'string') {
    errors.push(`${path} must be text.`);
    return false;
  }
  const length = codePointLength(value.trim());
  if (length < minimum || length > maximum) {
    errors.push(`${path} must contain ${minimum}–${maximum} characters.`);
  }
  if (containsUnsupportedControlCharacter(value)) errors.push(`${path} contains unsupported control characters.`);
  return true;
}

function integerField(
  value: unknown,
  path: string,
  errors: string[],
  minimum: number,
  maximum: number,
): value is number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    errors.push(`${path} must be a whole number from ${minimum} to ${maximum}.`);
    return false;
  }
  return true;
}

function probabilityField(value: unknown, path: string, errors: string[]): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    errors.push(`${path} must be a number from 0 to 1.`);
    return false;
  }
  return true;
}

function validateCondition(value: unknown, path: string, errors: string[]): value is Condition {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    errors.push(`${path} must be a condition object.`);
    return false;
  }
  switch (value.kind) {
    case 'target-hp-below':
    case 'self-hp-below':
      probabilityField(value.percent, `${path}.percent`, errors);
      return true;
    case 'round-at-least':
      integerField(value.round, `${path}.round`, errors, 1, 12);
      return true;
    case 'target-has-status':
      if (typeof value.status !== 'string' || !STATUS_KINDS.has(value.status as StatusKind)) {
        errors.push(`${path}.status is not supported.`);
      }
      return true;
    case 'damaged-by-target-last-round':
      return true;
    case 'chance':
      probabilityField(value.probability, `${path}.probability`, errors);
      return true;
    default:
      errors.push(`${path}.kind is not supported.`);
      return false;
  }
}

function validateEffect(value: unknown, path: string, errors: string[], depth: number): value is Effect {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    errors.push(`${path} must be an effect object.`);
    return false;
  }
  if (depth > 3) errors.push(`${path} nests conditional effects too deeply.`);
  if (value.chance !== undefined) probabilityField(value.chance, `${path}.chance`, errors);
  if (value.recipient !== undefined && (typeof value.recipient !== 'string' || !RECIPIENTS.has(value.recipient))) {
    errors.push(`${path}.recipient must be target or self.`);
  }

  switch (value.kind) {
    case 'damage':
      integerField(value.amount, `${path}.amount`, errors, 0, 500);
      if (value.repeat !== undefined) {
        if (!isRecord(value.repeat)) {
          errors.push(`${path}.repeat must contain min and max.`);
        } else {
          integerField(value.repeat.min, `${path}.repeat.min`, errors, 1, 20);
          integerField(value.repeat.max, `${path}.repeat.max`, errors, 1, 20);
          if (typeof value.repeat.min === 'number' && typeof value.repeat.max === 'number' && value.repeat.min > value.repeat.max) {
            errors.push(`${path}.repeat.min cannot exceed repeat.max.`);
          }
        }
      }
      return true;
    case 'heal':
    case 'shield':
    case 'self-damage':
      integerField(value.amount, `${path}.amount`, errors, 0, 500);
      return true;
    case 'status':
      if (!isRecord(value.status)) {
        errors.push(`${path}.status must be an object.`);
      } else {
        if (typeof value.status.kind !== 'string' || !STATUS_KINDS.has(value.status.kind as StatusKind)) {
          errors.push(`${path}.status.kind is not supported.`);
        }
        textField(value.status.label, `${path}.status.label`, errors, 1, 60);
        integerField(value.status.duration, `${path}.status.duration`, errors, 1, 12);
        if (value.status.value !== undefined && typeof value.status.kind === 'string'
          && STATUS_KINDS.has(value.status.kind as StatusKind)) {
          const statusKind = value.status.kind as StatusKind;
          if (PERCENT_STATUS_KINDS.has(statusKind)) {
            probabilityField(value.status.value, `${path}.status.value`, errors);
          } else if (AMOUNT_STATUS_KINDS.has(statusKind)) {
            if (typeof value.status.value !== 'number' || !Number.isFinite(value.status.value) || value.status.value < 0 || value.status.value > 500) {
              errors.push(`${path}.status.value must be a number from 0 to 500.`);
            }
          } else {
            errors.push(`${path}.status.value is not used by ${statusKind}.`);
          }
        }
        if (value.status.abilityId !== undefined && (typeof value.status.abilityId !== 'string' || !ABILITY_ID.test(value.status.abilityId))) {
          errors.push(`${path}.status.abilityId is invalid.`);
        }
      }
      return true;
    case 'disable':
      integerField(value.duration, `${path}.duration`, errors, 1, 12);
      return true;
    case 'cleanse':
    case 'steal-status':
      if (value.count !== undefined) integerField(value.count, `${path}.count`, errors, 1, 20);
      return true;
    case 'conditional': {
      validateCondition(value.condition, `${path}.condition`, errors);
      if (!Array.isArray(value.effects) || value.effects.length < 1 || value.effects.length > 8) {
        errors.push(`${path}.effects must contain 1–8 effects.`);
      } else {
        value.effects.forEach((effect, index) => validateEffect(effect, `${path}.effects[${index}]`, errors, depth + 1));
      }
      if (value.otherwise !== undefined) {
        if (!Array.isArray(value.otherwise) || value.otherwise.length > 8) {
          errors.push(`${path}.otherwise must contain at most 8 effects.`);
        } else {
          value.otherwise.forEach((effect, index) => validateEffect(effect, `${path}.otherwise[${index}]`, errors, depth + 1));
        }
      }
      return true;
    }
    default:
      errors.push(`${path}.kind is not supported.`);
      return false;
  }
}

function validateAbility(value: unknown, path: string, errors: string[]): value is AbilityDefinition {
  if (!isRecord(value)) {
    errors.push(`${path} must be an ability object.`);
    return false;
  }
  if (typeof value.id !== 'string' || !ABILITY_ID.test(value.id)) errors.push(`${path}.id is invalid.`);
  textField(value.name, `${path}.name`, errors, 1, 70);
  textField(value.description, `${path}.description`, errors, 1, 260);
  if (typeof value.target !== 'string' || !TARGETS.has(value.target)) errors.push(`${path}.target is not supported.`);
  integerField(value.priority, `${path}.priority`, errors, 0, 3);
  integerField(value.cooldown, `${path}.cooldown`, errors, 0, 6);
  if (value.availableFromRound !== undefined) {
    integerField(value.availableFromRound, `${path}.availableFromRound`, errors, 1, 12);
  }
  if (value.oncePerMatch !== undefined && typeof value.oncePerMatch !== 'boolean') {
    errors.push(`${path}.oncePerMatch must be true or false.`);
  }
  if (!Array.isArray(value.effects) || value.effects.length < 1 || value.effects.length > 8) {
    errors.push(`${path}.effects must contain 1–8 effects.`);
  } else {
    value.effects.forEach((effect, index) => validateEffect(effect, `${path}.effects[${index}]`, errors, 0));
  }
  return true;
}

export function validateCardDefinition(value: unknown): CardValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ['Card must be an object.'] };

  if (typeof value.id !== 'string' || !CARD_ID.test(value.id)) errors.push('id must be a lowercase URL-safe slug (1–40 characters).');
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') errors.push('enabled must be a boolean.');
  textField(value.name, 'name', errors, 1, 60);
  textField(value.title, 'title', errors, 1, 100);
  textField(value.quote, 'quote', errors, 0, 280);
  textField(value.archetype, 'archetype', errors, 1, 60);
  integerField(value.hp, 'hp', errors, 40, 250);
  if (typeof value.rarity !== 'string' || !RARITIES.has(value.rarity)) errors.push('rarity is not supported.');
  if (typeof value.accent !== 'string' || !COLOR.test(value.accent)) errors.push('accent must be a six-digit hex color.');
  if (typeof value.accentAlt !== 'string' || !COLOR.test(value.accentAlt)) errors.push('accentAlt must be a six-digit hex color.');
  integerField(value.avatarSeed, 'avatarSeed', errors, 0, 2_147_483_647);

  if (value.portrait !== undefined) {
    if (!isRecord(value.portrait)) {
      errors.push('portrait must be an object.');
    } else {
      if (typeof value.portrait.mediaId !== 'string' || !MEDIA_ID.test(value.portrait.mediaId)) errors.push('portrait.mediaId is invalid.');
      integerField(value.portrait.focalX, 'portrait.focalX', errors, 0, 100);
      integerField(value.portrait.focalY, 'portrait.focalY', errors, 0, 100);
    }
  }

  if (!Array.isArray(value.abilities) || value.abilities.length !== 4) {
    errors.push('abilities must contain exactly four abilities.');
  } else {
    value.abilities.forEach((ability, index) => validateAbility(ability, `abilities[${index}]`, errors));
    const ids = value.abilities.flatMap((ability) => isRecord(ability) && typeof ability.id === 'string' ? [ability.id] : []);
    if (new Set(ids).size !== ids.length) errors.push('ability ids must be unique within a card.');
  }

  return { ok: errors.length === 0, errors };
}

export function isCardDefinition(value: unknown): value is CardDefinition {
  return validateCardDefinition(value).ok;
}

function normalizeText(value: string): string {
  return value.normalize('NFC').trim();
}

function normalizeCondition(condition: Condition): Condition {
  switch (condition.kind) {
    case 'target-hp-below':
    case 'self-hp-below':
      return { kind: condition.kind, percent: condition.percent };
    case 'round-at-least':
      return { kind: condition.kind, round: condition.round };
    case 'target-has-status':
      return { kind: condition.kind, status: condition.status };
    case 'damaged-by-target-last-round':
      return { kind: condition.kind };
    case 'chance':
      return { kind: condition.kind, probability: condition.probability };
  }
}

function effectBase(effect: Effect): Pick<Effect, 'chance' | 'recipient'> {
  return {
    ...(effect.chance === undefined ? {} : { chance: effect.chance }),
    ...(effect.recipient === undefined ? {} : { recipient: effect.recipient }),
  };
}

function normalizeEffect(effect: Effect): Effect {
  const base = effectBase(effect);
  switch (effect.kind) {
    case 'damage':
      return { ...base, kind: 'damage', amount: effect.amount, ...(effect.repeat ? { repeat: { min: effect.repeat.min, max: effect.repeat.max } } : {}) };
    case 'heal':
    case 'shield':
    case 'self-damage':
      return { ...base, kind: effect.kind, amount: effect.amount };
    case 'status':
      return {
        ...base,
        kind: 'status',
        status: {
          kind: effect.status.kind,
          label: normalizeText(effect.status.label),
          duration: effect.status.duration,
          ...(effect.status.value === undefined ? {} : { value: effect.status.value }),
          ...(effect.status.abilityId === undefined ? {} : { abilityId: effect.status.abilityId }),
        },
      };
    case 'disable':
      return { ...base, kind: 'disable', duration: effect.duration };
    case 'cleanse':
    case 'steal-status':
      return { ...base, kind: effect.kind, ...(effect.count === undefined ? {} : { count: effect.count }) };
    case 'conditional':
      return {
        ...base,
        kind: 'conditional',
        condition: normalizeCondition(effect.condition),
        effects: effect.effects.map(normalizeEffect),
        ...(effect.otherwise === undefined ? {} : { otherwise: effect.otherwise.map(normalizeEffect) }),
      };
  }
}

export function normalizeCardDefinition(card: CardDefinition): CardDefinition {
  return {
    id: card.id,
    enabled: card.enabled !== false,
    name: normalizeText(card.name),
    title: normalizeText(card.title),
    quote: normalizeText(card.quote),
    archetype: normalizeText(card.archetype),
    hp: card.hp,
    rarity: card.rarity,
    accent: card.accent,
    accentAlt: card.accentAlt,
    avatarSeed: card.avatarSeed,
    ...(card.portrait ? { portrait: { mediaId: card.portrait.mediaId, focalX: card.portrait.focalX, focalY: card.portrait.focalY } } : {}),
    abilities: card.abilities.map((ability) => ({
      id: ability.id,
      name: normalizeText(ability.name),
      description: normalizeText(ability.description),
      target: ability.target,
      priority: ability.priority,
      cooldown: ability.cooldown,
      ...(ability.availableFromRound === undefined ? {} : { availableFromRound: ability.availableFromRound }),
      ...(ability.oncePerMatch === undefined ? {} : { oncePerMatch: ability.oncePerMatch }),
      effects: ability.effects.map(normalizeEffect),
    })),
  };
}
