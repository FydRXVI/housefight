import type { ClientMessage, ClientSnapshot } from '../../shared/protocol.js';
import { Brand } from '../components/Brand.js';
import { Countdown } from '../components/Countdown.js';
import { FighterCard } from '../components/FighterCard.js';

interface DraftScreenProps {
  state: ClientSnapshot;
  send: (message: ClientMessage) => void;
  arena?: boolean;
}

export function DraftScreen({ state, send, arena = false }: DraftScreenProps) {
  const active = state.players.filter((player) => !player.spectator);
  const chosen = active.filter((player) => player.locked).length;
  const options = state.draftOptions ?? [];
  const selectFighter = (fighterId: string) => {
    if (state.matchId) send({ type: 'select-fighter', matchId: state.matchId, fighterId });
  };

  if (arena || options.length === 0) {
    return (
      <main className="sealed-screen">
        <Brand />
        <div className="sealed-screen__icon" aria-hidden="true"><span>?</span><span>?</span><span>?</span></div>
        <h1>CHOICES ARE<br />UNDER SEAL</h1>
        <p>{chosen} OF {active.length} FIGHTERS LOCKED</p>
        <div className="lock-pips">
          {active.map((player) => <i key={player.id} className={player.locked ? 'is-locked' : ''} style={{ '--pip': player.color } as React.CSSProperties} />)}
        </div>
        <Countdown deadline={state.deadline} serverTime={state.serverTime} label="THE DRAW CLOSES" urgentAt={5_000} duration={30_000} />
      </main>
    );
  }

  return (
    <main className={`draft-screen ${state.cursedHijack ? 'draft-screen--cursed' : ''}`}>
      <header className="game-header">
        <Brand compact />
        <Countdown deadline={state.deadline} serverTime={state.serverTime} urgentAt={5_000} duration={30_000} />
      </header>
      <section className="draft-heading">
        <span className="section-kicker"><span>02</span> PRIVATE DRAW</span>
        <h1>{state.cursedHijack ? 'YOUR CHOICE WAS OVERRIDDEN.' : 'CHOOSE YOUR FIGHTER'}</h1>
        <p>{state.cursedHijack ? 'The house has made a deeply personal decision.' : 'Tap a card to lock it. Nobody else can see your hand.'}</p>
      </section>
      {state.cursedHijack && <div className="warning-tape">⚠ CURSED HIJACK ⚠ CURSED HIJACK ⚠ CURSED HIJACK ⚠</div>}
      <div className={`draft-cards ${options.length === 1 ? 'draft-cards--single' : ''}`}>
        {options.map((card) => (
          <FighterCard
            key={card.id}
            card={card}
            selected={state.selectedFighterId === card.id}
            showAbilities
            disabled={state.cursedHijack || !state.matchId}
            onClick={() => selectFighter(card.id)}
          />
        ))}
      </div>
      <footer className="draft-progress"><strong>{chosen}/{active.length}</strong> PLAYERS LOCKED <span>YOUR PICK STAYS SECRET UNTIL REVEAL</span></footer>
    </main>
  );
}
