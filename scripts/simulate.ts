import { runBotBattle } from '../engine/bots.js';
import type { BotPolicy } from '../engine/bots.js';
import { createBattle } from '../engine/engine.js';
import type { BattleParticipant, CardDefinition, GameMode } from '../engine/types.js';
import { fakeCards } from '../fixtures/fake-card-pack/cards.js';
import { pathToFileURL } from 'node:url';

type ScenarioId = 'DUEL' | 'FFA 3' | 'FFA 4' | '2V2';
type GateFlag = 'OK' | 'WATCH' | 'REVIEW';

interface MatchSeat {
  card: CardDefinition;
  teamId: string;
}

interface MatchDefinition {
  key: string;
  seats: MatchSeat[];
}

interface Scenario {
  id: ScenarioId;
  mode: GameMode;
  size: 2 | 3 | 4;
  expectedRate: number;
  tolerance: number;
  matches: MatchDefinition[];
}

interface ReportAccumulator {
  games: number;
  wins: number;
  draws: number;
  rounds: number;
  equity: number;
  equitySquares: number;
  actions: number;
  abilityCounts: Map<string, number>;
}

interface SimulationReport extends ReportAccumulator {
  fighter: string;
  winRate: number;
  equityRate: number;
  confidenceLow: number;
  confidenceHigh: number;
  flag: GateFlag;
}

const standards = fakeCards
  .filter((card) => card.rarity === 'standard')
  .sort((left, right) => left.id.localeCompare(right.id));
const masterSeed = readPositiveInteger('SIM_SEED', 1_218_005_075);
const requestedMinimumGames = readPositiveInteger('SIM_MIN_GAMES', 300);

function readPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function combinations<T>(items: readonly T[], size: number): T[][] {
  if (size === 0) return [[]];
  if (items.length < size) return [];
  const result: T[][] = [];
  for (let index = 0; index <= items.length - size; index += 1) {
    const first = items[index];
    if (first === undefined) continue;
    for (const rest of combinations(items.slice(index + 1), size - 1)) {
      result.push([first, ...rest]);
    }
  }
  return result;
}

function hashSeed(value: string): number {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function soloMatches(size: 2 | 3 | 4): MatchDefinition[] {
  return combinations(standards, size).map((cards) => ({
    key: cards.map((card) => card.id).join('|'),
    seats: cards.map((card) => ({ card, teamId: `solo-${card.id}` })),
  }));
}

function teamMatches(): MatchDefinition[] {
  return combinations(standards, 4).flatMap((cards) => {
    const [a, b, c, d] = cards;
    if (!a || !b || !c || !d) return [];
    const partitions: [CardDefinition[], CardDefinition[]][] = [
      [[a, b], [c, d]],
      [[a, c], [b, d]],
      [[a, d], [b, c]],
    ];
    return partitions.map(([teamA, teamB]) => ({
      key: `${teamA.map((card) => card.id).join('+')}|${teamB.map((card) => card.id).join('+')}`,
      seats: [
        ...teamA.map((card) => ({ card, teamId: 'team-a' })),
        ...teamB.map((card) => ({ card, teamId: 'team-b' })),
      ],
    }));
  });
}

export const simulationScenarios: Scenario[] = [
  {
    id: 'DUEL',
    mode: 'duel',
    size: 2,
    expectedRate: 0.5,
    tolerance: 0.15,
    matches: soloMatches(2),
  },
  {
    id: 'FFA 3',
    mode: 'ffa',
    size: 3,
    expectedRate: 1 / 3,
    tolerance: 0.13,
    matches: soloMatches(3),
  },
  {
    id: 'FFA 4',
    mode: 'ffa',
    size: 4,
    expectedRate: 0.25,
    tolerance: 0.1,
    matches: soloMatches(4),
  },
  {
    id: '2V2',
    mode: 'teams',
    size: 4,
    expectedRate: 0.5,
    tolerance: 0.15,
    matches: teamMatches(),
  },
];

function equityConfidenceInterval(accumulator: ReportAccumulator): [number, number] {
  if (accumulator.games < 2) return [0, 1];
  const z = 1.96;
  const mean = accumulator.equity / accumulator.games;
  const squaredDeviations = Math.max(
    0,
    accumulator.equitySquares - accumulator.games * mean * mean,
  );
  const variance = squaredDeviations / (accumulator.games - 1);
  const margin = z * Math.sqrt(variance / accumulator.games);
  return [Math.max(0, mean - margin), Math.min(1, mean + margin)];
}

function gateFlag(
  rate: number,
  confidenceLow: number,
  confidenceHigh: number,
  scenario: Scenario,
): GateFlag {
  const floor = scenario.expectedRate - scenario.tolerance;
  const ceiling = scenario.expectedRate + scenario.tolerance;
  if (confidenceHigh < floor || confidenceLow > ceiling) return 'REVIEW';
  if (rate < floor || rate > ceiling) return 'WATCH';
  return 'OK';
}

function repetitionCount(scenario: Scenario, minimumGames: number): number {
  const appearances = new Map(standards.map((card) => [card.id, 0]));
  for (const match of scenario.matches) {
    for (const seat of match.seats) {
      appearances.set(seat.card.id, (appearances.get(seat.card.id) ?? 0) + 1);
    }
  }
  const leastAppearances = Math.min(...appearances.values());
  if (leastAppearances <= 0) throw new Error(`${scenario.id} does not cover every standard fighter.`);
  // A complete number of seat rotations removes insertion-order as a card-specific
  // confound even when the requested sample size is small.
  return Math.max(scenario.size, Math.ceil(minimumGames / leastAppearances));
}

function rotate<T>(items: readonly T[], positions: number): T[] {
  const offset = positions % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

function participantsFor(match: MatchDefinition, repetition: number): BattleParticipant[] {
  const seats = rotate(match.seats, repetition);
  const swapTeams = repetition % 2 === 1;
  return seats.map(({ card, teamId }) => ({
    id: `fighter-${card.id}`,
    name: card.name,
    teamId: swapTeams && (teamId === 'team-a' || teamId === 'team-b')
      ? teamId === 'team-a' ? 'team-b' : 'team-a'
      : teamId,
    card,
  }));
}

export function simulateScenario(
  scenario: Scenario,
  policy: BotPolicy,
  minimumGames = requestedMinimumGames,
  seed = masterSeed,
): { reports: SimulationReport[]; repetitions: number } {
  const accumulators = new Map<string, ReportAccumulator>(
    standards.map((card) => [card.id, {
      games: 0,
      wins: 0,
      draws: 0,
      rounds: 0,
      equity: 0,
      equitySquares: 0,
      actions: 0,
      abilityCounts: new Map<string, number>(),
    }]),
  );
  const repetitions = repetitionCount(scenario, minimumGames);

  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    for (const match of scenario.matches) {
      const seedKey = `${seed}|${scenario.id}|${match.key}|${repetition}`;
      const battleSeed = hashSeed(`${seedKey}|battle`);
      const actionSeed = hashSeed(`${seedKey}|actions`);
      const participants = participantsFor(match, repetition);
      const cardIdByPlayer = new Map(participants.map((participant) => [participant.id, participant.card.id]));
      const result = runBotBattle(createBattle(participants, scenario.mode, battleSeed), actionSeed, {
        policy,
        onAction: (action) => {
          const cardId = cardIdByPlayer.get(action.actorId);
          const accumulator = cardId ? accumulators.get(cardId) : undefined;
          if (!accumulator) return;
          accumulator.actions += 1;
          accumulator.abilityCounts.set(
            action.abilityId,
            (accumulator.abilityCounts.get(action.abilityId) ?? 0) + 1,
          );
        },
      });
      const winners = new Set(result.winnerPlayerIds ?? []);
      const isDraw = winners.size === 0;

      for (const participant of participants) {
        const accumulator = accumulators.get(participant.card.id);
        if (!accumulator) throw new Error(`Missing accumulator for ${participant.card.id}.`);
        accumulator.games += 1;
        accumulator.rounds += result.round;
        if (winners.has(participant.id)) accumulator.wins += 1;
        if (isDraw) accumulator.draws += 1;
        const equity = winners.has(participant.id) ? 1 : isDraw ? scenario.expectedRate : 0;
        accumulator.equity += equity;
        accumulator.equitySquares += equity * equity;
      }
    }
  }

  return {
    repetitions,
    reports: standards.map((card) => {
      const accumulator = accumulators.get(card.id);
      if (!accumulator) throw new Error(`Missing report for ${card.id}.`);
      const winRate = accumulator.games > 0 ? accumulator.wins / accumulator.games : 0;
      const equityRate = accumulator.games > 0 ? accumulator.equity / accumulator.games : 0;
      const [confidenceLow, confidenceHigh] = equityConfidenceInterval(accumulator);
      return {
        fighter: card.id,
        ...accumulator,
        winRate,
        equityRate,
        confidenceLow,
        confidenceHigh,
        flag: gateFlag(equityRate, confidenceLow, confidenceHigh, scenario),
      };
    }),
  };
}

function topAbility(report: SimulationReport): string {
  const top = [...report.abilityCounts.entries()].sort((left, right) => right[1] - left[1])[0];
  if (!top || report.actions === 0) return 'none';
  return `${top[0]} ${(top[1] / report.actions * 100).toFixed(0)}%`;
}

function policySignal(
  random: SimulationReport,
  varied: SimulationReport,
  tactical: SimulationReport,
): string {
  const rates = [random.equityRate, varied.equityRate, tactical.equityRate];
  if (Math.max(...rates) - Math.min(...rates) >= 0.08) return 'POLICY-SENSITIVE';
  if ([random, varied, tactical].every((report) => report.flag === 'REVIEW')) return 'PERSISTENT';
  return 'STABLE';
}

export function runSimulationReport(): boolean {
  console.log(`\nHOUSE FIGHT BOT BALANCE — seed ${masterSeed}, ≥${requestedMinimumGames} games per fighter`);
  console.log('All policies use public state only; random-enemy targets stay hidden until resolution. Random is a legal-choice baseline, varied is the main human-ish policy, and tactical is near-greedy.');
  console.log('Equity gives a no-winner draw its fair mode share (1/2, 1/3 or 1/4), so double KOs do not masquerade as universal weakness.');

  let hasReview = false;
  for (const scenario of simulationScenarios) {
    const random = simulateScenario(scenario, 'random');
    const varied = simulateScenario(scenario, 'varied');
    const tactical = simulateScenario(scenario, 'tactical');
    hasReview ||= varied.reports.some((report) => report.flag === 'REVIEW');
    const games = varied.reports[0]?.games ?? 0;
    console.log(
      `\n${scenario.id} — ${scenario.matches.length} complete unique configurations × ${varied.repetitions} seed/seat rotations; ${games} games per fighter`,
    );
    console.table(varied.reports.map((report) => ({
      fighter: report.fighter,
      games: report.games,
      'equity %': (report.equityRate * 100).toFixed(1),
      '95% CI': `${(report.confidenceLow * 100).toFixed(1)}–${(report.confidenceHigh * 100).toFixed(1)}`,
      'raw win %': (report.winRate * 100).toFixed(1),
      'draw %': (report.draws / report.games * 100).toFixed(1),
      'avg rounds': (report.rounds / report.games).toFixed(1),
      'top varied move': topAbility(report),
      flag: report.flag,
    })));
    console.log(`${scenario.id} policy sensitivity (same configurations, seeds, and seat rotations)`);
    console.table(varied.reports.map((report, index) => {
      const randomReport = random.reports[index];
      const tacticalReport = tactical.reports[index];
      if (!randomReport || !tacticalReport) throw new Error(`Missing comparison report for ${report.fighter}.`);
      return {
        fighter: report.fighter,
        'random %': (randomReport.equityRate * 100).toFixed(1),
        'varied %': (report.equityRate * 100).toFixed(1),
        'tactical %': (tacticalReport.equityRate * 100).toFixed(1),
        'range pp': ((Math.max(randomReport.equityRate, report.equityRate, tacticalReport.equityRate)
          - Math.min(randomReport.equityRate, report.equityRate, tacticalReport.equityRate)) * 100).toFixed(1),
        'top tactical move': topAbility(tacticalReport),
        signal: policySignal(randomReport, report, tacticalReport),
      };
    }));
  }

  console.log('\nFlags compare varied-policy equity and its empirical 95% interval with broad mode-specific practical bands.');
  console.log('PERSISTENT means random, varied, and tactical policies all retain the review signal; POLICY-SENSITIVE means policy changes equity by at least 8 percentage points.');
  console.log('Every complete card configuration is covered. Bots still cannot model grudges, table talk, bluffing, or coordinated hidden choices.');
  console.log('Use SIM_SEED and SIM_MIN_GAMES to reproduce or deepen the run; set SIM_STRICT=1 to make REVIEW exit non-zero.');
  return hasReview;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  const hasReview = runSimulationReport();
  if (hasReview && process.env.SIM_STRICT === '1') process.exitCode = 1;
}
