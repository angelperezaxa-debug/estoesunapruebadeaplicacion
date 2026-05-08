import { describe, it, expect } from "vitest";
import { computeReentryView, reentryHrefForRoom } from "@/online/reentry";
import type { LobbyRoomDTO, MyActiveRoomDTO } from "@/online/rooms.functions";
import type { PlayerId } from "@/game/types";

type SeatKind = LobbyRoomDTO["seatKinds"][number];

function room(over: Partial<LobbyRoomDTO> & { id: string; code: string }): LobbyRoomDTO {
  const seatKinds: SeatKind[] =
    over.seatKinds ?? ["human", "human", "human", "human"];
  return {
    id: over.id,
    code: over.code,
    status: over.status ?? "playing",
    targetCames: over.targetCames ?? 2,
    targetCama: over.targetCama ?? 12,
    turnTimeoutSec: over.turnTimeoutSec ?? 30,
    seatKinds,
    hostDevice: over.hostDevice ?? "host",
    players: over.players ?? [],
  };
}

function active(over: Partial<MyActiveRoomDTO> & { id: string; code: string }): MyActiveRoomDTO {
  // No usem `??` perquè volem permetre `mySeat: null` explícit als tests.
  const seat = "mySeat" in over ? (over.mySeat as PlayerId | null) : (0 as PlayerId);
  return {
    id: over.id,
    code: over.code,
    status: "playing",
    targetCames: over.targetCames ?? 2,
    updatedAt: over.updatedAt ?? new Date().toISOString(),
    mySeat: seat,
  };
}

describe("computeReentryView — invariant base", () => {
  it("retorna estructures buides quan no hi ha res actiu", () => {
    const v = computeReentryView({ visibleRooms: [], myActiveRooms: [] });
    expect(v.resumableIds.size).toBe(0);
    expect(v.perVisible).toEqual([]);
    expect(v.hiddenActiveRooms).toEqual([]);
    expect(v.totalActive).toBe(0);
  });

  it("marca canResume=true només si hi ha entrada del servidor amb mySeat", () => {
    const r1 = room({ id: "R1", code: "TRUQUERS-1", status: "playing",
      players: [{ seat: 0 as PlayerId, name: "Jo", isOnline: false }] });
    const r2 = room({ id: "R2", code: "TRUQUERS-2", status: "playing" });
    const v = computeReentryView({
      visibleRooms: [r1, r2],
      myActiveRooms: [active({ id: "R1", code: "TRUQUERS-1", mySeat: 0 as PlayerId })],
    });
    expect(v.perVisible.find((e) => e.room.id === "R1")?.canResume).toBe(true);
    expect(v.perVisible.find((e) => e.room.id === "R2")?.canResume).toBe(false);
    expect(v.resumableIds.has("R1")).toBe(true);
    expect(v.resumableIds.has("R2")).toBe(false);
  });

  it("descarta entrades del servidor amb mySeat=null (defensa anti-corrupció)", () => {
    const r1 = room({ id: "R1", code: "X1", status: "playing" });
    const v = computeReentryView({
      visibleRooms: [r1],
      myActiveRooms: [active({ id: "R1", code: "X1", mySeat: null as unknown as PlayerId })],
    });
    expect(v.perVisible[0].canResume).toBe(false);
    expect(v.totalActive).toBe(0);
  });
});

describe("computeReentryView — sincronia 'playing' vs 'lobby'", () => {
  // Cas crític: el servidor encara cacheja la mesa com a "playing" però la
  // snapshot del lobby ja la mostra a "lobby" (reset / restart). Mai s'ha
  // d'oferir reentry — l'usuari ja no està jugant aquesta mà.
  it("NO permet reentry si la snapshot diu 'lobby' encara que el servidor digui 'playing'", () => {
    const r1 = room({
      id: "R1", code: "LA-FALTA-1", status: "lobby",
      players: [{ seat: 0 as PlayerId, name: "Jo", isOnline: true }],
    });
    const v = computeReentryView({
      visibleRooms: [r1],
      myActiveRooms: [active({ id: "R1", code: "LA-FALTA-1", mySeat: 0 as PlayerId })],
    });
    expect(v.perVisible[0].canResume).toBe(false);
    expect(v.resumableIds.has("R1")).toBe(false);
  });

  it("NO permet reentry si la snapshot diu 'finished' o 'abandoned'", () => {
    for (const status of ["finished", "abandoned"] as const) {
      const r1 = room({ id: "R1", code: "X-1", status });
      const v = computeReentryView({
        visibleRooms: [r1],
        myActiveRooms: [active({ id: "R1", code: "X-1", mySeat: 1 as PlayerId })],
      });
      expect(v.perVisible[0].canResume).toBe(false);
    }
  });

  it("permet reentry quan tots dos coincideixen a 'playing'", () => {
    const r1 = room({
      id: "R1", code: "TRUQUERS-9", status: "playing",
      players: [{ seat: 2 as PlayerId, name: "Jo", isOnline: false }],
    });
    const v = computeReentryView({
      visibleRooms: [r1],
      myActiveRooms: [active({ id: "R1", code: "TRUQUERS-9", mySeat: 2 as PlayerId })],
      myDeviceId: "dev-A",
    });
    expect(v.perVisible[0].canResume).toBe(true);
  });
});

describe("computeReentryView — cross-check de seients amb deviceId", () => {
  it("NO permet reentry si el seient indicat pel servidor està buit a la snapshot", () => {
    // El servidor ens diu seient=1, però `room.players` no té ningú al 1
    // (fila orfe / kick fora de banda). Defensa estricta.
    const r1 = room({
      id: "R1", code: "X-K", status: "playing",
      players: [{ seat: 0 as PlayerId, name: "Altre", isOnline: true }],
    });
    const v = computeReentryView({
      visibleRooms: [r1],
      myActiveRooms: [active({ id: "R1", code: "X-K", mySeat: 1 as PlayerId })],
      myDeviceId: "dev-A",
    });
    expect(v.perVisible[0].canResume).toBe(false);
  });

  it("permet reentry si el seient està ocupat (i el servidor ja ha confirmat el device)", () => {
    const r1 = room({
      id: "R1", code: "X-OK", status: "playing",
      players: [{ seat: 1 as PlayerId, name: "Jo", isOnline: false }],
    });
    const v = computeReentryView({
      visibleRooms: [r1],
      myActiveRooms: [active({ id: "R1", code: "X-OK", mySeat: 1 as PlayerId })],
      myDeviceId: "dev-A",
    });
    expect(v.perVisible[0].canResume).toBe(true);
  });

  it("sense deviceId no aplica el cross-check (compat retro)", () => {
    const r1 = room({
      id: "R1", code: "X-NS", status: "playing",
      players: [], // sense info de seients
    });
    const v = computeReentryView({
      visibleRooms: [r1],
      myActiveRooms: [active({ id: "R1", code: "X-NS", mySeat: 0 as PlayerId })],
      // sense myDeviceId
    });
    expect(v.perVisible[0].canResume).toBe(true);
  });
});

describe("computeReentryView — meses actives no visibles", () => {
  it("classifica com a hiddenActiveRooms les meses no presents al lobby visible", () => {
    const visibleR = room({ id: "VIS", code: "TRUQUERS-V", status: "playing",
      players: [{ seat: 0 as PlayerId, name: "Jo", isOnline: false }] });
    const v = computeReentryView({
      visibleRooms: [visibleR],
      myActiveRooms: [
        active({ id: "VIS", code: "TRUQUERS-V", mySeat: 0 as PlayerId }),
        active({ id: "OTHER-SALA", code: "9-BONES-X", mySeat: 3 as PlayerId }),
        active({ id: "OUT-OF-LIMIT", code: "LA-FALTA-Z", mySeat: 1 as PlayerId }),
      ],
      myDeviceId: "dev-A",
    });
    expect(v.perVisible).toHaveLength(1);
    expect(v.perVisible[0].canResume).toBe(true);
    expect(v.hiddenActiveRooms.map((r) => r.id).sort()).toEqual(
      ["OTHER-SALA", "OUT-OF-LIMIT"],
    );
    expect(v.totalActive).toBe(3);
  });

  it("totalActive ignora les entrades del servidor amb mySeat null", () => {
    const v = computeReentryView({
      visibleRooms: [],
      myActiveRooms: [
        active({ id: "A", code: "A", mySeat: 0 as PlayerId }),
        active({ id: "B", code: "B", mySeat: null as unknown as PlayerId }),
      ],
    });
    expect(v.totalActive).toBe(1);
    expect(v.hiddenActiveRooms.map((r) => r.id)).toEqual(["A"]);
  });
});

describe("computeReentryView — idempotència i estabilitat", () => {
  it("crida múltiples cops amb la mateixa entrada produeix el mateix resultat", () => {
    const r1 = room({ id: "R1", code: "TRUQUERS-1", status: "playing",
      players: [{ seat: 0 as PlayerId, name: "Jo", isOnline: false }] });
    const input = {
      visibleRooms: [r1],
      myActiveRooms: [active({ id: "R1", code: "TRUQUERS-1", mySeat: 0 as PlayerId })],
      myDeviceId: "dev-A",
    };
    const a = computeReentryView(input);
    const b = computeReentryView(input);
    expect(a.perVisible[0].canResume).toBe(b.perVisible[0].canResume);
    expect(Array.from(a.resumableIds)).toEqual(Array.from(b.resumableIds));
    expect(a.totalActive).toBe(b.totalActive);
  });

  it("preserva l'ordre original de visibleRooms a perVisible", () => {
    const rooms: LobbyRoomDTO[] = ["A", "B", "C", "D"].map((id) =>
      room({ id, code: `T-${id}`, status: "playing" }),
    );
    const v = computeReentryView({ visibleRooms: rooms, myActiveRooms: [] });
    expect(v.perVisible.map((e) => e.room.id)).toEqual(["A", "B", "C", "D"]);
  });
});

describe("reentryHrefForRoom", () => {
  it("genera la URL canònica de reentry", () => {
    expect(reentryHrefForRoom({ code: "TRUQUERS-42" })).toBe("/online/partida/TRUQUERS-42");
  });
});
