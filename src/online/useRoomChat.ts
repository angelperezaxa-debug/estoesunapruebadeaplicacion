import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { reportChannel, clearChannel } from "./diagnostics";
import { backoffDelay } from "./realtimeReconnect";
import type { ChatMessage, ChatPhraseId } from "@/game/phrases";
import { playerTotalEnvit } from "@/game/deck";
import type { MatchState, PlayerId } from "@/game/types";

const VISIBLE_MS = 4500;
const MIN_VISIBLE_GAP_MS = 1000;

interface ChatRow {
  id: number;
  room_id: string;
  seat: number;
  phrase_id: string;
  created_at: string;
}

/** Subscriu-se als missatges de xat d'una sala i els converteix en
 *  ChatMessage[] perquè <TrucBoard> els puga pintar com a globus. */
export function useRoomChat(roomId: string | null, state: MatchState | null = null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const seenRowsRef = useRef<Set<number>>(new Set());
  const [resetSignal, setResetSignal] = useState(0);
  const stateRef = useRef<MatchState | null>(state);
  stateRef.current = state;

  const reset = useCallback(() => {
    seenRowsRef.current.clear();
    setMessages([]);
    setResetSignal((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!roomId) { setMessages([]); seenRowsRef.current.clear(); return; }
    let cancelled = false;
    const timers: number[] = [];
    let nextVisibleAt = Date.now();
    let draining = false;
    const pending: ChatMessage[] = [];

    const addRow = (row: ChatRow) => {
      if (seenRowsRef.current.has(row.id)) return;
      seenRowsRef.current.add(row.id);
      const msg: ChatMessage = {
        id: `${row.id}`,
        player: row.seat as PlayerId,
        phraseId: row.phrase_id as ChatPhraseId,
        timestamp: new Date(row.created_at).getTime(),
        vars: row.phrase_id === "si-tinc-n" && stateRef.current
          ? { n: playerTotalEnvit(stateRef.current.round, row.seat as PlayerId) }
          : undefined,
      };
      pending.push(msg);
      drainQueue();
    };

    const drainQueue = () => {
      if (draining) return;
      pending.sort((a, b) => a.timestamp - b.timestamp);
      const msg = pending.shift();
      if (!msg) return;

      draining = true;
      const now = Date.now();
      const showAt = Math.max(now, nextVisibleAt);
      nextVisibleAt = showAt + MIN_VISIBLE_GAP_MS;
      const showTimer = window.setTimeout(() => {
        if (cancelled) return;
        setMessages((prev) => [
          ...prev.filter((m) => m.player !== msg.player),
          msg,
        ].sort((a, b) => a.timestamp - b.timestamp));
        const hideTimer = window.setTimeout(() => {
          if (cancelled) return;
          setMessages((prev) => prev.filter((m) => m.id !== msg.id));
        }, VISIBLE_MS) as unknown as number;
        timers.push(hideTimer);
        draining = false;
        drainQueue();
      }, showAt - now) as unknown as number;
      timers.push(showTimer);
    };

    const loadRecentRows = () => {
      const since = new Date(Date.now() - VISIBLE_MS * 3).toISOString();
      return supabase
      .from("room_chat")
      .select("*")
      .eq("room_id", roomId)
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .then(({ data }) => {
        if (cancelled || !data) return;
        for (const r of data as ChatRow[]) addRow(r);
      });
    };

    // Carrega els últims segons (per si l'usuari acaba d'arribar o s'ha perdut realtime).
    loadRecentRows();
    const pollTimer = window.setInterval(() => { void loadRecentRows(); }, 1500);
    timers.push(pollTimer as unknown as number);

    const chanName = `room-chat-${roomId}`;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let attempts = 0;
    let reconnectTimer: number | null = null;

    const teardown = () => {
      if (channel) {
        try { supabase.removeChannel(channel); } catch { /* ignore */ }
        channel = null;
      }
      clearChannel("chat", chanName);
    };

    const scheduleReconnect = () => {
      if (cancelled) return;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      const delay = backoffDelay(attempts++);
      reconnectTimer = window.setTimeout(() => {
        if (cancelled) return;
        teardown();
        connect();
      }, delay) as unknown as number;
    };

    const connect = () => {
      if (cancelled) return;
      reportChannel("chat", chanName, "subscribing");
      const ch = supabase
        .channel(chanName)
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "room_chat", filter: `room_id=eq.${roomId}` },
          (payload) => {
            if (cancelled) return;
            addRow(payload.new as ChatRow);
          },
        )
        .subscribe((status) => {
          if (cancelled) return;
          if (status === "SUBSCRIBED") {
            attempts = 0;
            reportChannel("chat", chanName, "joined");
            // Resync recent rows in case we missed any while disconnected.
            void loadRecentRows();
          } else if (status === "CLOSED") {
            reportChannel("chat", chanName, "closed");
            scheduleReconnect();
          } else if (status === "CHANNEL_ERROR") {
            reportChannel("chat", chanName, "error");
            scheduleReconnect();
          } else if (status === "TIMED_OUT") {
            reportChannel("chat", chanName, "timeout");
            scheduleReconnect();
          }
        });
      channel = ch;
    };

    connect();

    const onWake = () => {
      if (cancelled) return;
      void loadRecentRows();
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
      timers.forEach((timer) => window.clearTimeout(timer));
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      teardown();
      if (typeof window !== "undefined") {
        window.removeEventListener("online", onOnline);
        document.removeEventListener("visibilitychange", onVisible);
      }
    };
  }, [roomId, resetSignal]);

  return { messages, reset };
}
