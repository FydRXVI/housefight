import type { ClientMessage, ClientSnapshot } from '../../shared/protocol.js';
import { Brand } from '../components/Brand.js';

interface RecoveryScreenProps {
  state: ClientSnapshot;
  send: (message: ClientMessage) => void;
  arena?: boolean;
}

export function RecoveryScreen({ state, send, arena = false }: RecoveryScreenProps) {
  const self = state.players.find((player) => player.id === state.selfId);
  const phase = state.resumePhase?.toUpperCase() ?? 'MATCH';
  const connected = state.players.filter((player) => !player.spectator && player.connected).length;

  return (
    <main className="recovery-screen">
      <div className="recovery-screen__pulse" aria-hidden="true" />
      <Brand />
      <span className="section-kicker"><span>↻</span> CRASH RECOVERY</span>
      <h1>THE FIGHT<br />SURVIVED.</h1>
      <p>
        Match <bdi dir="auto">{state.matchId ?? 'in progress'}</bdi> was recovered during {phase.toLowerCase()}.
        Private choices, HP, cooldowns, and the seeded random state are intact.
      </p>
      <div className="recovery-roster">
        <strong>{connected}/{state.players.filter((player) => !player.spectator).length}</strong>
        <span>FIGHTERS RECONNECTED</span>
      </div>
      {self?.isHost && !arena ? (
        <button type="button" className="primary-button primary-button--giant" onClick={() => send({ type: 'resume' })}>
          RESUME {phase} <span>↗</span>
        </button>
      ) : (
        <div className="waiting-host"><i /> {arena ? 'WAITING FOR A PLAYER TO RESUME' : 'WAITING FOR THE RECOVERY HOST'}</div>
      )}
      <small>The timer is paused. Nothing will auto-lock while everyone reconnects.</small>
    </main>
  );
}
