import type { CSSProperties, MouseEventHandler } from 'react';
import type { CardDefinition } from '../../engine/types.js';
import { FighterPortrait } from './FighterPortrait.js';

interface FighterCardProps {
  card: CardDefinition;
  selected?: boolean;
  compact?: boolean;
  showAbilities?: boolean;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  disabled?: boolean;
}

export function FighterCard({
  card,
  selected = false,
  compact = false,
  showAbilities = false,
  onClick,
  disabled = false,
}: FighterCardProps) {
  const style = {
    '--fighter-accent': card.accent,
    '--fighter-accent-alt': card.accentAlt,
  } as CSSProperties;
  const content = (
    <>
      <div className="fighter-card__flags">
        <span dir="auto">{card.rarity === 'standard' ? card.archetype : card.rarity}</span>
        <strong>{card.hp} HP</strong>
      </div>
      <FighterPortrait card={card} compact={compact} />
      <div className="fighter-card__body">
        <p className="fighter-card__eyebrow" dir="auto">{card.title}</p>
        <h3 dir="auto">{card.name}</h3>
        <blockquote dir="auto">“{card.quote}”</blockquote>
        {showAbilities && (
          <ol className="fighter-card__moves">
            {card.abilities.map((ability, index) => (
              <li key={ability.id}>
                <span>0{index + 1}</span>
                <div><strong dir="auto">{ability.name}</strong><small dir="auto">{ability.description}</small></div>
              </li>
            ))}
          </ol>
        )}
      </div>
      {selected && <span className="fighter-card__stamp">LOCKED</span>}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        className={`fighter-card ${compact ? 'fighter-card--compact' : ''} ${selected ? 'fighter-card--selected' : ''}`}
        style={style}
        onClick={onClick}
        disabled={disabled}
        aria-pressed={selected}
      >
        {content}
      </button>
    );
  }

  return <article className={`fighter-card ${compact ? 'fighter-card--compact' : ''}`} style={style}>{content}</article>;
}
