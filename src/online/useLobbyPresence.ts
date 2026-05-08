// Canal de presència global per a jugadors online.
// Usa Supabase Realtime Presence: cada client publica la seua identitat i
// veu la resta de jugadors connectats. La neteja és automàtica en desconnectar.
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { salaForRoom } from "@/online/salaAssignment";

export interface OnlinePlayer {
  deviceId: string;
  name: string;
  /** Codi de la taula on està assegut, si n'hi ha. */
  roomCode: string | null;
  /** Slug de la sala a la qual pertany (derivat del roomCode o explícit). */
  salaSlug: string | null;
}

interface PresenceState {
  deviceId: string;
  name: string;
  roomCode: string | null;
  salaSlug: string | null;
  joinedAt: number;
}

const CHANNEL_NAME = "lobby:presence";

export function useLobbyPresence({
  deviceId,
  name,
  roomCode = null,
  salaSlug: salaSlugProp = null,
  enabled = true,
  /** Si es passa, filtra els jugadors que pertanyen a aquesta sala. */
  filterBySala,
}: {
  deviceId: string;
  name: string;
  roomCode?: string | null;
  salaSlug?: string | null;
  enabled?: boolean;
  filterBySala?: string | null;
}): OnlinePlayer[] {
  const [players, setPlayers] = useState<OnlinePlayer[]>([]);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const subscribedRef = useRef(false);

  // Derive salaSlug from roomCode if not explicitly provided
  const salaSlug = salaSlugProp ?? (roomCode ? salaForRoom({ code: roomCode }) : null);

  // Effect 1: manage channel lifecycle — only depends on deviceId + enabled
  useEffect(() => {
    if (!enabled || !deviceId || !name) {
      setPlayers([]);
      return;
    }
    let cancelled = false;
    let attempts = 0;
    let reconnectTimer: number | null = null;

    const teardown = () => {
      subscribedRef.current = false;
      if (channelRef.current) {
        try { supabase.removeChannel(channelRef.current); } catch { /* ignore */ }
        channelRef.current = null;
      }
    };

    const scheduleReconnect = (delayOverride?: number) => {
      if (cancelled) return;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      const delay = delayOverride ?? (() => {
        const exp = Math.min(15_000, 500 * 2 ** Math.min(attempts, 6));
        return Math.floor(Math.random() * exp);
      })();
      attempts++;
      reconnectTimer = window.setTimeout(() => {
        if (cancelled) return;
        teardown();
        connect();
      }, delay) as unknown as number;
    };

    const connect = () => {
      if (cancelled) return;
      const ch = supabase.channel(CHANNEL_NAME, {
        config: { presence: { key: deviceId } },
      });
      channelRef.current = ch;

      const syncPlayers = () => {
        const state = ch.presenceState<PresenceState>();
        const seen = new Map<string, OnlinePlayer>();
        for (const [key, metas] of Object.entries(state)) {
          const meta = metas[0];
          if (!meta || !meta.name) continue;
          seen.set(key, {
            deviceId: meta.deviceId ?? key,
            name: meta.name,
            roomCode: meta.roomCode ?? null,
            salaSlug: meta.salaSlug ?? null,
          });
        }
        setPlayers(Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name)));
      };

      ch.on("presence", { event: "sync" }, syncPlayers)
        .on("presence", { event: "join" }, syncPlayers)
        .on("presence", { event: "leave" }, syncPlayers)
        .subscribe(async (status) => {
          if (cancelled) return;
          if (status === "SUBSCRIBED") {
            attempts = 0;
            subscribedRef.current = true;
            try {
              await ch.track({
                deviceId,
                name,
                roomCode,
                salaSlug,
                joinedAt: Date.now(),
              } satisfies PresenceState);
            } catch {
              scheduleReconnect();
            }
          } else if (status === "CLOSED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            scheduleReconnect();
          }
        });
    };

    connect();

    const onWake = () => {
      if (cancelled) return;
      teardown();
      attempts = 0;
      if (reconnectTimer !== null) { window.clearTimeout(reconnectTimer); reconnectTimer = null; }
      connect();
    };
    const onOnline = () => onWake();
    const onVisible = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") onWake();
    };
    if (typeof window !== "undefined") {
      window.addEventListener("online", onOnline);
      document.addEventListener("visibilitychange", onVisible);
    }

    return () => {
      cancelled = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      teardown();
      if (typeof window !== "undefined") {
        window.removeEventListener("online", onOnline);
        document.removeEventListener("visibilitychange", onVisible);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, enabled]);

  // Effect 2: re-track when name, roomCode or salaSlug changes WITHOUT recreating the channel
  useEffect(() => {
    if (!enabled || !deviceId || !name) return;
    const ch = channelRef.current;
    if (!ch || !subscribedRef.current) return;

    ch.track({
      deviceId,
      name,
      roomCode,
      salaSlug,
      joinedAt: Date.now(),
    } satisfies PresenceState).catch(() => {
      // If track fails the reconnect logic in effect 1 will handle it
    });
  }, [deviceId, name, roomCode, salaSlug, enabled]);

  // Apply filterBySala client-side
  const filtered = useMemo(() => {
    if (!filterBySala) return players;
    return players.filter((p) => p.salaSlug === filterBySala);
  }, [players, filterBySala]);

  return filtered;
}
