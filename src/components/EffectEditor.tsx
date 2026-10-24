import type { Condition, Effect, StatusKind } from '../../engine/types.js';

const EFFECT_KINDS: Effect['kind'][] = [
  'damage', 'heal', 'shield', 'status', 'disable', 'cleanse', 'steal-status', 'self-damage', 'conditional',
];
const STATUS_KINDS: StatusKind[] = [
  'damage-up', 'damage-down', 'vulnerable', 'resistant', 'dodge', 'reflect', 'taunt', 'dot', 'hot', 'empowered', 'disabled',
];
const PERCENT_STATUS_KINDS = new Set<StatusKind>([
  'damage-up', 'damage-down', 'vulnerable', 'resistant', 'dodge', 'reflect',
]);
const AMOUNT_STATUS_KINDS = new Set<StatusKind>(['dot', 'hot', 'empowered']);
const CONDITION_KINDS: Condition['kind'][] = [
  'target-hp-below', 'self-hp-below', 'round-at-least', 'target-has-status', 'damaged-by-target-last-round', 'chance',
];

// Kept here because AdminScreen imports the factory from the component module.
// eslint-disable-next-line react-refresh/only-export-components
export function defaultEffect(kind: Effect['kind']): Effect {
  switch (kind) {
    case 'damage': return { kind, amount: 20 };
    case 'heal': return { kind, amount: 20 };
    case 'shield': return { kind, amount: 20 };
    case 'self-damage': return { kind, amount: 10 };
    case 'status': return { kind, status: { kind: 'vulnerable', label: 'Caught Lacking', duration: 2, value: 0.15 } };
    case 'disable': return { kind, duration: 1 };
    case 'cleanse': return { kind, count: 1 };
    case 'steal-status': return { kind, count: 1 };
    case 'conditional': return {
      kind,
      condition: { kind: 'target-hp-below', percent: 0.4 },
      effects: [{ kind: 'damage', amount: 30 }],
    };
  }
}

function defaultCondition(kind: Condition['kind']): Condition {
  switch (kind) {
    case 'target-hp-below': return { kind, percent: 0.4 };
    case 'self-hp-below': return { kind, percent: 0.4 };
    case 'round-at-least': return { kind, round: 3 };
    case 'target-has-status': return { kind, status: 'vulnerable' };
    case 'damaged-by-target-last-round': return { kind };
    case 'chance': return { kind, probability: 0.5 };
  }
}

function withOptional(effect: Effect, field: 'chance' | 'recipient', value: number | 'target' | 'self' | undefined): Effect {
  const copy = { ...effect };
  if (value === undefined) delete copy[field];
  else Object.assign(copy, { [field]: value });
  return copy;
}

function changeStatusKind(effect: Extract<Effect, { kind: 'status' }>, kind: StatusKind): Effect {
  const status = { ...effect.status, kind };
  delete status.value;
  delete status.abilityId;
  const value = PERCENT_STATUS_KINDS.has(kind) ? 0.15 : AMOUNT_STATUS_KINDS.has(kind) ? 10 : undefined;
  return {
    ...effect,
    status: { ...status, ...(value === undefined ? {} : { value }) },
  };
}

function ConditionEditor({ condition, onChange }: { condition: Condition; onChange: (condition: Condition) => void }) {
  return (
    <div className="condition-editor">
      <label>IF
        <select value={condition.kind} onChange={(event) => onChange(defaultCondition(event.target.value as Condition['kind']))}>
          {CONDITION_KINDS.map((kind) => <option value={kind} key={kind}>{kind.replaceAll('-', ' ')}</option>)}
        </select>
      </label>
      {(condition.kind === 'target-hp-below' || condition.kind === 'self-hp-below') && (
        <label>PERCENT
          <input type="number" min="1" max="99" value={Math.round(condition.percent * 100)} onChange={(event) => onChange({ ...condition, percent: Number(event.target.value) / 100 })} />
        </label>
      )}
      {condition.kind === 'round-at-least' && <label>ROUND<input type="number" min="1" max="12" value={condition.round} onChange={(event) => onChange({ ...condition, round: Number(event.target.value) })} /></label>}
      {condition.kind === 'target-has-status' && (
        <label>STATUS<select value={condition.status} onChange={(event) => onChange({ ...condition, status: event.target.value as StatusKind })}>{STATUS_KINDS.map((kind) => <option key={kind}>{kind}</option>)}</select></label>
      )}
      {condition.kind === 'chance' && <label>CHANCE %<input type="number" min="0" max="100" value={Math.round(condition.probability * 100)} onChange={(event) => onChange({ ...condition, probability: Number(event.target.value) / 100 })} /></label>}
    </div>
  );
}

interface EffectEditorProps {
  effect: Effect;
  onChange: (effect: Effect) => void;
  onRemove: () => void;
  depth?: number;
}

export function EffectEditor({ effect, onChange, onRemove, depth = 0 }: EffectEditorProps) {
  const addNested = (branch: 'effects' | 'otherwise') => {
    if (effect.kind !== 'conditional') return;
    onChange({ ...effect, [branch]: [...(effect[branch] ?? []), defaultEffect('damage')] });
  };

  return (
    <div className={`effect-editor effect-editor--depth-${depth}`}>
      <div className="effect-editor__topline">
        <label>EFFECT
          <select value={effect.kind} onChange={(event) => onChange(defaultEffect(event.target.value as Effect['kind']))}>
            {EFFECT_KINDS.filter((kind) => depth < 2 || kind !== 'conditional').map((kind) => <option value={kind} key={kind}>{kind.replaceAll('-', ' ')}</option>)}
          </select>
        </label>
        {effect.kind !== 'self-damage' && (
          <label>RECIPIENT
            <select value={effect.recipient ?? 'target'} onChange={(event) => onChange(withOptional(effect, 'recipient', event.target.value === 'target' ? undefined : 'self'))}>
              <option value="target">TARGET</option><option value="self">SELF</option>
            </select>
          </label>
        )}
        <label>CHANCE %
          <input
            type="number"
            min="0"
            max="100"
            placeholder="100"
            value={effect.chance === undefined ? '' : Math.round(effect.chance * 100)}
            onChange={(event) => onChange(withOptional(effect, 'chance', event.target.value === '' ? undefined : Number(event.target.value) / 100))}
          />
        </label>
        <button type="button" className="effect-editor__remove" onClick={onRemove} aria-label="Remove effect">×</button>
      </div>

      {(effect.kind === 'damage' || effect.kind === 'heal' || effect.kind === 'shield' || effect.kind === 'self-damage') && (
        <div className="effect-editor__fields">
          <label>AMOUNT<input type="number" min="0" max="500" value={effect.amount} onChange={(event) => onChange({ ...effect, amount: Number(event.target.value) })} /></label>
          {effect.kind === 'damage' && (
            <>
              <label>MIN HITS<input type="number" min="1" max="20" value={effect.repeat?.min ?? 1} onChange={(event) => onChange({ ...effect, repeat: { min: Number(event.target.value), max: effect.repeat?.max ?? 1 } })} /></label>
              <label>MAX HITS<input type="number" min="1" max="20" value={effect.repeat?.max ?? 1} onChange={(event) => onChange({ ...effect, repeat: { min: effect.repeat?.min ?? 1, max: Number(event.target.value) } })} /></label>
            </>
          )}
        </div>
      )}

      {effect.kind === 'status' && (
        <div className="effect-editor__fields effect-editor__fields--status">
          <label>STATUS<select value={effect.status.kind} onChange={(event) => onChange(changeStatusKind(effect, event.target.value as StatusKind))}>{STATUS_KINDS.map((kind) => <option key={kind}>{kind}</option>)}</select></label>
          <label>DISPLAY LABEL<input dir="auto" maxLength={60} value={effect.status.label} onChange={(event) => onChange({ ...effect, status: { ...effect.status, label: event.target.value } })} /></label>
          <label>ROUNDS<input type="number" min="1" max="12" value={effect.status.duration} onChange={(event) => onChange({ ...effect, status: { ...effect.status, duration: Number(event.target.value) } })} /></label>
          {PERCENT_STATUS_KINDS.has(effect.status.kind) && (
            <label>VALUE %<input type="number" min="0" max="100" step="1" value={Math.round((effect.status.value ?? 0) * 100)} onChange={(event) => onChange({ ...effect, status: { ...effect.status, value: Number(event.target.value) / 100 } })} /></label>
          )}
          {AMOUNT_STATUS_KINDS.has(effect.status.kind) && (
            <label>AMOUNT<input type="number" min="0" max="500" step="1" value={effect.status.value ?? 0} onChange={(event) => onChange({ ...effect, status: { ...effect.status, value: Number(event.target.value) } })} /></label>
          )}
        </div>
      )}

      {effect.kind === 'disable' && <div className="effect-editor__fields"><label>ROUNDS<input type="number" min="1" max="12" value={effect.duration} onChange={(event) => onChange({ ...effect, duration: Number(event.target.value) })} /></label></div>}
      {(effect.kind === 'cleanse' || effect.kind === 'steal-status') && <div className="effect-editor__fields"><label>COUNT<input type="number" min="1" max="20" value={effect.count ?? 1} onChange={(event) => onChange({ ...effect, count: Number(event.target.value) })} /></label></div>}

      {effect.kind === 'conditional' && (
        <div className="conditional-branches">
          <ConditionEditor condition={effect.condition} onChange={(condition) => onChange({ ...effect, condition })} />
          {(['effects', 'otherwise'] as const).map((branch) => (
            <div className="conditional-branch" key={branch}>
              <strong>{branch === 'effects' ? 'THEN' : 'OTHERWISE'}</strong>
              {(effect[branch] ?? []).map((nested, index) => (
                <EffectEditor
                  key={`${branch}-${index}`}
                  effect={nested}
                  depth={depth + 1}
                  onChange={(updated) => onChange({ ...effect, [branch]: (effect[branch] ?? []).map((item, itemIndex) => itemIndex === index ? updated : item) })}
                  onRemove={() => onChange({ ...effect, [branch]: (effect[branch] ?? []).filter((_, itemIndex) => itemIndex !== index) })}
                />
              ))}
              {(effect[branch]?.length ?? 0) < 8 && <button type="button" className="mini-button" onClick={() => addNested(branch)}>+ ADD {branch === 'effects' ? 'THEN' : 'ELSE'} EFFECT</button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
