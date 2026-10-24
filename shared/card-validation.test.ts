import { describe, expect, it } from 'vitest';
import type { CardDefinition } from '../engine/types.js';
import { fakeCards } from '../fixtures/fake-card-pack/cards.js';
import { normalizeCardDefinition, validateCardDefinition } from './card-validation.js';

describe('card validation', () => {
  it('defaults legacy cards to enabled and preserves an explicit vault-only switch', () => {
    const legacy = structuredClone(fakeCards[0] as CardDefinition);
    delete legacy.enabled;
    expect(validateCardDefinition(legacy).ok).toBe(true);
    expect(normalizeCardDefinition(legacy).enabled).toBe(true);
    expect(normalizeCardDefinition({ ...legacy, enabled: false }).enabled).toBe(false);
    expect(validateCardDefinition({ ...legacy, enabled: 'no' }).ok).toBe(false);
  });
  it('accepts the complete built-in card pack', () => {
    for (const card of fakeCards) expect(validateCardDefinition(card), card.id).toEqual({ ok: true, errors: [] });
  });

  it('rejects malformed nested effects before they can reach a match timer', () => {
    const malformed = structuredClone(fakeCards[0]) as unknown as Record<string, unknown>;
    const abilities = malformed.abilities as Array<Record<string, unknown>>;
    abilities[0] = {
      ...abilities[0],
      target: 'somebody-nearby',
      priority: 99,
      effects: [{
        kind: 'conditional',
        condition: { kind: 'chance', probability: 3 },
        effects: [{ kind: 'damage', amount: Number.NaN }],
      }],
    };
    const result = validateCardDefinition(malformed);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('target is not supported');
    expect(result.errors.join(' ')).toContain('priority');
    expect(result.errors.join(' ')).toContain('probability');
    expect(result.errors.join(' ')).toContain('amount');
  });

  it('preserves normalized multilingual text while stripping unknown private fields', () => {
    const input = {
      ...structuredClone(fakeCards[0]),
      name: 'E\u0301lodie',
      title: 'Ça va, l’équipe ?',
      quote: 'Kol khara ya shrik — بس بمحبة 😌',
      privateNotes: '/Users/someone/private/photo.jpg',
      abilities: fakeCards[0]?.abilities.map((ability) => ({ ...structuredClone(ability), secret: 'do not leak' })),
    } as CardDefinition & { privateNotes: string };
    const validation = validateCardDefinition(input);
    expect(validation.ok).toBe(true);
    const normalized = normalizeCardDefinition(input);
    expect(normalized.name).toBe('Élodie');
    expect(normalized.quote).toBe('Kol khara ya shrik — بس بمحبة 😌');
    expect('privateNotes' in normalized).toBe(false);
    expect('secret' in normalized.abilities[0]!).toBe(false);
  });

  it('counts Unicode code points instead of rejecting valid emoji as doubled UTF-16 units', () => {
    const card = { ...structuredClone(fakeCards[0]), name: '🥊'.repeat(40) };
    expect(validateCardDefinition(card).ok).toBe(true);
    expect(validateCardDefinition({ ...card, name: '🥊'.repeat(61) }).ok).toBe(false);
  });

  it('accepts Arabic text but rejects invisible bidirectional override controls', () => {
    expect(validateCardDefinition({ ...structuredClone(fakeCards[0]), quote: 'كل خرا يا شريك' }).ok).toBe(true);
    const result = validateCardDefinition({ ...structuredClone(fakeCards[0]), quote: 'safe\u202etxt.exe' });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('control characters');
  });

  it('enforces semantic status-value ranges used by the combat engine', () => {
    const percentage = structuredClone(fakeCards[0]!);
    percentage.abilities[0]!.effects = [{
      kind: 'status',
      status: { kind: 'dodge', label: 'Impossible odds', duration: 1, value: 25 },
    }];
    const percentResult = validateCardDefinition(percentage);
    expect(percentResult.ok).toBe(false);
    expect(percentResult.errors.join(' ')).toContain('number from 0 to 1');

    const meaningless = structuredClone(fakeCards[0]!);
    meaningless.abilities[0]!.effects = [{
      kind: 'status',
      status: { kind: 'taunt', label: 'Look at me', duration: 1, value: 1 },
    }];
    const tauntResult = validateCardDefinition(meaningless);
    expect(tauntResult.ok).toBe(false);
    expect(tauntResult.errors.join(' ')).toContain('not used by taunt');
  });
});
