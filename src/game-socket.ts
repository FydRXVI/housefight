import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMessage, ClientSnapshot, ServerMessage } from '../shared/protocol.js';

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

export function useGameSocket(role: 'player' | 'arena') {
  const [state, setState] = useState<ClientSnapshot | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<number | null>(null);

  useEffect(() => {
    let stopped = false;
    let attempts = 0;

    const connect = () => {
      if (stopped) return;
      setStatus('connecting');
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const token = role === 'player' ? window.localStorage.getItem('house-fight-token') : null;
      const parameters = new URLSearchParams({ role });
      if (token) parameters.set('token', token);
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws?${parameters}`);
      socketRef.current = socket;

      socket.addEventListener('open', () => {
        attempts = 0;
        setStatus('open');
      });
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data)) as ServerMessage;
        if (message.type === 'welcome' && role === 'player') {
          window.localStorage.setItem('house-fight-token', message.token);
        }
        if (message.type === 'state') setState(message.state);
      });
      socket.addEventListener('close', () => {
        if (socketRef.current === socket) socketRef.current = null;
        setStatus('closed');
        if (!stopped) {
          attempts += 1;
          reconnectRef.current = window.setTimeout(connect, Math.min(5_000, 600 * 2 ** attempts));
        }
      });
    };

    connect();
    return () => {
      stopped = true;
      if (reconnectRef.current !== null) window.clearTimeout(reconnectRef.current);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [role]);

  const send = useCallback((message: ClientMessage) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(message));
    }
  }, []);

  return { state, status, send };
}
