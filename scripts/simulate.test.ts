import { describe, expect, it } from 'vitest';
import { simulateScenario, simulationScenarios } from './simulate.js';

describe('complete balance simulation design', () => {
  it('enumerates every roster and every 2v2 partition', () => {
    expect(Object.fromEntries(
      simulationScenarios.map((scenario) => [scenario.id, scenario.matches.length]),
    )).toEqual({
      DUEL: 66,
      'FFA 3': 220,
      'FFA 4': 495,
      '2V2': 1_485,
    });

    const appearancesPerFighter = {
      DUEL: 11,
      'FFA 3': 55,
      'FFA 4': 165,
      '2V2': 495,
    } as const;
    for (const scenario of simulationScenarios) {
      const appearances = new Map<string, number>();
      for (const match of scenario.matches) {
        expect(new Set(match.seats.map((seat) => seat.card.id)).size).toBe(scenario.size);
        for (const seat of match.seats) {
          appearances.set(seat.card.id, (appearances.get(seat.card.id) ?? 0) + 1);
        }
      }
      expect(new Set(appearances.values())).toEqual(new Set([appearancesPerFighter[scenario.id]]));
    }
  });

  it('is reproducible, seat-balanced, and conserves duel equity', () => {
    const duel = simulationScenarios.find((scenario) => scenario.id === 'DUEL');
    expect(duel).toBeDefined();
    const first = simulateScenario(duel!, 'varied', 1, 91_337);
    const second = simulateScenario(duel!, 'varied', 1, 91_337);

    expect(second).toEqual(first);
    expect(first.repetitions).toBe(2);
    expect(new Set(first.reports.map((report) => report.games))).toEqual(new Set([22]));
    expect(first.reports.reduce((total, report) => total + report.equityRate, 0)).toBeCloseTo(6, 10);
    expect(first.reports.every((report) => report.actions > 0 && report.abilityCounts.size > 0)).toBe(true);
  });
});
