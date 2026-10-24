import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { eligibleTargets, getAbilityAvailability } from '../../engine/engine.js';
import type { AbilityDefinition, BattleEvent, CombatantState } from '../../engine/types.js';
import type { ClientMessage, ClientSnapshot, PublicPlayer } from '../../shared/protocol.js';
import { Brand } from '../components/Brand.js';
import { Countdown } from '../components/Countdown.js';
import { FighterPortrait } from '../components/FighterPortrait.js';

interface BattleScreenProps {
  state: ClientSnapshot;
  send: (message: ClientMessage) => void;
  arena?: boolean;
}

function FighterHud({
  fighter,
  player,
  relation,
  targetable,
  targeted,
  impact,
  onTarget,
}: {
  fighter: CombatantState;
  player: PublicPlayer | undefined;
  relation: 'self' | 'ally' | 'enemy' | 'neutral';
  targetable: boolean;
  targeted: boolean;
  impact?: 'damage' | 'heal' | 'shield' | 'ko';
  onTarget?: () => void;
}) {
  const hpPercent = Math.max(0, (fighter.hp / fighter.card.hp) * 100);
  const style = {
    '--fighter-accent': fighter.card.accent,
    '--fighter-accent-alt': fighter.card.accentAlt,
    '--hp': `${hpPercent}%`,
  } as CSSProperties;
  const content = (
    <>
      <div className="combatant__portrait"><FighterPortrait card={fighter.card} compact /></div>
      <div className="combatant__content">
        <div className="combatant__owner"><span dir="auto">{player?.name ?? fighter.name}</span>{player?.locked && <i>LOCKED</i>}</div>
        <h2 dir="auto">{fighter.card.name}</h2>
        <div className="hp-line"><strong>{fighter.hp}</strong><span>/ {fighter.card.hp} HP</span>{fighter.shield > 0 && <em>+{fighter.shield} SHIELD</em>}</div>
        <div className="hp-track"><span /></div>
        <div className="status-row">
          {fighter.statuses.slice(0, 3).map((status) => <span key={status.id} dir="auto">{status.label} · {status.duration}</span>)}
          {fighter.statuses.length > 3 && <span>+{fighter.statuses.length - 3} MORE</span>}
          {fighter.statuses.length === 0 && <small>NO ACTIVE EFFECTS</small>}
        </div>
      </div>
      {fighter.hp <= 0 && <div className="ko-stamp">KO</div>}
      {targetable && <div className="target-prompt">TAP TO TARGET</div>}
    </>
  );

  if (onTarget) {
    return <button type="button" aria-pressed={targeted} className={`combatant combatant--${relation} ${targetable ? 'is-targetable' : ''} ${targeted ? 'is-targeted' : ''} ${impact ? `combatant--impact-${impact}` : ''}`} style={style} onClick={onTarget}>{content}</button>;
  }
  return <article className={`combatant combatant--${relation} ${impact ? `combatant--impact-${impact}` : ''}`} style={style}>{content}</article>;
}

function AbilityButton({
  ability,
  fighter,
  round,
  selected,
  locked,
  onClick,
  index,
}: {
  ability: AbilityDefinition;
  fighter: CombatantState;
  round: number;
  selected: boolean;
  locked: boolean;
  onClick: () => void;
  index: number;
}) {
  const availability = getAbilityAvailability(fighter, ability, round);
  const priorityLabel = ['PROTECT', 'FAST', 'STANDARD', 'SLOW'][ability.priority];
  return (
    <button
      type="button"
      className={`ability-button ${selected ? 'is-selected' : ''} ${ability.oncePerMatch ? 'is-signature' : ''}`}
      onClick={onClick}
      disabled={!availability.available || locked}
      aria-pressed={selected}
    >
      <span className="ability-button__number">0{index + 1}</span>
      <span className="ability-button__copy"><strong dir="auto">{ability.name}</strong><small dir="auto">{ability.description}</small></span>
      <span className="ability-button__meta">
        <i>{priorityLabel}</i>
        <b>{availability.available ? ability.cooldown > 0 ? `READY · ${ability.cooldown}R AFTER USE` : 'READY' : availability.reason}</b>
      </span>
    </button>
  );
}

function EventFeed({ events, cinematic = false, all = false }: { events: BattleEvent[]; cinematic?: boolean; all?: boolean }) {
  const visible = cinematic ? events : all ? [...events].reverse() : events.slice(-9).reverse();
  const eventStep = cinematic
    ? Math.min(110, Math.max(28, Math.floor(3_000 / Math.max(1, visible.length - 1))))
    : 0;
  return (
    <div className={`event-feed ${cinematic ? 'event-feed--cinematic' : ''}`} aria-live={cinematic ? 'polite' : 'off'}>
      {visible.map((event, index) => (
        <div
          className={`event-line event-line--${event.tone}`}
          key={event.id}
          style={{ '--event-index': index, '--event-delay': `${index * eventStep}ms` } as CSSProperties}
        >
          <span>{event.type === 'damage' ? '✹' : event.type === 'heal' ? '+' : event.type === 'ko' ? '×' : '→'}</span>
          <p dir="auto">{event.message}</p>
        </div>
      ))}
    </div>
  );
}

export function BattleScreen({ state, send, arena = false }: BattleScreenProps) {
  const battle = state.battle;
  const [selectedAbilityId, setSelectedAbilityId] = useState<string | null>(() => (
    state.intents.find((intent) => intent.playerId === state.selfId)?.abilityId ?? null
  ));
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(() => (
    state.intents.find((intent) => intent.playerId === state.selfId)?.targetIds[0] ?? null
  ));

  const self = battle && state.selfId ? battle.fighters[state.selfId] : undefined;
  const selfPlayer = state.players.find((player) => player.id === state.selfId);
  const selfIntent = state.intents.find((intent) => intent.playerId === state.selfId);
  const selectedAbility = self?.card.abilities.find((ability) => ability.id === selectedAbilityId);
  const targetIds = battle && self && selectedAbility ? eligibleTargets(battle, self.id, selectedAbility) : [];
  const fighters = Object.values(battle?.fighters ?? {});
  const grouped = useMemo(() => {
    if (!battle || battle.mode !== 'teams') return [fighters];
    const teams = new Map<string, CombatantState[]>();
    fighters.forEach((fighter) => teams.set(fighter.teamId, [...(teams.get(fighter.teamId) ?? []), fighter]));
    return [...teams.values()];
  }, [battle, fighters]);

  if (!battle) return null;

  const submit = (ability: AbilityDefinition, targets: string[]) => {
    if (!state.matchId) return;
    setSelectedAbilityId(ability.id);
    setSelectedTargetId(targets[0] ?? null);
    send({
      type: 'choose-action',
      matchId: state.matchId,
      round: battle.round,
      action: { abilityId: ability.id, targetIds: targets },
    });
  };

  const chooseAbility = (ability: AbilityDefinition) => {
    if (!self) return;
    const targets = eligibleTargets(battle, self.id, ability);
    setSelectedAbilityId(ability.id);
    setSelectedTargetId(null);
    if (ability.target === 'self') submit(ability, [self.id]);
    else if (ability.target === 'all-enemies') submit(ability, targets);
    else if (ability.target === 'random-enemy') submit(ability, []);
    else if (targets.length === 1 && targets[0]) submit(ability, [targets[0]]);
  };

  const chooseTarget = (targetId: string) => {
    if (selectedAbility) submit(selectedAbility, [targetId]);
  };

  const relationFor = (fighter: CombatantState): 'self' | 'ally' | 'enemy' | 'neutral' => {
    if (!self) return 'neutral';
    if (fighter.id === self.id) return 'self';
    return fighter.teamId === self.teamId ? 'ally' : 'enemy';
  };

  const isPlanning = state.phase === 'planning';
  const canControl = isPlanning && self !== undefined && self.hp > 0 && !arena && state.matchId !== null;
  const teammateIntents = state.intents.filter((intent) => intent.playerId !== state.selfId);
  const displayRound = state.phase === 'resolution' && !battle.finished
    ? Math.max(1, battle.round - 1)
    : battle.round;
  const impactFor = (fighterId: string): 'damage' | 'heal' | 'shield' | 'ko' | undefined => {
    if (state.phase !== 'resolution') return undefined;
    const event = [...state.lastEvents].reverse().find((candidate) => candidate.targetId === fighterId
      && ['damage', 'heal', 'shield', 'ko'].includes(candidate.type));
    return event?.type === 'damage' || event?.type === 'heal' || event?.type === 'shield' || event?.type === 'ko'
      ? event.type
      : undefined;
  };
  const heavyImpact = state.lastEvents.some((event) => event.tone === 'danger' || event.tone === 'ko');
  const specialImpact = state.lastEvents.some((event) => event.tone === 'special');
  const resolutionHumans = state.players.filter((player) => !player.spectator
    && !player.isBot
    && Object.hasOwn(battle.fighters, player.id));
  const resolutionReadyCount = resolutionHumans.filter((player) => state.resolutionReadyPlayerIds.includes(player.id)).length;
  const selfResolutionReady = state.selfId !== null && state.resolutionReadyPlayerIds.includes(state.selfId);

  return (
    <main className={`battle-screen ${arena ? 'battle-screen--arena' : ''} ${state.phase === 'resolution' ? 'is-resolving' : ''} ${heavyImpact ? 'has-heavy-impact' : ''} ${specialImpact ? 'has-special-impact' : ''}`}>
      <header className="battle-header">
        <Brand compact />
        <div className="round-marker"><span>ROUND</span><strong>{String(displayRound).padStart(2, '0')}</strong></div>
        {state.phase === 'planning' ? (
          <Countdown deadline={state.deadline} serverTime={state.serverTime} label="PLANNING" urgentAt={3_500} duration={12_000} />
        ) : state.phase === 'resolution' ? (
          <Countdown deadline={state.deadline} serverTime={state.serverTime} label="REVIEW" urgentAt={3_000} duration={12_000} />
        ) : (
          <div className="phase-badge">FINAL</div>
        )}
      </header>

      <section className={`battlefield battlefield--${battle.mode}`}>
        {grouped.map((team, teamIndex) => (
          <div className="battlefield__team" key={team[0]?.teamId ?? teamIndex}>
            {battle.mode === 'teams' && <div className="team-label">TEAM {teamIndex === 0 ? 'ACID' : 'CORAL'}</div>}
            {team.map((fighter) => {
              const targetable = Boolean(canControl && selectedAbility && targetIds.includes(fighter.id));
              return (
                <FighterHud
                  key={fighter.id}
                  fighter={fighter}
                  player={state.players.find((player) => player.id === fighter.id)}
                  relation={relationFor(fighter)}
                  targetable={targetable}
                  targeted={selectedTargetId === fighter.id}
                  impact={impactFor(fighter.id)}
                  onTarget={targetable ? () => chooseTarget(fighter.id) : undefined}
                />
              );
            })}
          </div>
        ))}
        <div className="battlefield__versus" aria-hidden="true">VS</div>
      </section>

      {!arena && <aside className="desktop-event-panel"><span className="section-kicker"><span>↳</span> FIGHT LOG</span><EventFeed events={state.lastEvents} all /></aside>}

      {!arena && state.lastEvents.length > 0 && (
        <details className="mobile-round-log">
          <summary>LAST ROUND · {state.lastEvents.length} EVENTS</summary>
          <EventFeed events={state.lastEvents} all />
        </details>
      )}

      {canControl && (
        <section className="command-deck">
          <div className="command-deck__heading">
            <div><span className="section-kicker"><span>03</span> MAKE YOUR MOVE</span><h2>{selfPlayer?.name}, CHOOSE WISELY.</h2></div>
            {selectedAbility && ['enemy', 'ally'].includes(selectedAbility.target) && !selectedTargetId && <strong className="target-callout">NOW PICK A TARGET ↑</strong>}
          </div>
          {teammateIntents.length > 0 && (
            <div className="team-intent">
              <span>TEAMMATE INTENT</span>
              {teammateIntents.map((intent) => {
                const teammate = battle.fighters[intent.playerId];
                const ability = teammate?.card.abilities.find((candidate) => candidate.id === intent.abilityId);
                const targets = intent.targetIds.map((id) => battle.fighters[id]?.card.name).filter(Boolean).join(', ');
                return <strong key={intent.playerId}>{teammate?.name}: {ability?.name} → {targets || 'RANDOM'} {intent.locked ? '✓' : '…'}</strong>;
              })}
            </div>
          )}
          <div className="ability-grid">
            {self.card.abilities.map((ability, index) => (
              <AbilityButton
                key={ability.id}
                ability={ability}
                fighter={self}
                round={battle.round}
                index={index}
                selected={(selfIntent?.abilityId ?? selectedAbilityId) === ability.id}
                locked={selfIntent?.locked ?? false}
                onClick={() => chooseAbility(ability)}
              />
            ))}
          </div>
          <button
            type="button"
            className="lock-button"
            disabled={!selfIntent || selfIntent.locked || !state.matchId}
            onClick={() => {
              if (state.matchId) send({ type: 'lock-action', matchId: state.matchId, round: battle.round });
            }}
          >
            {selfIntent?.locked ? 'ACTION LOCKED ✓' : selfIntent ? 'LOCK IT IN' : 'CHOOSE A MOVE'}
          </button>
        </section>
      )}

      {isPlanning && self && self.hp <= 0 && !arena && <div className="spectating-banner">YOU’RE KO — ENJOY THE DRAMA</div>}
      {isPlanning && !self && !arena && <div className="spectating-banner">SPECTATOR MODE — CHOICES STAY PRIVATE</div>}

      {state.phase === 'resolution' && (
        <section className="resolution-overlay">
          <div className="impact-burst" aria-hidden="true">{Array.from({ length: 10 }, (_, index) => <i key={index} />)}</div>
          <div className="resolution-overlay__label">ROUND {displayRound} / RESOLUTION</div>
          <EventFeed events={state.lastEvents} cinematic />
          <div className="resolution-ready" role="group" aria-label="Round review readiness">
            <div><strong>{resolutionReadyCount} / {resolutionHumans.length} READY</strong><span>THE REVIEW SKIPS WHEN EVERY PLAYER IS READY</span></div>
            {!arena && self && state.matchId && (
              <button
                type="button"
                disabled={selfResolutionReady}
                onClick={() => send({ type: 'ready-resolution', matchId: state.matchId as string, round: battle.round })}
              >
                {selfResolutionReady ? 'READY — WAITING…' : battle.finished ? 'READY FOR RESULTS' : 'READY FOR NEXT ROUND'}
              </button>
            )}
          </div>
        </section>
      )}

      {state.phase === 'finished' && (
        <section className="victory-overlay">
          <div className="victory-confetti" aria-hidden="true">{Array.from({ length: 20 }, (_, index) => <i key={index} style={{ '--confetti-index': index } as CSSProperties} />)}</div>
          <span>{battle.winnerPlayerIds?.length ? 'THE HOUSE HAS SPOKEN' : 'NO SURVIVORS'}</span>
          <h1>{battle.winnerPlayerIds?.length
            ? battle.winnerPlayerIds.map((id) => battle.fighters[id]?.card.name).filter(Boolean).join(' + ')
            : 'DOUBLE KO'}</h1>
          <p>Match {state.matchId} · Seed {battle.seed} · {battle.round} rounds</p>
          {selfPlayer?.isHost && <button type="button" className="primary-button primary-button--giant" onClick={() => send({ type: 'rematch' })}>RUN IT BACK ↻</button>}
          {!selfPlayer?.isHost && !arena && <div className="waiting-host"><i /> WAITING FOR THE HOST</div>}
        </section>
      )}
    </main>
  );
}
