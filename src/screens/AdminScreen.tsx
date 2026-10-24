import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { AbilityDefinition, CardDefinition } from '../../engine/types.js';
import type { FighterStat } from '../../server/storage.js';
import { Brand } from '../components/Brand.js';
import { defaultEffect, EffectEditor } from '../components/EffectEditor.js';
import { FighterCard } from '../components/FighterCard.js';

interface BalanceEstimate {
  hp: number;
  attack: number;
  defence: number;
  utility: number;
  reliability: number;
  total: number;
}

interface SimulationReport {
  cardId: string;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  winRate: number;
  averageRounds: number;
  matchups: Array<{
    opponentId: string;
    opponentName: string;
    games: number;
    wins: number;
    draws: number;
    losses: number;
    equityRate: number;
    averageRounds: number;
  }>;
}

interface Diagnostics {
  database: string;
  cards: number;
  enabledCards: number;
  standardCards: number;
  enabledStandardCards: number;
  media: number;
  missingMedia: string[];
  checkpoint: boolean;
}

const MAX_PORTRAIT_UPLOAD_BYTES = 12 * 1024 * 1024;

function uniqueSlug(name: string, cards: CardDefinition[]): string {
  const root = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'fighter';
  let candidate = root;
  let suffix = 2;
  while (cards.some((card) => card.id === candidate)) {
    candidate = `${root.slice(0, 36)}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function cloneAsNew(source: CardDefinition, cards: CardDefinition[], blank = false): CardDefinition {
  const id = uniqueSlug(blank ? 'new-fighter' : `${source.name}-copy`, cards);
  return {
    ...structuredClone(source),
    id,
    enabled: true,
    name: blank ? 'New Fighter' : `${source.name} Copy`,
    title: blank ? 'Custom Contender' : source.title,
    quote: blank ? 'Put the family lore here.' : source.quote,
    portrait: blank ? undefined : source.portrait,
    avatarSeed: Math.floor(Math.random() * 2_147_483_647),
    abilities: source.abilities.map((ability, index) => ({
      ...ability,
      id: `${id}-${index + 1}`,
      name: blank ? ['Say What?', 'Not Today', 'Family Business', 'The Signature'][index] ?? ability.name : ability.name,
    })),
  };
}

export function AdminScreen() {
  const [adminKey, setAdminKey] = useState(() => window.sessionStorage.getItem('house-fight-admin-key') ?? '');
  const [cards, setCards] = useState<CardDefinition[]>([]);
  const [editing, setEditing] = useState<CardDefinition | null>(null);
  const [stats, setStats] = useState<FighterStat[]>([]);
  const [estimate, setEstimate] = useState<BalanceEstimate | null>(null);
  const [simulation, setSimulation] = useState<SimulationReport | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [status, setStatus] = useState('LOADING LOCAL CARD VAULT…');
  const [needsKey, setNeedsKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge');
  const [cardSearch, setCardSearch] = useState('');
  const [poolFilter, setPoolFilter] = useState<'all' | CardDefinition['rarity']>('all');
  const [availabilityFilter, setAvailabilityFilter] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [activeAbilityIndex, setActiveAbilityIndex] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const importRef = useRef<HTMLInputElement>(null);
  const photoRef = useRef<HTMLInputElement>(null);

  const authHeaders = useMemo<Record<string, string>>(
    () => {
      const headers: Record<string, string> = {};
      if (adminKey) headers['X-Admin-Key'] = adminKey;
      return headers;
    },
    [adminKey],
  );
  const jsonHeaders = useMemo<Record<string, string>>(
    () => ({ 'Content-Type': 'application/json', ...authHeaders }),
    [authHeaders],
  );
  const storedCard = editing ? cards.find((card) => card.id === editing.id) : undefined;
  const dirty = Boolean(editing && JSON.stringify(editing) !== JSON.stringify(storedCard));
  const activeAbility = editing?.abilities[activeAbilityIndex] ?? editing?.abilities[0];
  const filteredCards = useMemo(() => {
    const query = cardSearch.normalize('NFC').trim().toLocaleLowerCase();
    return cards.filter((card) => {
      if (poolFilter !== 'all' && card.rarity !== poolFilter) return false;
      if (availabilityFilter === 'enabled' && card.enabled === false) return false;
      if (availabilityFilter === 'disabled' && card.enabled !== false) return false;
      if (!query) return true;
      return [card.name, card.title, card.archetype, card.id]
        .some((value) => value.toLocaleLowerCase().includes(query));
    });
  }, [availabilityFilter, cardSearch, cards, poolFilter]);

  const loadData = useCallback(async (preferredId?: string) => {
    try {
      const [cardsResponse, statsResponse] = await Promise.all([
        fetch('/api/admin/cards', { headers: authHeaders }),
        fetch('/api/admin/stats', { headers: authHeaders }),
      ]);
      if (cardsResponse.status === 403) {
        setNeedsKey(true);
        setStatus('ADMIN KEY REQUIRED OFF THE HOST MACHINE');
        return;
      }
      if (!cardsResponse.ok || !statsResponse.ok) throw new Error('Admin API is unavailable.');
      const cardPayload = await cardsResponse.json() as { cards: CardDefinition[] };
      const statPayload = await statsResponse.json() as { stats: FighterStat[] };
      setCards(cardPayload.cards);
      setStats(statPayload.stats);
      setEditing((current) => structuredClone(cardPayload.cards.find((card) => card.id === (preferredId ?? current?.id)) ?? cardPayload.cards[0] ?? null));
      setNeedsKey(false);
      setStatus('LOCAL VAULT READY / UTF-8 / NO CLOUD');
    } catch (error) {
      setStatus(error instanceof Error ? error.message.toUpperCase() : 'FAILED TO LOAD');
    }
  }, [authHeaders]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => { void loadData(); }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [loadData, reloadKey]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const selectCard = (card: CardDefinition) => {
    if (dirty && !window.confirm('Discard the unsaved changes to this card?')) return;
    setEditing(structuredClone(card));
    setEstimate(null);
    setSimulation(null);
    setActiveAbilityIndex(0);
    if (window.matchMedia('(max-width: 799px)').matches) {
      window.requestAnimationFrame(() => document.getElementById('card-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }
  };

  const navigateAbilityTabs = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const abilityCount = editing?.abilities.length ?? 0;
    if (abilityCount === 0) return;
    let nextIndex: number;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (index + 1) % abilityCount;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (index - 1 + abilityCount) % abilityCount;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = abilityCount - 1;
    else return;
    event.preventDefault();
    setActiveAbilityIndex(nextIndex);
    const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    tabs?.[nextIndex]?.focus();
  };

  const updateAbility = (index: number, update: (ability: AbilityDefinition) => AbilityDefinition) => {
    setEditing((current) => current ? {
      ...current,
      abilities: current.abilities.map((ability, abilityIndex) => abilityIndex === index ? update(ability) : ability),
    } : current);
  };

  const resetCard = () => {
    if (!storedCard) return;
    setEditing(structuredClone(storedCard));
    setEstimate(null);
    setSimulation(null);
    setStatus('UNSAVED CHANGES DISCARDED');
  };

  const saveCard = async (card = editing): Promise<CardDefinition | null> => {
    if (!card) return null;
    setBusy(true);
    setStatus('VALIDATING & SAVING TO LOCAL VAULT…');
    try {
      const response = await fetch(`/api/admin/cards/${encodeURIComponent(card.id)}`, {
        method: 'PUT', headers: jsonHeaders, body: JSON.stringify(card),
      });
      const payload = await response.json() as { card?: CardDefinition; estimate?: BalanceEstimate; error?: string; errors?: string[] };
      if (!response.ok || !payload.card) throw new Error(payload.errors?.join(' ') ?? payload.error ?? 'Save failed.');
      setCards((current) => [...current.filter((item) => item.id !== payload.card?.id), payload.card as CardDefinition].sort((a, b) => a.name.localeCompare(b.name)));
      setEditing(structuredClone(payload.card));
      setEstimate(payload.estimate ?? null);
      setStatus('SAVED / AVAILABLE NEXT MATCH');
      return payload.card;
    } catch (error) {
      setStatus(error instanceof Error ? error.message.toUpperCase() : 'SAVE FAILED');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const createCard = (blank: boolean) => {
    const source = editing ?? cards[0];
    if (!source) return;
    if (dirty && !window.confirm('Discard the unsaved changes first?')) return;
    setEditing(cloneAsNew(source, cards, blank));
    setEstimate(null);
    setSimulation(null);
    setActiveAbilityIndex(0);
    setStatus(blank ? 'NEW CARD — SAVE BEFORE ADDING A PHOTO' : 'DUPLICATE READY — REVIEW AND SAVE');
  };

  const deleteCard = async () => {
    if (!editing || !storedCard || !window.confirm(`Delete ${editing.name}? Export a backup first if this is irreplaceable.`)) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/cards/${encodeURIComponent(editing.id)}`, { method: 'DELETE', headers: authHeaders });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? 'Delete failed.');
      setStatus('CARD DELETED');
      setEditing(null);
      await loadData();
    } catch (error) {
      setStatus(error instanceof Error ? error.message.toUpperCase() : 'DELETE FAILED');
    } finally {
      setBusy(false);
    }
  };

  const uploadPhoto = async (file: File) => {
    if (file.size > MAX_PORTRAIT_UPLOAD_BYTES) {
      setStatus('PHOTO IS TOO LARGE — CHOOSE A FILE UNDER 12 MB');
      if (photoRef.current) photoRef.current.value = '';
      return;
    }
    let card = editing;
    if (!card) return;
    if (!storedCard || dirty) card = await saveCard(card);
    if (!card) return;
    setBusy(true);
    setStatus('NORMALIZING PHOTO / STRIPPING METADATA…');
    try {
      const response = await fetch(`/api/admin/cards/${encodeURIComponent(card.id)}/portrait`, {
        method: 'POST', headers: { ...authHeaders, 'Content-Type': file.type || 'application/octet-stream' }, body: file,
      });
      const payload = await response.json() as { card?: CardDefinition; error?: string };
      if (!response.ok || !payload.card) throw new Error(payload.error ?? 'Photo upload failed.');
      setEditing(structuredClone(payload.card));
      setCards((current) => current.map((item) => item.id === payload.card?.id ? payload.card as CardDefinition : item));
      setStatus('PHOTO READY / ORIENTATION FIXED / METADATA REMOVED');
    } catch (error) {
      setStatus(error instanceof Error ? error.message.toUpperCase() : 'PHOTO UPLOAD FAILED');
    } finally {
      setBusy(false);
      if (photoRef.current) photoRef.current.value = '';
    }
  };

  const removePhoto = async () => {
    let card = editing;
    if (!card?.portrait) return;
    if (dirty) card = await saveCard(card);
    if (!card?.portrait) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/cards/${encodeURIComponent(card.id)}/portrait`, { method: 'DELETE', headers: authHeaders });
      const payload = await response.json() as { card?: CardDefinition; error?: string };
      if (!response.ok || !payload.card) throw new Error(payload.error ?? 'Could not remove photo.');
      setEditing(structuredClone(payload.card));
      setCards((current) => current.map((item) => item.id === payload.card?.id ? payload.card as CardDefinition : item));
      setStatus('PHOTO REMOVED / ILLUSTRATED FALLBACK ACTIVE');
    } catch (error) {
      setStatus(error instanceof Error ? error.message.toUpperCase() : 'PHOTO REMOVE FAILED');
    } finally {
      setBusy(false);
    }
  };

  const runSimulation = async () => {
    if (!editing) return;
    setBusy(true);
    setStatus('TESTING THIS CARD AGAINST EVERY STANDARD FIGHTER IN BOTH SEATS…');
    try {
      const response = await fetch('/api/admin/simulate?games=300', {
        method: 'POST', headers: jsonHeaders, body: JSON.stringify(editing),
      });
      const payload = await response.json() as { estimate?: BalanceEstimate; simulation?: SimulationReport; error?: string; errors?: string[] };
      if (!response.ok || !payload.simulation) throw new Error(payload.errors?.join(' ') ?? payload.error ?? 'Simulation failed.');
      setEstimate(payload.estimate ?? null);
      setSimulation(payload.simulation);
      setStatus('SIMULATION COMPLETE');
    } catch (error) {
      setStatus(error instanceof Error ? error.message.toUpperCase() : 'SIMULATION FAILED');
    } finally {
      setBusy(false);
    }
  };

  const exportVault = async () => {
    setBusy(true);
    setStatus('BUILDING PORTABLE BACKUP…');
    try {
      const response = await fetch('/api/admin/export', { headers: authHeaders });
      if (!response.ok) throw new Error((await response.json() as { error?: string }).error ?? 'Export failed.');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] ?? 'house-fight-backup.housefight';
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 2_000);
      setStatus('BACKUP DOWNLOADED — KEEP IT SOMEWHERE SAFE');
    } catch (error) {
      setStatus(error instanceof Error ? error.message.toUpperCase() : 'EXPORT FAILED');
    } finally {
      setBusy(false);
    }
  };

  const importVault = async (file: File) => {
    if (dirty && !window.confirm('Importing reloads the vault. Discard the unsaved card changes and continue?')) {
      if (importRef.current) importRef.current.value = '';
      return;
    }
    if (importMode === 'replace' && !window.confirm('Replace the current vault with this backup? An automatic recovery copy will be created first.')) {
      if (importRef.current) importRef.current.value = '';
      return;
    }
    setBusy(true);
    setStatus(importMode === 'replace' ? 'VERIFYING & REPLACING VAULT…' : 'VERIFYING & MERGING BACKUP…');
    try {
      const response = await fetch(`/api/admin/import?mode=${importMode}`, {
        method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: file,
      });
      const payload = await response.json() as { imported?: { cards: number; media: number; matches: number }; recoveryPath?: string; error?: string };
      if (!response.ok || !payload.imported) throw new Error(payload.error ?? 'Import failed.');
      setStatus(`IMPORT COMPLETE / ${payload.imported.cards} CARDS / ${payload.imported.media} PHOTOS / RECOVERY SNAPSHOT SAVED`);
      await loadData();
    } catch (error) {
      setStatus(error instanceof Error ? error.message.toUpperCase() : 'IMPORT FAILED');
    } finally {
      setBusy(false);
      if (importRef.current) importRef.current.value = '';
    }
  };

  const runDiagnostics = async () => {
    setBusy(true);
    try {
      const response = await fetch('/api/admin/diagnostics', { headers: authHeaders });
      const payload = await response.json() as Diagnostics & { error?: string };
      if (response.status !== 200 && response.status !== 503) throw new Error(payload.error ?? 'Diagnostics failed.');
      if (!Array.isArray(payload.missingMedia) || typeof payload.database !== 'string') throw new Error('Diagnostics returned an invalid response.');
      setDiagnostics(payload);
      setStatus(payload.database === 'ok' && payload.missingMedia.length === 0 ? 'VAULT HEALTHY / READY TO PLAY' : 'VAULT NEEDS ATTENTION');
    } catch (error) {
      setStatus(error instanceof Error ? error.message.toUpperCase() : 'DIAGNOSTICS FAILED');
    } finally {
      setBusy(false);
    }
  };

  if (needsKey && cards.length === 0) {
    return (
      <main className="admin-key-screen">
        <Brand />
        <h1>HOST ACCESS ONLY</h1>
        <p>Open this page on the host Mac, or enter the <code>ADMIN_KEY</code> configured on the server.</p>
        <input className="text-input" type="password" value={adminKey} onChange={(event) => setAdminKey(event.target.value)} placeholder="ADMIN KEY" />
        <button type="button" className="primary-button" onClick={() => { window.sessionStorage.setItem('house-fight-admin-key', adminKey); setReloadKey((value) => value + 1); }}>UNLOCK VAULT</button>
        <a className="text-link" href="/">← BACK TO THE FIGHT</a>
      </main>
    );
  }

  return (
    <main className="admin-screen" aria-busy={busy}>
      <a className="admin-skip-link" href="#card-editor">SKIP TO CARD EDITOR</a>
      <header className="admin-header">
        <Brand compact />
        <div><span>PRIVATE CARD VAULT</span><strong role="status" aria-live="polite">{busy ? 'WORKING…' : status}</strong></div>
        <a href="/">← GAME</a>
      </header>

      <section className="vault-toolbar" aria-label="Vault tools">
        <div className="vault-toolbar__group">
          <button type="button" onClick={() => createCard(true)} disabled={busy}>+ NEW</button>
          <button type="button" onClick={() => createCard(false)} disabled={!editing || busy}>DUPLICATE</button>
          <button type="button" onClick={() => { void deleteCard(); }} disabled={!storedCard || busy}>DELETE</button>
        </div>
        <details className="vault-recovery-menu">
          <summary>BACKUP &amp; HEALTH</summary>
          <div className="vault-toolbar__group vault-toolbar__group--recovery">
            <button type="button" onClick={() => { void exportVault(); }} disabled={busy}>EXPORT BACKUP</button>
            <label><span>IMPORT MODE</span><select value={importMode} onChange={(event) => setImportMode(event.target.value as 'merge' | 'replace')} aria-label="Import mode"><option value="merge">MERGE</option><option value="replace">REPLACE</option></select></label>
            <button type="button" onClick={() => importRef.current?.click()} disabled={busy}>IMPORT…</button>
            <input ref={importRef} hidden type="file" accept=".housefight,.json,application/json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importVault(file); }} />
            <button type="button" onClick={() => { void runDiagnostics(); }} disabled={busy}>RUN HEALTH CHECK</button>
          </div>
        </details>
        {dirty && <span className="dirty-indicator">● UNSAVED CHANGES</span>}
      </section>

      {diagnostics && (
        <section className={`diagnostic-strip ${diagnostics.database === 'ok' && diagnostics.missingMedia.length === 0 ? 'is-good' : 'is-warning'}`}>
          <strong>DATABASE {diagnostics.database.toUpperCase()}</strong>
          <span>{diagnostics.enabledCards}/{diagnostics.cards} enabled · {diagnostics.enabledStandardCards}/{diagnostics.standardCards} Standard enabled · {diagnostics.media} photos · {diagnostics.checkpoint ? 'recovery checkpoint ready' : 'fresh room'}</span>
          {diagnostics.missingMedia.length > 0 && <span>{diagnostics.missingMedia.length} missing photo files</span>}
        </section>
      )}

      <div className="admin-layout">
        <aside className="card-library">
          <div className="panel-heading"><div><span className="section-kicker"><span>01</span> ROSTER</span><h1>FIGHTERS</h1></div><span>{filteredCards.length}/{cards.length}</span></div>
          <div className="card-library__filters">
            <label><span>SEARCH CARDS</span><input type="search" value={cardSearch} onChange={(event) => setCardSearch(event.target.value)} placeholder="Name, title, archetype…" /></label>
            <div>
              <label><span>POOL</span><select value={poolFilter} onChange={(event) => setPoolFilter(event.target.value as typeof poolFilter)}><option value="all">ALL</option><option value="standard">STANDARD</option><option value="boss">BOSS</option><option value="cursed">CURSED</option></select></label>
              <label><span>STATUS</span><select value={availabilityFilter} onChange={(event) => setAvailabilityFilter(event.target.value as typeof availabilityFilter)}><option value="all">ALL</option><option value="enabled">ENABLED</option><option value="disabled">DISABLED</option></select></label>
            </div>
          </div>
          <div className="card-library__list">
            {filteredCards.map((card) => (
              <button type="button" key={card.id} aria-pressed={editing?.id === card.id} className={`${editing?.id === card.id ? 'is-active' : ''}${card.enabled === false ? ' is-disabled' : ''}`} onClick={() => selectCard(card)}>
                <i style={{ background: card.accent }} />
                <div><strong dir="auto">{card.name}</strong><small dir="auto">{card.title}</small><em>{card.rarity}</em></div>
                <span>{card.enabled === false ? 'OFF' : `${card.hp} HP`}</span>
              </button>
            ))}
            {filteredCards.length === 0 && <p className="card-library__empty">NO CARDS MATCH THESE FILTERS.</p>}
          </div>
        </aside>

        {editing && (
          <>
            <form id="card-editor" className="card-editor" onSubmit={(event) => { event.preventDefault(); void saveCard(); }}>
              <div className="editor-heading"><div><span className="section-kicker"><span>02</span> CARD WORKSHOP</span><h1 dir="auto">EDIT {editing.name}</h1><small>ID: {editing.id}</small></div><div className="editor-heading__badges"><span className={`rarity-pill rarity-pill--${editing.rarity}`}>{editing.rarity}</span><span className={`availability-pill ${editing.enabled === false ? 'is-off' : ''}`}>{editing.enabled === false ? 'DRAFTS OFF' : 'DRAFTS ON'}</span></div></div>

              <nav className="editor-jumpbar" aria-label="Card editor sections">
                <a href="#portrait-section">PORTRAIT</a><a href="#identity-section">IDENTITY</a><a href="#abilities-section">ABILITIES</a><a href="#balance-section">BALANCE</a>
              </nav>

              <section id="portrait-section" className="photo-workshop editor-section">
                <div><strong>PORTRAIT PHOTO</strong><small>JPEG, PNG, WebP, or AVIF · max 12 MB · metadata removed · resized privately</small></div>
                <div className="photo-workshop__actions">
                  <button type="button" className="secondary-button" disabled={busy} onClick={() => photoRef.current?.click()}>{editing.portrait ? 'REPLACE PHOTO' : 'UPLOAD PHOTO'}</button>
                  {editing.portrait && <button type="button" className="mini-button" disabled={busy} onClick={() => { void removePhoto(); }}>REMOVE</button>}
                  <input ref={photoRef} hidden type="file" accept="image/jpeg,image/png,image/webp,image/avif,.avif" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadPhoto(file); }} />
                </div>
                {editing.portrait && (
                  <div className="photo-focus-controls">
                    <label>HORIZONTAL FOCUS <input type="range" min="0" max="100" value={editing.portrait.focalX} onChange={(event) => setEditing({ ...editing, portrait: { ...editing.portrait!, focalX: Number(event.target.value) } })} /></label>
                    <label>VERTICAL FOCUS <input type="range" min="0" max="100" value={editing.portrait.focalY} onChange={(event) => setEditing({ ...editing, portrait: { ...editing.portrait!, focalY: Number(event.target.value) } })} /></label>
                  </div>
                )}
              </section>

              <section id="identity-section" className="editor-section">
                <div className="editor-section__heading"><div><span>01</span><h2>IDENTITY &amp; DRAFT RULES</h2></div><p>Everything players read before and during a fight.</p></div>
              <div className="editor-fields editor-fields--two">
                <label>NAME <span>{editing.name.length}/60</span><input required dir="auto" value={editing.name} maxLength={60} onChange={(event) => setEditing({ ...editing, name: event.target.value })} /></label>
                <label>TITLE <span>{editing.title.length}/100</span><input required dir="auto" value={editing.title} maxLength={100} onChange={(event) => setEditing({ ...editing, title: event.target.value })} /></label>
                <label className="editor-fields__wide">QUOTE <span>{editing.quote.length}/280</span><textarea dir="auto" value={editing.quote} maxLength={280} onChange={(event) => setEditing({ ...editing, quote: event.target.value })} /></label>
                <label>ARCHETYPE <span>{editing.archetype.length}/60</span><input required dir="auto" value={editing.archetype} maxLength={60} onChange={(event) => setEditing({ ...editing, archetype: event.target.value })} /></label>
                <label>HP <span>40–250</span><input required type="number" min="40" max="250" value={editing.hp} onChange={(event) => setEditing({ ...editing, hp: Number(event.target.value) })} /></label>
                <label>POOL<select value={editing.rarity} onChange={(event) => setEditing({ ...editing, rarity: event.target.value as CardDefinition['rarity'] })}><option value="standard">STANDARD</option><option value="boss">BOSS</option><option value="cursed">CURSED</option></select></label>
                <label className="editor-check editor-fields__wide"><input type="checkbox" checked={editing.enabled !== false} onChange={(event) => setEditing({ ...editing, enabled: event.target.checked })} /> ENABLED IN DRAFTS <small>Disabled cards stay in this vault and in backups.</small></label>
                <label>PRIMARY COLOR<input type="color" value={editing.accent} onChange={(event) => setEditing({ ...editing, accent: event.target.value })} /></label>
                <label>SECONDARY COLOR<input type="color" value={editing.accentAlt} onChange={(event) => setEditing({ ...editing, accentAlt: event.target.value })} /></label>
              </div>
              </section>

              <section id="abilities-section" className="editor-section editor-section--abilities">
                <div className="editor-section__heading"><div><span>02</span><h2>ABILITIES</h2></div><p>Edit one move at a time. Effects remain structured and safe—no custom code.</p></div>
                <div className="ability-tabs" role="tablist" aria-label="Choose an ability to edit">
                  {editing.abilities.map((ability, index) => (
                    <button
                      type="button"
                      role="tab"
                      id={`ability-tab-${index}`}
                      aria-selected={activeAbilityIndex === index}
                      aria-controls="active-ability-panel"
                      tabIndex={activeAbilityIndex === index ? 0 : -1}
                      key={ability.id}
                      className={activeAbilityIndex === index ? 'is-active' : ''}
                      onClick={() => setActiveAbilityIndex(index)}
                      onKeyDown={(event) => navigateAbilityTabs(event, index)}
                    ><span>0{index + 1}</span><strong dir="auto">{ability.name}</strong><small>{ability.effects.length} EFFECT{ability.effects.length === 1 ? '' : 'S'}</small></button>
                  ))}
                </div>
                {activeAbility && (
                  <article id="active-ability-panel" className="ability-editor__panel" role="tabpanel" aria-labelledby={`ability-tab-${activeAbilityIndex}`}>
                    <div className="editor-fields editor-fields--ability">
                      <label>DISPLAY NAME <span>{activeAbility.name.length}/70</span><input required dir="auto" maxLength={70} value={activeAbility.name} onChange={(event) => updateAbility(activeAbilityIndex, (current) => ({ ...current, name: event.target.value }))} /></label>
                      <label>DESCRIPTION <span>{activeAbility.description.length}/260</span><textarea required dir="auto" maxLength={260} value={activeAbility.description} onChange={(event) => updateAbility(activeAbilityIndex, (current) => ({ ...current, description: event.target.value }))} /></label>
                      <label>TARGET<select value={activeAbility.target} onChange={(event) => updateAbility(activeAbilityIndex, (current) => ({ ...current, target: event.target.value as AbilityDefinition['target'] }))}><option value="enemy">ENEMY</option><option value="ally">FRIENDLY / SELF</option><option value="self">SELF</option><option value="all-enemies">ALL ENEMIES</option><option value="random-enemy">RANDOM ENEMY</option></select></label>
                      <label>PRIORITY<select value={activeAbility.priority} onChange={(event) => updateAbility(activeAbilityIndex, (current) => ({ ...current, priority: Number(event.target.value) as AbilityDefinition['priority'] }))}><option value="0">0 / PROTECT</option><option value="1">1 / FAST</option><option value="2">2 / STANDARD</option><option value="3">3 / SLOW</option></select></label>
                      <label>COOLDOWN <span>ROUNDS AFTER USE</span><input type="number" min="0" max="6" value={activeAbility.cooldown} onChange={(event) => updateAbility(activeAbilityIndex, (current) => ({ ...current, cooldown: Number(event.target.value) }))} /></label>
                      <label>UNLOCK ROUND<input type="number" min="1" max="12" value={activeAbility.availableFromRound ?? 1} onChange={(event) => updateAbility(activeAbilityIndex, (current) => ({ ...current, availableFromRound: Number(event.target.value) }))} /></label>
                      <label className="editor-check"><input type="checkbox" checked={activeAbility.oncePerMatch ?? false} onChange={(event) => updateAbility(activeAbilityIndex, (current) => ({ ...current, oncePerMatch: event.target.checked }))} /> ONCE PER MATCH</label>
                      <div className="effect-stack" aria-label={`${activeAbility.name} effects`}>
                        <div className="effect-stack__heading"><strong>EFFECTS</strong><span>Applied from top to bottom</span></div>
                        {activeAbility.effects.map((effect, effectIndex) => (
                          <EffectEditor
                            key={`${activeAbility.id}-${effectIndex}`}
                            effect={effect}
                            onChange={(updated) => updateAbility(activeAbilityIndex, (current) => ({ ...current, effects: current.effects.map((item, itemIndex) => itemIndex === effectIndex ? updated : item) }))}
                            onRemove={() => updateAbility(activeAbilityIndex, (current) => ({ ...current, effects: current.effects.filter((_, itemIndex) => itemIndex !== effectIndex) }))}
                          />
                        ))}
                        {activeAbility.effects.length < 8 && <button type="button" className="mini-button" onClick={() => updateAbility(activeAbilityIndex, (current) => ({ ...current, effects: [...current.effects, defaultEffect('damage')] }))}>+ ADD EFFECT</button>}
                      </div>
                    </div>
                  </article>
                )}
              </section>
              <div className="editor-actions">
                <div><strong>{dirty ? 'UNSAVED CHANGES' : 'ALL CHANGES SAVED'}</strong><span>{dirty ? 'Review the preview, then save.' : 'This card is safe in the local vault.'}</span></div>
                <button type="button" className="mini-button" disabled={!storedCard || !dirty || busy} onClick={resetCard}>RESET</button>
                <button type="button" className="secondary-button" disabled={busy} onClick={() => { void runSimulation(); }}>RUN 300 FIGHTS</button>
                <button type="submit" className="primary-button" disabled={busy || !dirty}>{busy ? 'WORKING…' : dirty ? 'SAVE CARD' : 'SAVED ✓'}</button>
              </div>
            </form>

            <aside id="balance-section" className="admin-preview" aria-label="Live card preview and balance">
              <details className="admin-preview__details" open={previewOpen} onToggle={(event) => setPreviewOpen(event.currentTarget.open)}>
                <summary><span className="section-kicker"><span>03</span> LIVE PREVIEW &amp; BALANCE</span><b>TOGGLE</b></summary>
                <div className="admin-preview__content">
              <FighterCard card={editing} showAbilities />
              <div className="balance-card">
                <div><span>BALANCE READ</span><strong>{estimate?.total.toFixed(1) ?? '—'}</strong></div>
                {estimate && <dl><dt>HP</dt><dd>{estimate.hp}</dd><dt>ATTACK</dt><dd>{estimate.attack}</dd><dt>DEFENCE</dt><dd>{estimate.defence}</dd><dt>UTILITY</dt><dd>{estimate.utility}</dd><dt>RELIABILITY</dt><dd>{estimate.reliability}</dd></dl>}
                {simulation && (
                  <div className="simulation-result">
                    <span>{simulation.games} BOT FIGHTS · {simulation.matchups.length} STANDARD MATCHUPS</span>
                    <strong>{(simulation.winRate * 100).toFixed(1)}% FAIR EQUITY</strong>
                    <small>{simulation.wins} wins · {simulation.draws} draws · {simulation.losses} losses · {simulation.averageRounds.toFixed(1)} average rounds</small>
                    <details>
                      <summary>SHOW EVERY MATCHUP</summary>
                      <div className="simulation-matchups">
                        {[...simulation.matchups].sort((left, right) => left.equityRate - right.equityRate).map((matchup) => (
                          <div key={matchup.opponentId}><span dir="auto">{matchup.opponentName}</span><strong>{(matchup.equityRate * 100).toFixed(0)}%</strong></div>
                        ))}
                      </div>
                    </details>
                  </div>
                )}
              </div>
              <div className="actual-stats"><span>HUMAN MATCHES</span>{stats.filter((stat) => stat.fighterId === editing.id).map((stat) => <strong key={stat.fighterId}>{stat.matches} played · {(stat.winRate * 100).toFixed(0)}% wins</strong>)}{!stats.some((stat) => stat.fighterId === editing.id) && <small>NO DATA YET</small>}</div>
                </div>
              </details>
            </aside>
          </>
        )}
      </div>
    </main>
  );
}
