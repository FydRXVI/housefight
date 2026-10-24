import { useEffect, useState } from 'react';

interface ClockState {
  key: string;
  remaining: number;
}

export function useCountdown(deadline: number | null, serverTime: number): number {
  const key = `${deadline ?? 'none'}:${serverTime}`;
  const baseline = deadline === null ? 0 : Math.max(0, deadline - serverTime);
  const [clock, setClock] = useState<ClockState>({ key, remaining: baseline });

  useEffect(() => {
    if (deadline === null) return undefined;
    const startedAt = performance.now();
    const timer = window.setInterval(() => {
      setClock({
        key,
        remaining: Math.max(0, deadline - serverTime - (performance.now() - startedAt)),
      });
    }, 100);
    return () => window.clearInterval(timer);
  }, [deadline, key, serverTime]);

  return clock.key === key ? clock.remaining : baseline;
}
