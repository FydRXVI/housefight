export type GameMode = 'duel' | 'ffa' | 'teams';
export type Playlist = 'balanced' | 'party';
export type CardRarity = 'standard' | 'boss' | 'cursed';
export type TargetKind = 'enemy' | 'ally' | 'self' | 'all-enemies' | 'random-enemy';
export type AbilityPriority = 0 | 1 | 2 | 3;

export type StatusKind =
  | 'damage-up'
  | 'damage-down'
  | 'vulnerable'
  | 'resistant'
  | 'dodge'
  | 'reflect'
  | 'taunt'
  | 'dot'
  | 'hot'
  | 'empowered'
  | 'disabled';

export type Condition =
  | { kind: 'target-hp-below'; percent: number }
  | { kind: 'self-hp-below'; percent: number }
  | { kind: 'round-at-least'; round: number }
  | { kind: 'target-has-status'; status: StatusKind }
  | { kind: 'damaged-by-target-last-round' }
  | { kind: 'chance'; probability: number };

export interface StatusTemplate {
  kind: StatusKind;
  label: string;
  duration: number;
  value?: number;
  abilityId?: string;
}

interface EffectBase {
  chance?: number;
  recipient?: 'target' | 'self';
}

export type Effect =
  | (EffectBase & {
      kind: 'damage';
      amount: number;
      repeat?: { min: number; max: number };
    })
  | (EffectBase & { kind: 'heal'; amount: number })
  | (EffectBase & { kind: 'shield'; amount: number })
  | (EffectBase & { kind: 'status'; status: StatusTemplate })
  | (EffectBase & { kind: 'disable'; duration: number })
  | (EffectBase & { kind: 'cleanse'; count?: number })
  | (EffectBase & { kind: 'steal-status'; count?: number })
  | (EffectBase & { kind: 'self-damage'; amount: number })
  | (EffectBase & {
      kind: 'conditional';
      condition: Condition;
      effects: Effect[];
      otherwise?: Effect[];
    });

export interface AbilityDefinition {
  id: string;
  name: string;
  description: string;
  target: TargetKind;
  priority: AbilityPriority;
  cooldown: number;
  availableFromRound?: number;
  oncePerMatch?: boolean;
  effects: Effect[];
}

export interface CardPortrait {
  /** Opaque id for an image stored in the private GAME_DATA_DIR. */
  mediaId: string;
  /** Percentage-based crop focus used by object-position. */
  focalX: number;
  focalY: number;
}

export interface CardDefinition {
  id: string;
  /** Missing in legacy exports means enabled. Disabled cards stay in the vault but never enter a draft. */
  enabled?: boolean;
  name: string;
  title: string;
  quote: string;
  archetype: string;
  hp: number;
  rarity: CardRarity;
  accent: string;
  accentAlt: string;
  avatarSeed: number;
  portrait?: CardPortrait;
  abilities: AbilityDefinition[];
}

export interface StatusInstance extends StatusTemplate {
  id: string;
  sourceId: string;
}

export interface CombatantState {
  id: string;
  name: string;
  teamId: string;
  card: CardDefinition;
  hp: number;
  shield: number;
  statuses: StatusInstance[];
  cooldowns: Record<string, number>;
  usedAbilities: string[];
  damagedByLastRound: string[];
}

export interface ActionChoice {
  actorId: string;
  abilityId: string;
  targetIds: string[];
}

export type EventTone = 'neutral' | 'attack' | 'defence' | 'heal' | 'danger' | 'ko' | 'special';

export interface BattleEvent {
  id: string;
  type: 'round' | 'ability' | 'damage' | 'heal' | 'shield' | 'status' | 'miss' | 'ko' | 'system';
  message: string;
  tone: EventTone;
  actorId?: string;
  targetId?: string;
  amount?: number;
}

export interface BattleState {
  seed: number;
  rngState: number;
  mode: GameMode;
  round: number;
  fighters: Record<string, CombatantState>;
  finished: boolean;
  winnerPlayerIds: string[] | null;
}

export interface BattleParticipant {
  id: string;
  name: string;
  teamId: string;
  card: CardDefinition;
}

export interface ResolutionResult {
  state: BattleState;
  events: BattleEvent[];
}

export interface AbilityAvailability {
  available: boolean;
  reason?: string;
}
