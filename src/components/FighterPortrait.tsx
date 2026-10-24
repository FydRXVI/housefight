import { useId, useState } from 'react';
import type { CSSProperties } from 'react';
import type { CardDefinition } from '../../engine/types.js';

interface FighterPortraitProps {
  card: CardDefinition;
  compact?: boolean;
}

export function FighterPortrait({ card, compact = false }: FighterPortraitProps) {
  const gradientId = useId().replace(/:/g, '');
  const [failedMediaId, setFailedMediaId] = useState<string | null>(null);
  const mediaId = card.portrait?.mediaId ?? null;
  const imageFailed = mediaId !== null && failedMediaId === mediaId;
  const variant = card.avatarSeed % 4;
  const eyeOffset = card.avatarSeed % 3;
  const initials = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(card.name)]
    .slice(0, 2)
    .map((segment) => segment.segment)
    .join('');
  const portraitStyle = card.portrait ? {
    '--portrait-x': `${card.portrait.focalX}%`,
    '--portrait-y': `${card.portrait.focalY}%`,
  } as CSSProperties : undefined;

  return (
    <div className={`fighter-portrait ${card.portrait && !imageFailed ? 'fighter-portrait--photo' : ''} ${compact ? 'fighter-portrait--compact' : ''}`} style={portraitStyle}>
      {card.portrait && !imageFailed ? (
        <img
          src={`/api/media/${encodeURIComponent(card.portrait.mediaId)}`}
          alt={`${card.name} portrait`}
          loading="eager"
          decoding="async"
          draggable={false}
          onError={() => setFailedMediaId(mediaId)}
        />
      ) : <svg viewBox="0 0 300 360" role="img" aria-label={`${card.name} illustrated portrait`}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={card.accent} />
            <stop offset="1" stopColor={card.accentAlt} />
          </linearGradient>
          <pattern id={`${gradientId}-grid`} width="28" height="28" patternUnits="userSpaceOnUse" patternTransform="rotate(18)">
            <path d="M 0 0 L 0 28" stroke="rgba(0,0,0,.18)" strokeWidth="7" />
          </pattern>
        </defs>
        <rect width="300" height="360" fill={`url(#${gradientId})`} />
        <rect width="300" height="360" fill={`url(#${gradientId}-grid)`} />
        <circle cx={variant % 2 ? 35 : 270} cy="45" r="82" fill="rgba(255,255,255,.15)" />
        <path d="M26 360c15-92 57-138 124-138s108 46 124 138H26Z" fill="#111116" />
        <path d="M65 198c0-75 35-130 87-130 57 0 87 48 87 130 0 54-37 93-87 93-49 0-87-39-87-93Z" fill="#f2c6a5" />
        {variant === 0 && <path d="M61 159C70 62 120 42 155 51c49 10 85 54 79 123-28-18-52-34-65-67-22 33-62 47-108 52Z" fill="#17151c" />}
        {variant === 1 && <path d="M58 148c6-71 45-107 94-107 55 0 91 42 91 116-26-6-50-26-64-53-20 27-64 45-121 44Z" fill="#532f20" />}
        {variant === 2 && <path d="M55 167C55 87 91 42 151 42c56 0 97 44 97 129-16-26-32-38-52-51-28 33-83 51-141 47Z" fill="#191821" />}
        {variant === 3 && <path d="M64 157C67 74 104 48 150 48c52 0 88 31 90 113l-24-28-24 17-24-28-26 23-26-24-25 29-27-13Z" fill="#2a1a14" />}
        <ellipse cx={117 - eyeOffset} cy="184" rx="7" ry="9" fill="#16151a" />
        <ellipse cx={184 + eyeOffset} cy="184" rx="7" ry="9" fill="#16151a" />
        <path d="M127 231c17 13 34 13 51 0" stroke="#b76262" strokeWidth="6" strokeLinecap="round" fill="none" />
        <path d="M150 190l-8 24h16" stroke="#b98874" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        <circle cx="64" cy="300" r="31" fill={card.accent} stroke="#0c0c10" strokeWidth="9" />
        <text x="64" y="308" textAnchor="middle" fill="#0c0c10" fontSize="24" fontFamily="Impact, sans-serif">{initials}</text>
      </svg>}
      <div className="fighter-portrait__shine" />
    </div>
  );
}
