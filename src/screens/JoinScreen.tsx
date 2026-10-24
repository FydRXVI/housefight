import { useState } from 'react';
import type { ClientMessage } from '../../shared/protocol.js';
import type { ConnectionStatus } from '../game-socket.js';
import { Brand } from '../components/Brand.js';

const COLORS = [
  { value: '#b7ff38', label: 'Acid green' },
  { value: '#ff6f61', label: 'Coral red' },
  { value: '#52e7ea', label: 'Electric cyan' },
  { value: '#9b82ff', label: 'Violet' },
  { value: '#ffd84d', label: 'Golden yellow' },
  { value: '#ff4db8', label: 'Hot pink' },
] as const;

interface JoinScreenProps {
  status: ConnectionStatus;
  send: (message: ClientMessage) => void;
  matchInProgress?: boolean;
}

export function JoinScreen({ status, send, matchInProgress = false }: JoinScreenProps) {
  const [nickname, setNickname] = useState(() => window.localStorage.getItem('house-fight-name') ?? '');
  const [color, setColor] = useState(() => window.localStorage.getItem('house-fight-color') ?? COLORS[0].value);
  const [spectator, setSpectator] = useState(matchInProgress);

  const join = () => {
    const clean = nickname.trim();
    if (!clean) return;
    window.localStorage.setItem('house-fight-name', clean);
    window.localStorage.setItem('house-fight-color', color);
    send({ type: 'join', nickname: clean, color, spectator: matchInProgress || spectator });
  };

  return (
    <main className="join-screen">
      <div className="join-screen__noise" aria-hidden="true" />
      <section className="join-hero">
        <div className="status-chip"><i className={status === 'open' ? 'is-live' : ''} /> PRIVATE LAN / {status}</div>
        <Brand />
        <p className="join-hero__dek">Pick somebody. Pick a fight. Defend your reputation.</p>
        <div className="join-hero__edition">HOUSE RULES • FIRST EDITION</div>
      </section>

      <section className="join-panel" aria-label="Join the fight">
        <div className="section-kicker"><span>01</span> ENTER THE HOUSE</div>
        <label className="field-label" htmlFor="nickname">FIGHT NAME</label>
        <input
          id="nickname"
          className="text-input"
          value={nickname}
          onChange={(event) => setNickname(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') join(); }}
          maxLength={20}
          autoComplete="nickname"
          placeholder="YOUR NAME"
        />

        <fieldset className="color-picker">
          <legend>YOUR CORNER</legend>
          {COLORS.map((item) => (
            <button
              type="button"
              key={item.value}
              aria-label={`Choose ${item.label}`}
              aria-pressed={color === item.value}
              className={color === item.value ? 'is-selected' : ''}
              style={{ backgroundColor: item.value }}
              onClick={() => setColor(item.value)}
            />
          ))}
        </fieldset>

        <label className={`switch-row ${matchInProgress ? 'is-forced' : ''}`}>
          <input type="checkbox" checked={matchInProgress || spectator} disabled={matchInProgress} onChange={(event) => setSpectator(event.target.checked)} />
          <span className="switch" aria-hidden="true" />
          <span><strong>WATCH ONLY</strong><small>{matchInProgress ? 'A fight is underway, so late arrivals join the crowd.' : 'No private draw. Maximum commentary.'}</small></span>
        </label>

        <button className="primary-button primary-button--giant" type="button" onClick={join} disabled={!nickname.trim() || status !== 'open'}>
          {matchInProgress || spectator ? 'ENTER THE CROWD' : 'STEP INTO THE RING'} <span>↗</span>
        </button>
        <a className="text-link" href="/arena" target="_blank" rel="noreferrer">OPEN SHARED ARENA VIEW ↗</a>
      </section>
    </main>
  );
}
