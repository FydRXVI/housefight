import type { ClientSnapshot } from '../../shared/protocol.js';
import { Brand } from '../components/Brand.js';
import { FighterCard } from '../components/FighterCard.js';
import { useCountdown } from '../use-countdown.js';

export function RevealScreen({ state }: { state: ClientSnapshot }) {
  const remaining = useCountdown(state.deadline, state.serverTime);
  const count = Math.max(1, Math.ceil(remaining / 1_050));
  const fighters = Object.values(state.battle?.fighters ?? {});
  const special = fighters.find((fighter) => fighter.card.rarity !== 'standard');

  return (
    <main className={`reveal-screen ${special ? 'reveal-screen--special' : ''}`}>
      <header className="game-header"><Brand compact /><span className="match-id">MATCH {state.matchId}</span></header>
      <div className="reveal-screen__burst" aria-hidden="true" />
      <div className="reveal-count" key={count}>{count > 1 ? count - 1 : 'REVEAL'}</div>
      {special && <div className="special-alert">⚠ SPECIAL CARD: {special.card.rarity.toUpperCase()} ⚠</div>}
      <section className="reveal-lineup">
        {fighters.map((fighter, index) => (
          <div className="reveal-entry" style={{ '--reveal-index': index } as React.CSSProperties} key={fighter.id}>
            <span className="reveal-player" dir="auto">{fighter.name} CHOSE</span>
            <FighterCard card={fighter.card} compact />
          </div>
        ))}
      </section>
    </main>
  );
}
