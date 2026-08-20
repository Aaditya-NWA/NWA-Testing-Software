import { useEffect, useRef, useCallback, useState } from "react";
import { AcquisitionStats, SensorData } from "../types";
import { getAuthToken } from "./useApi";

const WS_URL = "ws://localhost:8000/ws";

function wsUrl(): string {
  const t = getAuthToken();
  return t ? `${WS_URL}?token=${encodeURIComponent(t)}` : WS_URL;
}

const HISTORY_SECONDS = 20;

const DISPLAY_HZ = 25;
const MAX_HISTORY = HISTORY_SECONDS * DISPLAY_HZ;

interface UseWebSocketReturn {
  data: SensorData | null;
  history: SensorData[];
  wsConnected: boolean;
  stats: AcquisitionStats | null;
}

interface BatchMessage {
  type?: string;
  samples?: SensorData[];
  stats?: AcquisitionStats;
}

export function useWebSocket(enabled: boolean): UseWebSocketReturn {
  const [data, setData] = useState<SensorData | null>(null);
  const [history, setHistory] = useState<SensorData[]>([]);
  const [wsConnected, setWsConnected] = useState(false);
  const [stats, setStats] = useState<AcquisitionStats | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // [NEW v10] Monotonic display key — see where it is attached below.
  const keySeq = useRef(0);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(wsUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      setWsConnected(true);
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };

    ws.onclose = () => {
      setWsConnected(false);
      if (enabled) {
        reconnectTimer.current = setTimeout(connect, 1500);
      }
    };

    ws.onerror = () => {
      ws.close();
    };

    ws.onmessage = (evt) => {
      try {
        const msg: BatchMessage | SensorData = JSON.parse(evt.data);

        const batch = msg as BatchMessage;
        const samples: SensorData[] =
          batch.type === "batch" && Array.isArray(batch.samples)
            ? batch.samples
            : [msg as SensorData];

        if (samples.length === 0) return;

        if (batch.stats) setStats(batch.stats);

        const latest = samples[samples.length - 1];

        latest.__k = keySeq.current++;
        setData(latest);

        setHistory((prev) => {
          const next = prev.length >= MAX_HISTORY
            ? prev.slice(prev.length - MAX_HISTORY + 1)
            : prev.slice();
          next.push(latest);
          return next;
        });
      } catch {
        // malformed frame — ignore
      }
    };
  }, [enabled]);

  useEffect(() => {
    if (enabled) {
      connect();
    } else {
      wsRef.current?.close();
      setWsConnected(false);
    }
    return () => {
      wsRef.current?.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
  }, [enabled, connect]);

  return { data, history, wsConnected, stats };
}
