import { useState } from 'react';
import type { ClientMessage, ClientSnapshot, GamePhase, PublicPlayer, RoomConfig } from '../../shared/protocol.js';
import { Brand } from '../components/Brand.js';

interface LobbyScreenProps {
  state: ClientSnapshot;
  send: (message: ClientMessage) => void;
  arena?: boolean;
}

function rosterRequirement(config: RoomConfig): string {
  if (config.mode === 'duel') return '2 FIGHTERS';
  if (config.mode === 'teams') return '4 FIGHTERS';
  return '3–4 FIGHTERS';
}

function canStart(config: RoomConfig, players: PublicPlayer[]): boolean {
  if (config.mode === 'duel') return players.length === 2;
  if (config.mode === 'teams') {
    return players.length === 4 && players.filter((player) => player.teamId === 'team-a').length === 2;
  }
  return players.length >= 3 && players.length <= 4;
}

function PlayerRow({ player, index, phase, showTeam, onSwitchTeam, onRemove }: {
  player: PublicPlayer;
  index: number;
  phase: GamePhase;
  showTeam?: boolean;
  onSwitchTeam?: () => void;
  onRemove?: () => void;
}) {
  return (
    <li className={!player.connected ? 'is-offline' : ''}>
      <span className="roster-number">{String(index + 1).padStart(2, '0')}</span>
      <i style={{ background: player.color }} />
      <div>
        <strong dir="auto">{player.name}</strong>
        <small>{player.isBot ? 'BOT / READY' : player.connected ? phase === 'lobby' ? 'IN THE HOUSE' : 'CONNECTED' : 'RECONNECTING'}</small>
      </div>
      {player.isHost && <span className="roster-tag">HOST</span>}
      {showTeam && player.teamId && (
        <button type="button" className={`roster-team roster-team--${player.teamId === 'team-a' ? 'acid' : 'coral'}`} onClick={onSwitchTeam} disabled={!onSwitchTeam}>
          {player.teamId === 'team-a' ? 'ACID' : 'CORAL'}{onSwitchTeam ? ' ↔' : ''}
        </button>
      )}
      {onRemove && <button type="button" onClick={onRemove} aria-label={`Remove ${player.name}`}>×</button>}
    </li>
  );
}

export function LobbyScreen({ state, send, arena = false }: LobbyScreenProps) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const active = state.players.filter((player) => !player.spectator);
  const spectators = state.players.filter((player) => player.spectator);
  const self = state.players.find((player) => player.id === state.selfId);
  const isHost = self?.isHost ?? false;
  const ready = canStart(state.config, active);
  const localOnly = ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
  const inviteUrl = localOnly ? (state.joinUrls[0] ?? window.location.origin) : window.location.origin;
  const inviteUnavailable = localOnly && state.joinUrls.length === 0;

  const configure = (change: Partial<RoomConfig>) => {
    send({ type: 'configure', config: { ...state.config, ...change } });
  };
  const copyLink = async () => {
    if (inviteUnavailable) {
      setCopyFailed(true);
      return;
    }
    setCopyFailed(false);
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(inviteUrl);
      else {
        const field = document.createElement('textarea');
        field.value = inviteUrl;
        field.style.position = 'fixed';
        field.style.opacity = '0';
        document.body.append(field);
        field.select();
        if (!document.execCommand('copy')) throw new Error('Copy unavailable');
        field.remove();
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopyFailed(true);
    }
  };

  if (arena) {
    return (
      <main className="arena-lobby">
        <Brand />
        <p>THE HOUSE IS OPEN</p>
        <div className="arena-lobby__url">{inviteUnavailable ? 'SET PUBLIC_BASE_URL ON THE HOST' : inviteUrl}</div>
        <div className="arena-lobby__code">ROOM <strong>{state.roomCode}</strong></div>
        <ol className="arena-roster">
          {active.map((player, index) => <PlayerRow key={player.id} player={player} index={index} phase={state.phase} showTeam={state.config.mode === 'teams'} />)}
          {Array.from({ length: Math.max(0, 4 - active.length) }, (_, index) => (
            <li className="is-empty" key={`empty-${index}`}><span>+</span> WAITING FOR TROUBLE</li>
          ))}
        </ol>
        <small className="arena-lobby__footer">Phones hold the secrets. This screen holds the drama.</small>
      </main>
    );
  }

  return (
    <main className="lobby-screen">
      <header className="game-header">
        <Brand compact />
        <div className="room-badge"><span>ROOM</span><strong>{state.roomCode}</strong></div>
      </header>

      <div className="lobby-grid">
        <section className="lobby-roster game-panel">
          <div className="panel-heading">
            <div><span className="section-kicker"><span>01</span> THE LINEUP</span><h1>WHO’S IN?</h1></div>
            <span>{active.length}/4</span>
          </div>
          <ol>
            {active.map((player, index) => (
              <PlayerRow
                key={player.id}
                player={player}
                index={index}
                phase={state.phase}
                showTeam={state.config.mode === 'teams'}
                onSwitchTeam={isHost && state.config.mode === 'teams' ? () => send({ type: 'switch-team', playerId: player.id }) : undefined}
                onRemove={isHost && !player.isHost && (player.isBot || !player.connected)
                  ? () => send({ type: player.isBot ? 'remove-bot' : 'remove-player', playerId: player.id })
                  : undefined}
              />
            ))}
          </ol>
          {isHost && active.length < 4 && (
            <button type="button" className="dashed-button" onClick={() => send({ type: 'add-bot' })}>+ ADD A CHAOS BOT</button>
          )}
          {spectators.length > 0 && <p className="spectator-count">◉ {spectators.length} spectator{spectators.length === 1 ? '' : 's'} lurking</p>}
        </section>

        <section className="lobby-settings game-panel">
          <span className="section-kicker"><span>02</span> HOUSE RULES</span>
          <div className="setting-block">
            <div className="setting-title"><strong>FORMAT</strong><span>{rosterRequirement(state.config)}</span></div>
            <div className="segmented-control segmented-control--three">
              {(['duel', 'ffa', 'teams'] as const).map((mode) => (
                <button type="button" key={mode} className={state.config.mode === mode ? 'is-active' : ''} disabled={!isHost} onClick={() => configure({ mode })}>
                  {mode === 'duel' ? '1 V 1' : mode === 'ffa' ? 'FREE FOR ALL' : '2 V 2'}
                </button>
              ))}
            </div>
          </div>
          <div className="setting-block">
            <div className="setting-title"><strong>PLAYLIST</strong><span>{state.config.playlist === 'party' ? 'UNFAIR ON PURPOSE' : 'STANDARD CARDS'}</span></div>
            <div className="playlist-options">
              <button type="button" className={state.config.playlist === 'balanced' ? 'is-active' : ''} disabled={!isHost} onClick={() => configure({ playlist: 'balanced' })}>
                <span>◎</span><div><strong>BALANCED</strong><small>No bosses. No curses. Mostly dignity.</small></div>
              </button>
              <button type="button" className={state.config.playlist === 'party' ? 'is-active party' : 'party'} disabled={!isHost} onClick={() => configure({ playlist: 'party' })}>
                <span>✦</span><div><strong>PARTY</strong><small>Rare bosses (⅕ weight) · 10% cursed hijack.</small></div>
              </button>
            </div>
          </div>

          {isHost ? (
            <button type="button" className="primary-button primary-button--giant" disabled={!ready} onClick={() => send({ type: 'start' })}>
              {ready ? 'START THE FIGHT' : `NEED ${rosterRequirement(state.config)}`} <span>↗</span>
            </button>
          ) : (
            <div className="waiting-host"><i /> HOST IS SETTING THE RULES</div>
          )}
        </section>
      </div>

      <footer className="invite-strip">
        <div><span>{inviteUnavailable ? 'LAN ADDRESS NEEDED' : copyFailed ? 'COPY FAILED — SHARE THIS' : 'BRING THEM IN'}</span><strong>{inviteUnavailable ? 'SET PUBLIC_BASE_URL ON THE HOST' : inviteUrl.replace(/^https?:\/\//, '')}</strong></div>
        <button type="button" disabled={inviteUnavailable} onClick={() => { void copyLink(); }}>{inviteUnavailable ? 'NOT SHAREABLE' : copied ? 'COPIED ✓' : copyFailed ? 'TRY AGAIN' : 'COPY LINK'}</button>
      </footer>
    </main>
  );
}
