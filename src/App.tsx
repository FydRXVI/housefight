import { useEffect } from 'react';
import { Brand } from './components/Brand.js';
import { SoundtrackDock } from './components/SoundtrackDock.js';
import { useGameSocket } from './game-socket.js';
import { AdminScreen } from './screens/AdminScreen.js';
import { BattleScreen } from './screens/BattleScreen.js';
import { DraftScreen } from './screens/DraftScreen.js';
import { JoinScreen } from './screens/JoinScreen.js';
import { LobbyScreen } from './screens/LobbyScreen.js';
import { RevealScreen } from './screens/RevealScreen.js';
import { RecoveryScreen } from './screens/RecoveryScreen.js';

function LoadingScreen({ message }: { message: string }) {
  return (
    <main className="loading-screen">
      <Brand />
      <div className="loading-bars" aria-hidden="true"><i /><i /><i /><i /></div>
      <p>{message}</p>
    </main>
  );
}

function usePhaseScroll(phase: string | undefined, identity: string | null | undefined): void {
  useEffect(() => {
    if (phase) window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [phase, identity]);
}

function PlayerApplication() {
  const { state, status, send } = useGameSocket('player');
  usePhaseScroll(state?.phase, state?.selfId);
  if (!state) return <LoadingScreen message={status === 'closed' ? 'RECONNECTING TO THE HOUSE…' : 'OPENING THE HOUSE…'} />;
  if (!state.selfId) return <JoinScreen status={status} send={send} matchInProgress={state.phase !== 'lobby'} />;

  return (
    <>
      {state.phase === 'lobby' && <LobbyScreen state={state} send={send} />}
      {state.phase === 'draft' && <DraftScreen state={state} send={send} />}
      {state.phase === 'reveal' && <RevealScreen state={state} />}
      {state.phase === 'paused' && <RecoveryScreen state={state} send={send} />}
      {['planning', 'resolution', 'finished'].includes(state.phase) && (
        <BattleScreen key={`${state.matchId}-${state.battle?.round ?? 0}-${state.phase}`} state={state} send={send} />
      )}
      {state.error && <div className="error-toast" role="alert"><strong>HOUSE SAYS NO</strong><span>{state.error}</span></div>}
      {status !== 'open' && <div className="reconnect-blocker" role="status"><strong>RECONNECTING…</strong><span>Controls are paused. Nothing you tap will be submitted until the link is back.</span></div>}
      <SoundtrackDock compact={state.phase === 'resolution'} />
    </>
  );
}

function ArenaApplication() {
  const { state, status, send } = useGameSocket('arena');
  usePhaseScroll(state?.phase, state?.selfId);
  if (!state) return <LoadingScreen message={status === 'closed' ? 'RECONNECTING ARENA…' : 'LIGHTING THE ARENA…'} />;
  return (
    <>
      {state.phase === 'lobby' && <LobbyScreen state={state} send={send} arena />}
      {state.phase === 'draft' && <DraftScreen state={state} send={send} arena />}
      {state.phase === 'reveal' && <RevealScreen state={state} />}
      {state.phase === 'paused' && <RecoveryScreen state={state} send={send} arena />}
      {['planning', 'resolution', 'finished'].includes(state.phase) && (
        <BattleScreen key={`${state.matchId}-${state.battle?.round ?? 0}-${state.phase}`} state={state} send={send} arena />
      )}
      {status !== 'open' && <div className="reconnect-blocker" role="status"><strong>ARENA RECONNECTING…</strong><span>The recovered display will return automatically.</span></div>}
      <SoundtrackDock compact={state.phase === 'resolution'} />
    </>
  );
}

export function App() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  if (path === '/admin') return <><AdminScreen /><SoundtrackDock /></>;
  if (path === '/arena') return <ArenaApplication />;
  return <PlayerApplication />;
}
