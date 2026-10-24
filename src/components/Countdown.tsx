import { useCountdown } from '../use-countdown.js';

interface CountdownProps {
  deadline: number | null;
  serverTime: number;
  label?: string;
  urgentAt?: number;
  duration?: number;
}

export function Countdown({ deadline, serverTime, label = 'LOCKS IN', urgentAt = 4_000, duration = 15_000 }: CountdownProps) {
  const remaining = useCountdown(deadline, serverTime);
  const seconds = Math.ceil(remaining / 1_000);
  const progress = deadline ? Math.min(1, Math.max(0, remaining / duration)) : 0;

  return (
    <div className={`countdown ${remaining <= urgentAt ? 'countdown--urgent' : ''}`} role="timer" aria-live="off" aria-label={`${label}: ${seconds} seconds`}>
      <div className="countdown__copy">
        <span>{label}</span>
        <strong>{seconds}</strong>
      </div>
      <div className="countdown__track" aria-hidden="true">
        <span style={{ transform: `scaleX(${progress})` }} />
      </div>
    </div>
  );
}
