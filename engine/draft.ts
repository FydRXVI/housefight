import { SeededRng } from './rng.js';
import type { CardDefinition, Playlist } from './types.js';

export interface DraftResult {
  options: Record<string, CardDefinition[]>;
  cursedPlayerId: string | null;
}

const PARTY_BOSS_WEIGHT = 0.2;
const PARTY_CURSE_CHANCE = 0.1;

function weightedPartyPool(
  standards: CardDefinition[],
  bosses: CardDefinition[],
  count: number,
  rng: SeededRng,
): CardDefinition[] {
  const remaining = [
    ...standards.map((card) => ({ card, weight: 1 })),
    ...bosses.map((card) => ({ card, weight: PARTY_BOSS_WEIGHT })),
  ];
  const selected: CardDefinition[] = [];

  while (selected.length < count && remaining.length > 0) {
    const totalWeight = remaining.reduce((total, entry) => total + entry.weight, 0);
    let roll = rng.next() * totalWeight;
    let selectedIndex = remaining.length - 1;
    for (let index = 0; index < remaining.length; index += 1) {
      roll -= remaining[index]?.weight ?? 0;
      if (roll <= 0) {
        selectedIndex = index;
        break;
      }
    }
    const [entry] = remaining.splice(selectedIndex, 1);
    if (entry) selected.push(entry.card);
  }
  return selected;
}

export function createDraft(
  playerIds: string[],
  cards: CardDefinition[],
  playlist: Playlist,
  rng: SeededRng,
): DraftResult {
  const standards = cards.filter((card) => card.rarity === 'standard');
  const bosses = cards.filter((card) => card.rarity === 'boss');
  const cursed = cards.filter((card) => card.rarity === 'cursed');
  const required = playerIds.length * 3;
  const draftable = playlist === 'balanced' ? standards : [...standards, ...bosses];

  if (draftable.length < required) {
    throw new Error(`Card pool needs ${required} draftable cards; found ${draftable.length}.`);
  }

  const pool = playlist === 'balanced'
    ? rng.shuffle(standards).slice(0, required)
    : weightedPartyPool(standards, bosses, required, rng);

  const options: Record<string, CardDefinition[]> = {};
  playerIds.forEach((playerId, index) => {
    options[playerId] = pool.slice(index * 3, index * 3 + 3);
  });

  const shouldHijack = playlist === 'party' && cursed.length > 0 && rng.next() < PARTY_CURSE_CHANCE;
  const cursedPlayerId = shouldHijack ? rng.pick(playerIds) : null;
  if (cursedPlayerId) {
    options[cursedPlayerId] = [rng.pick(cursed)];
  }

  return { options, cursedPlayerId };
}
