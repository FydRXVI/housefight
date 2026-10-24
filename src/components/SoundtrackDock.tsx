import { useEffect, useRef, useState } from 'react';
import { SOUNDTRACKS, SoundtrackEngine, soundtrackDuration } from '../audio/soundtrack.js';

const TRACK_STORAGE_KEY = 'house-fight-soundtrack';
const VOLUME_STORAGE_KEY = 'house-fight-soundtrack-volume';

function storedTrack(): number {
  const value = Number(window.localStorage.getItem(TRACK_STORAGE_KEY));
  return Number.isInteger(value) && value >= 0 && value < SOUNDTRACKS.length ? value : 0;
}

function storedVolume(): number {
  const stored = window.localStorage.getItem(VOLUME_STORAGE_KEY);
  if (stored === null) return 0.3;
  const value = Number(stored);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0.32;
}

export function SoundtrackDock({ compact = false }: { compact?: boolean }) {
  const engine = useRef<SoundtrackEngine | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [trackIndex, setTrackIndex] = useState(storedTrack);
  const [volume, setVolume] = useState(storedVolume);
  const [error, setError] = useState('');
  const track = SOUNDTRACKS[trackIndex] as (typeof SOUNDTRACKS)[number];
  const duration = soundtrackDuration(track);
  const durationLabel = `${Math.floor(duration / 60)}:${String(Math.round(duration % 60)).padStart(2, '0')}`;

  useEffect(() => () => engine.current?.destroy(), []);
  const panelOpen = expanded && !compact;

  const togglePlayback = async () => {
    if (playing) {
      engine.current?.stop();
      setPlaying(false);
      return;
    }
    try {
      engine.current ??= new SoundtrackEngine();
      await engine.current.start(trackIndex, volume);
      setPlaying(true);
      setError('');
    } catch {
      setError('AUDIO IS NOT AVAILABLE IN THIS BROWSER');
    }
  };

  const changeTrack = (direction: -1 | 1) => {
    const next = (trackIndex + direction + SOUNDTRACKS.length) % SOUNDTRACKS.length;
    setTrackIndex(next);
    window.localStorage.setItem(TRACK_STORAGE_KEY, String(next));
    engine.current?.setTrack(next);
  };

  const changeVolume = (next: number) => {
    setVolume(next);
    window.localStorage.setItem(VOLUME_STORAGE_KEY, String(next));
    engine.current?.setVolume(next);
  };

  return (
    <aside className={`soundtrack-dock ${panelOpen ? 'is-expanded' : ''}`} aria-label="Original game soundtrack">
      <button className="soundtrack-dock__tab" type="button" aria-expanded={panelOpen} onClick={() => setExpanded((value) => compact ? false : !value)}>
        <span aria-hidden="true">♫</span><span className="visually-hidden">{panelOpen ? 'Close music controls' : 'Open music controls'}</span>
      </button>
      {panelOpen && (
        <div className="soundtrack-dock__panel">
          <div><small>ORIGINAL CHIPTUNE · {trackIndex + 1}/{SOUNDTRACKS.length} · {durationLabel} LOOP</small><strong>{track.name}</strong><span>{track.subtitle}</span></div>
          <div className="soundtrack-dock__buttons">
            <button type="button" aria-pressed={playing} onClick={() => { void togglePlayback(); }}>{playing ? '■ STOP' : '▶ PLAY'}</button>
            <button type="button" aria-label="Previous soundtrack" onClick={() => changeTrack(-1)}>‹ PREV</button>
            <button type="button" aria-label="Next soundtrack" onClick={() => changeTrack(1)}>NEXT ›</button>
          </div>
          <label>VOLUME <input aria-label="Music volume" type="range" min="0" max="1" step="0.05" value={volume} onChange={(event) => changeVolume(Number(event.target.value))} /></label>
          {error && <em role="alert">{error}</em>}
        </div>
      )}
    </aside>
  );
}
