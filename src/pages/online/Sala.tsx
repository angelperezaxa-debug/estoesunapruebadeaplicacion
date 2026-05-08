import { useNavigate, useParams } from "@/lib/router-shim";
import { useEffect, useState } from "react";
import { ClientOnly } from "@/components/ClientOnly";
import { Button } from "@/components/ui/button";
import { usePlayerIdentity } from "@/hooks/usePlayerIdentity";
import { useAdminPassword } from "@/hooks/useAdminPassword";

import { useRoomRealtime } from "@/online/useRoomRealtime";
import { joinRoom, startMatch, setSeatKind, leaveRoom, adminCloseRoom, setRoomSettings } from "@/online/rooms.functions";
import { cn } from "@/lib/utils";
import type { PlayerId } from "@/game/types";
import { Loader2, Copy, LogOut, Check, ShieldX } from "lucide-react";
import { TableSeatPicker, type SeatInfo } from "@/online/TableSeatPicker";
import { BoardRoomChat } from "@/online/BoardRoomChat";
import { toast } from "sonner";
import { useT } from "@/i18n/useT";

function Loading() {
  return (
    <main className="min-h-screen flex items-center justify-center">
      <Loader2 className="w-6 h-6 animate-spin text-primary" />
    </main>
  );
}

function OnlineSalaPage() {
  return (
    <ClientOnly fallback={<Loading />}>
      <Sala />
    </ClientOnly>
  );
}

function Sala() {
  const { codi = "" } = useParams<{ codi: string }>();
  const navigate = useNavigate();
  const t = useT();
  const { deviceId, name, hasName, ready } = usePlayerIdentity();
  const code = codi.toUpperCase();
  const { data, error, loading, refresh } = useRoomRealtime(ready ? code : null, deviceId);
  const { password: adminPassword, isAdmin } = useAdminPassword();

  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [closingAdmin, setClosingAdmin] = useState(false);

  useEffect(() => {
    if (!data || !hasName || joining) return;
    if (data.mySeat != null) return;
    if (data.room.status !== "lobby") return;
    const usedSeats = new Set(data.players.map((p) => p.seat));
    const freeHumanSeats = ([0, 1, 2, 3] as PlayerId[]).filter(
      (s) => data.room.seatKinds[s] === "human" && !usedSeats.has(s),
    );
    if (freeHumanSeats.length !== 1) return;
    setJoining(true);
    joinRoom({ data: { code, deviceId, name, preferredSeat: freeHumanSeats[0] } })
      .then(() => refresh())
      .catch((e) => setJoinError(e instanceof Error ? e.message : String(e)))
      .finally(() => setJoining(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, hasName, name, deviceId, code, joining]);

  useEffect(() => {
    if (data?.room.status === "playing" && data.mySeat != null) {
      navigate(`/online/partida/${code}`);
    }
    if (data?.room.status === "abandoned" || data?.room.status === "finished") {
      navigate("/");
    }
  }, [data, code, navigate]);

  // Si l'amfitrió tanca la pestanya, abandona la taula (beacon)
  const roomIdForUnload = data?.room.id;
  const roomStatusForUnload = data?.room.status;
  const isHostForUnload = data?.room.hostDevice === deviceId;
  useEffect(() => {
    if (!roomIdForUnload || !isHostForUnload || roomStatusForUnload === "finished" || roomStatusForUnload === "abandoned") return;
    const handleUnload = () => {
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/rooms-rpc`;
      const body = JSON.stringify({ fn: "leaveRoom", data: { roomId: roomIdForUnload, deviceId } });
      try {
        navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
      } catch { /* noop */ }
    };
    window.addEventListener("pagehide", handleUnload);
    window.addEventListener("beforeunload", handleUnload);
    return () => {
      window.removeEventListener("pagehide", handleUnload);
      window.removeEventListener("beforeunload", handleUnload);
    };
  }, [roomIdForUnload, roomStatusForUnload, isHostForUnload, deviceId]);

  if (!ready || loading) return <Loading />;

  if (error) {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center gap-3 px-5">
        <p className="text-destructive text-sm text-center">{error}</p>
        <Button onClick={() => navigate("/")} variant="outline">{t("common.back_home")}</Button>
      </main>
    );
  }
  if (!data) return <Loading />;

  const { room, players } = data;
  const isHost = room.hostDevice === deviceId;
  const expectedHumans = room.seatKinds.filter((k) => k === "human").length;
  const joinedHumans = players.length;
  const totalSeated = players.length + room.seatKinds.filter((k) => k === "bot").length;
  const tableFull = totalSeated >= 4;
  const canStart = isHost && joinedHumans >= expectedHumans && room.status === "lobby";



  const handlePickSeat = async (seat: PlayerId) => {
    // Si sóc l'amfitrió i el seient és humà i està buit, el converteixo a bot
    if (isHost && room.status === "lobby" && room.seatKinds[seat] === "human" && !players.some((p) => p.seat === seat)) {
      try {
        await setSeatKind({ data: { roomId: room.id, deviceId, seat, kind: "bot" } });
        await refresh();
      } catch (e) {
        setJoinError(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    // Si sóc l'amfitrió i toco un seient bot, el torne a humà (lliure)
    if (isHost && room.status === "lobby" && room.seatKinds[seat] === "bot") {
      try {
        await setSeatKind({ data: { roomId: room.id, deviceId, seat, kind: "human" } });
        await refresh();
      } catch (e) {
        setJoinError(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    if (!hasName) { setJoinError(t("sala.need_name")); return; }
    if (data.mySeat != null) return;
    if (room.seatKinds[seat] !== "human") return;
    if (players.some((p) => p.seat === seat)) return;
    setJoining(true);
    setJoinError(null);
    try {
      await joinRoom({ data: { code, deviceId, name, preferredSeat: seat } });
      await refresh();
    } catch (e) {
      setJoinError(e instanceof Error ? e.message : String(e));
    } finally {
      setJoining(false);
    }
  };

  const seats: SeatInfo[] = ([0, 1, 2, 3] as PlayerId[]).map((seat) => {
    const kind = room.seatKinds[seat];
    const occupant = players.find((p) => p.seat === seat);
    const isMe = occupant?.deviceId === deviceId;
    const isHostSeat = occupant?.deviceId === room.hostDevice;
    if (kind === "bot") {
      return {
        seat,
        kind,
        occupant: { kind: "bot" },
        selectable: isHost && room.status === "lobby",
      };
    }
    if (occupant) {
      return {
        seat,
        kind,
        occupant: isMe
          ? { kind: "me", name: occupant.name }
          : {
              kind: "human",
              name: occupant.name,
              online: occupant.isOnline,
              lastSeen: occupant.lastSeen,
            },
        isHost: isHostSeat,
        selectable: false,
      };
    }
    return {
      seat,
      kind,
      occupant: { kind: "empty" },
      selectable: room.status === "lobby" && (isHost || (data.mySeat == null && hasName)),
    };
  });


  const handleStart = async () => {
    setStarting(true);
    try {
      await startMatch({ data: { roomId: room.id, deviceId } });
    } catch (e) {
      setJoinError(e instanceof Error ? e.message : String(e));
      setStarting(false);
    }
  };

  const handleCloseTable = async () => {
    try {
      await leaveRoom({ data: { roomId: room.id, deviceId } });
      navigate("/");
    } catch (e) {
      setJoinError(e instanceof Error ? e.message : String(e));
    }
  };

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch { /* noop */ }
  };

  return (
    <main className="menu-screen min-h-screen flex flex-col items-center justify-center px-5 py-8">
      <div className="w-full max-w-md flex flex-col gap-5">
        <div className="flex justify-end">
          <Button
            onClick={async () => {
              if (data?.room && data.mySeat != null && data.room.status === "lobby") {
                try { await leaveRoom({ data: { roomId: data.room.id, deviceId } }); } catch { /* noop */ }
              }
              navigate("/");
            }}
            size="sm"
            variant="outline"
            className="h-8 w-8 p-0 border-foreground/80 text-foreground hover:bg-foreground/10"
            aria-label={t("common.back_home")}
            title={t("common.back_home")}
          >
            <LogOut className="w-4 h-4" />
          </Button>
        </div>

        <header className="text-center flex flex-col items-center gap-2">
          <div className="inline-flex items-center gap-3">
            <h1 className="font-title font-black italic text-gold text-3xl sm:text-4xl">{t("sala.table")}</h1>
            <button
              type="button"
              onClick={copyCode}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl border-2 border-primary/60 bg-background/40 hover:bg-primary/10"
              aria-label={t("sala.copy_code")}
              title={t("sala.copy_code_short")}
            >
              <span className="font-title font-black italic text-primary text-3xl sm:text-4xl">{code}</span>
              {copied ? <Check className="w-5 h-5 text-team-nos" /> : <Copy className="w-5 h-5 text-primary/70" />}
            </button>
          </div>
          <p className="text-[11px] text-muted-foreground">{t("sala.share_code")}</p>
        </header>

        {!hasName && (
          <section className="wood-surface border-2 border-destructive/50 rounded-2xl p-3 flex items-center justify-between gap-3">
            <p className="text-xs text-foreground">Configura el teu nom per asseure't</p>
            <Button size="sm" variant="outline" onClick={() => navigate("/ajustes")} className="border-primary/40">
              Ajustes
            </Button>
          </section>
        )}

        <section className="flex flex-col gap-3">
          <div className="text-[11px] font-display tracking-widest uppercase text-primary/85 text-center">
            {t("sala.seats", { joined: joinedHumans, total: expectedHumans })}
          </div>
          {data.mySeat == null && hasName && room.status === "lobby" && !isHost && (
            <p className="text-[11px] text-primary/90 text-center -mt-1">{t("sala.choose_seat")}</p>
          )}
          {isHost && room.status === "lobby" && (
            <p className="text-[11px] text-primary/90 text-center -mt-1">
              {t("sala.host_seat_hint")}
            </p>
          )}
          <TableSeatPicker seats={seats} onSeatClick={handlePickSeat} highlightSeat={data.mySeat} />
          {joining && <p className="text-[11px] text-muted-foreground text-center">{t("sala.reserving")}</p>}
        </section>


        {isHost && room.status === "lobby" ? (
          <RoomSettings
            roomId={room.id}
            deviceId={deviceId}
            targetCames={room.targetCames}
            targetCama={room.targetCama}
            turnTimeoutSec={room.turnTimeoutSec}
          />
        ) : (
          <div className="flex flex-col gap-1 text-[11px] text-muted-foreground text-center">
            <p>{t("sala.cames_to_win")} <strong className="text-foreground">{room.targetCames}</strong></p>
            <p>{t("sala.points_per_cama")} <strong className="text-foreground">{room.targetCama}</strong> · {t("sala.turn_time")} <strong className="text-foreground">{room.turnTimeoutSec}s</strong></p>
          </div>
        )}

        {joinError && <p className="text-xs text-destructive text-center">{joinError}</p>}

        {isHost && (
          <div className="flex flex-col gap-3">
            <Button
              size="lg"
              className="h-14 bg-primary text-primary-foreground hover:bg-primary/90 font-display font-bold text-lg gold-glow"
              onClick={handleStart}
              disabled={!canStart || starting}
            >
              {starting ? <Loader2 className="w-5 h-5 mr-2 animate-spin" /> : null}
              {tableFull
                ? t("sala.start_match")
                : canStart
                  ? t("sala.start_match")
                  : t("sala.waiting_humans", { joined: joinedHumans, total: expectedHumans })}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="border-destructive/50 text-destructive hover:bg-destructive/10"
              onClick={handleCloseTable}
            >
              {t("sala.close_table")}
            </Button>
          </div>
        )}
        {!isHost && room.status === "lobby" && (
          <p className="text-center text-xs text-muted-foreground">{t("sala.waiting_host")}</p>
        )}

        {isAdmin && !isHost && (
          <Button
            type="button"
            variant="outline"
            disabled={closingAdmin}
            className="border-destructive/50 text-destructive hover:bg-destructive/10"
            onClick={async () => {
              setClosingAdmin(true);
              try {
                await adminCloseRoom({ data: { roomId: room.id, password: adminPassword } });
                toast.success(t("lobby.table_closed_toast"));
                navigate("/");
              } catch (e) {
                toast.error(e instanceof Error ? e.message : t("lobby.cant_close_table"));
                setClosingAdmin(false);
              }
            }}
          >
            {closingAdmin ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <ShieldX className="w-4 h-4 mr-2" />}
            {t("sala.close_table_admin")}
          </Button>
        )}
      </div>

      {hasName && (
        <BoardRoomChat
          roomId={room.id}
          roomCode={code}
          deviceId={deviceId}
          name={name}
          hasName={hasName}
          ready={ready}
          mySeat={data.mySeat}
          players={players}
          buttonClassName="fixed right-4 top-[190px] z-40 h-12 w-12 rounded-full text-primary-foreground shadow-lg bg-accent"
        />
      )}
    </main>
  );
}

const CAMES_OPTS = [1, 2, 3];
const TARGET_CAMA_OPTS = [9, 12];
const TURN_TIMEOUT_OPTS = [15, 30, 45, 60];

function RoomSettings({
  roomId,
  deviceId,
  targetCames,
  targetCama,
  turnTimeoutSec,
}: {
  roomId: string;
  deviceId: string;
  targetCames: number;
  targetCama: number;
  turnTimeoutSec: number;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const apply = async (patch: { targetCames?: number; targetCama?: number; turnTimeoutSec?: number }) => {
    if (busy) return;
    setBusy(true);
    try {
      await setRoomSettings({ data: { roomId, deviceId, ...patch } });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("sala.cant_change_settings"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <div className="text-[10px] font-display tracking-widest uppercase text-primary/85">{t("settings.cames_to_win")}</div>
        <div className="grid grid-cols-3 gap-2">
          {CAMES_OPTS.map((v) => (
            <Chip key={v} selected={targetCames === v} disabled={busy} onClick={() => apply({ targetCames: v })} label={v === 1 ? t("sala.cama_singular", { n: v }) : t("sala.cama_plural", { n: v })} />
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="text-[10px] font-display tracking-widest uppercase text-primary/85">{t("settings.piedras_per_cama")}</div>
        <div className="grid grid-cols-2 gap-2">
          {TARGET_CAMA_OPTS.map((v) => (
            <Chip key={v} selected={targetCama === v} disabled={busy} onClick={() => apply({ targetCama: v })} label={t("sala.points", { n: v })} />
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="text-[10px] font-display tracking-widest uppercase text-primary/85">{t("sala.waiting_time_turn")}</div>
        <div className="grid grid-cols-4 gap-2">
          {TURN_TIMEOUT_OPTS.map((sec) => (
            <Chip key={sec} selected={turnTimeoutSec === sec} disabled={busy} onClick={() => apply({ turnTimeoutSec: sec })} label={`${sec}s`} />
          ))}
        </div>
      </div>
    </section>
  );
}

function Chip({ selected, onClick, label, disabled }: { selected: boolean; onClick: () => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        "rounded-md border px-2 py-1.5 text-center transition-all flex flex-col items-center gap-0.5 leading-tight disabled:opacity-60",
        selected
          ? "border-primary bg-primary/15 text-primary"
          : "border-primary/25 bg-background/30 text-foreground/80 hover:border-primary/50 hover:bg-primary/10",
      )}
    >
      <span className="inline-flex items-center gap-1.5 font-display font-bold text-xs">{label}</span>
    </button>
  );
}

export default OnlineSalaPage;
