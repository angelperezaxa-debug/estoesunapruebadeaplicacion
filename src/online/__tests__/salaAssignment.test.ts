import { describe, it, expect } from "vitest";
import {
  SALA_SLUGS,
  VISIBLE_TABLES_PER_SALA,
  VISIBLE_TABLES_DEFAULT,
  salaForRoom,
  roomHasFreeHumanSeat,
  isRoomVisibleInSala,
  isRoomJoinableInSala,
  summarizeSala,
  summarizeLobbyView,
  playersInSala,
  type SalaSlug,
} from "@/online/salaAssignment";
import type { LobbyRoomDTO } from "@/online/rooms.functions";
import type { OnlinePlayer } from "@/online/useLobbyPresence";
import type { PlayerId } from "@/game/types";

type SeatKind = LobbyRoomDTO["seatKinds"][number];

function makeRoom(over: Partial<LobbyRoomDTO> & { code: string }): LobbyRoomDTO {
  const seatKinds: SeatKind[] = over.seatKinds ?? ["human", "human", "human", "human"];
  return {
    id: over.id ?? `id-${over.code}`,
    code: over.code,
    status: over.status ?? "lobby",
    targetCames: over.targetCames ?? 2,
    targetCama: over.targetCama ?? 12,
    turnTimeoutSec: over.turnTimeoutSec ?? 30,
    seatKinds,
    hostDevice: over.hostDevice ?? "host-device",
    players: over.players ?? [],
  };
}

function fillHumans(room: LobbyRoomDTO): LobbyRoomDTO {
  const players = room.seatKinds
    .map((kind, i) => ({ kind, seat: i as PlayerId }))
    .filter((s) => s.kind === "human")
    .map((s) => ({ seat: s.seat, name: `P${s.seat}`, isOnline: true }));
  return { ...room, players };
}

describe("salaForRoom — assignació determinista", () => {
  it("usa el prefix explícit del codi quan coincideix amb una sala", () => {
    expect(salaForRoom({ code: "LA-FALTA-ABC123" })).toBe("la-falta");
    expect(salaForRoom({ code: "truquers-XYZ" })).toBe("truquers");
    expect(salaForRoom({ code: "JOC-FORA-1" })).toBe("joc-fora");
    expect(salaForRoom({ code: "9-BONES-77" })).toBe("9-bones");
  });

  it("retorna sempre el mateix slug per al mateix codi (idempotent)", () => {
    const codes = ["ABCD", "ZZZZ", "T-001", "demo-42", "Q9P"];
    for (const code of codes) {
      const a = salaForRoom({ code });
      const b = salaForRoom({ code });
      const c = salaForRoom({ code });
      expect(a).toBe(b);
      expect(b).toBe(c);
      expect(SALA_SLUGS).toContain(a);
    }
  });

  it("no és case-sensitive per al matching de prefix", () => {
    expect(salaForRoom({ code: "la-falta-XYZ" })).toBe("la-falta");
    expect(salaForRoom({ code: "LA-FALTA-XYZ" })).toBe("la-falta");
    expect(salaForRoom({ code: "La-Falta-XYZ" })).toBe("la-falta");
  });

  it("reparteix codis sense prefix entre les 4 sales (cobertura raonable)", () => {
    // Generem 400 codis pseudo-aleatoris i comprovem que totes les sales
    // reben alguna mesa (la distribució per hash ha de ser raonablement
    // uniforme).
    const counts: Record<SalaSlug, number> = {
      "la-falta": 0, "truquers": 0, "joc-fora": 0, "9-bones": 0,
    };
    for (let i = 0; i < 400; i++) {
      const code = `R${i.toString(36)}-${(i * 31).toString(36)}`;
      counts[salaForRoom({ code })]++;
    }
    for (const slug of SALA_SLUGS) {
      expect(counts[slug]).toBeGreaterThan(0);
    }
  });
});

describe("roomHasFreeHumanSeat", () => {
  it("és false si la mesa no està en lobby", () => {
    const r = makeRoom({ code: "X1", status: "playing" });
    expect(roomHasFreeHumanSeat(r)).toBe(false);
  });
  it("és true si hi ha algun seient humà sense ocupar", () => {
    const r = makeRoom({
      code: "X2",
      seatKinds: ["human", "bot", "human", "bot"],
      players: [{ seat: 0 as PlayerId, name: "A", isOnline: true }],
    });
    expect(roomHasFreeHumanSeat(r)).toBe(true);
  });
  it("és false si tots els seients humans estan ocupats", () => {
    const r = makeRoom({
      code: "X3",
      seatKinds: ["human", "bot", "human", "bot"],
      players: [
        { seat: 0 as PlayerId, name: "A", isOnline: true },
        { seat: 2 as PlayerId, name: "B", isOnline: true },
      ],
    });
    expect(roomHasFreeHumanSeat(r)).toBe(false);
  });
  it("ignora els seients de bot al càlcul (només compten humans)", () => {
    const r = makeRoom({ code: "X4", seatKinds: ["bot", "bot", "bot", "bot"] });
    expect(roomHasFreeHumanSeat(r)).toBe(false);
  });
});

describe("isRoomVisibleInSala / isRoomJoinableInSala", () => {
  const slug: SalaSlug = "truquers";
  it("una mesa playing de la sala és visible però NO unible", () => {
    const r = makeRoom({ code: "TRUQUERS-P1", status: "playing" });
    expect(isRoomVisibleInSala(r, slug)).toBe(true);
    expect(isRoomJoinableInSala(r, slug)).toBe(false);
  });
  it("una mesa lobby amb seients lliures és visible i unible", () => {
    const r = makeRoom({ code: "TRUQUERS-L1" });
    expect(isRoomVisibleInSala(r, slug)).toBe(true);
    expect(isRoomJoinableInSala(r, slug)).toBe(true);
  });
  it("una mesa lobby sense seients lliures NO és visible", () => {
    const r = fillHumans(makeRoom({ code: "TRUQUERS-FULL" }));
    expect(isRoomVisibleInSala(r, slug)).toBe(false);
  });
  it("una mesa d'una altra sala no apareix", () => {
    const r = makeRoom({ code: "LA-FALTA-X" });
    expect(isRoomVisibleInSala(r, slug)).toBe(false);
  });
});

describe("INVARIANT — disponibles == visibles + placeholders disponibles", () => {
  // Aquesta és la propietat crítica que el helper compartit ha de garantir
  // perquè /online/sales i /online/lobby/:sala mai mostrin xifres distintes.
  it("summarizeSala: available === joinables reals + placeholders, sempre <= 12", () => {
    const slug: SalaSlug = "la-falta";
    const rooms: LobbyRoomDTO[] = [
      makeRoom({ code: "LA-FALTA-A1" }),                                    // joinable
      fillHumans(makeRoom({ code: "LA-FALTA-A2" })),                        // plena → no visible
      makeRoom({ code: "LA-FALTA-A3", status: "playing" }),                 // visible no joinable
      makeRoom({ code: "TRUQUERS-X" }),                                     // altra sala
    ];
    const s = summarizeSala(rooms, slug);
    const realJoinable = s.visibleReal.filter(roomHasFreeHumanSeat).length;
    expect(s.visibleReal.length + s.placeholders).toBe(VISIBLE_TABLES_PER_SALA);
    expect(s.available).toBe(realJoinable + s.placeholders);
    expect(s.playing).toBe(s.visibleReal.length - realJoinable);
    expect(s.visibleReal.length).toBeLessThanOrEqual(VISIBLE_TABLES_PER_SALA);
  });

  it("summarizeLobbyView (sala): mateix invariant que Sales mostra", () => {
    const slug: SalaSlug = "9-bones";
    const rooms: LobbyRoomDTO[] = [
      makeRoom({ code: "9-BONES-1" }),
      makeRoom({ code: "9-BONES-2", status: "playing" }),
      fillHumans(makeRoom({ code: "9-BONES-3" })),
    ];
    const v = summarizeLobbyView({ rooms, salaSlug: slug });
    expect(v.targetCount).toBe(VISIBLE_TABLES_PER_SALA);
    expect(v.visibleRooms.length + v.placeholderCount).toBe(VISIBLE_TABLES_PER_SALA);
    // available = unibles reals + placeholders (els placeholders són sempre lliures)
    expect(v.availableCount).toBe(v.joinableCount + v.placeholderCount);
    expect(v.joinableCount + v.playingCount).toBe(v.visibleRooms.length);
  });

  it("summarizeLobbyView (sala): satura a 12 mesa visibles encara que n'hi hagi més", () => {
    const slug: SalaSlug = "joc-fora";
    const rooms: LobbyRoomDTO[] = Array.from({ length: 20 }, (_, i) =>
      makeRoom({ code: `JOC-FORA-${i.toString().padStart(3, "0")}` }),
    );
    const v = summarizeLobbyView({ rooms, salaSlug: slug });
    expect(v.visibleRooms.length).toBe(VISIBLE_TABLES_PER_SALA);
    expect(v.placeholderCount).toBe(0);
    expect(v.availableCount).toBe(v.joinableCount); // sense placeholders
  });

  it("summarizeLobbyView (sala buida): tot són placeholders i tots compten com a disponibles", () => {
    const v = summarizeLobbyView({ rooms: [], salaSlug: "la-falta" });
    expect(v.visibleRooms.length).toBe(0);
    expect(v.placeholderCount).toBe(VISIBLE_TABLES_PER_SALA);
    expect(v.availableCount).toBe(VISIBLE_TABLES_PER_SALA);
    expect(v.joinableCount).toBe(0);
    expect(v.playingCount).toBe(0);
  });

  it("summarizeLobbyView (lobby general, salaSlug=null): NO genera placeholders i targetCount=4", () => {
    const rooms: LobbyRoomDTO[] = [
      makeRoom({ code: "AAA" }),
      makeRoom({ code: "BBB", status: "playing" }),
    ];
    const v = summarizeLobbyView({ rooms, salaSlug: null });
    expect(v.targetCount).toBe(VISIBLE_TABLES_DEFAULT);
    expect(v.placeholderCount).toBe(VISIBLE_TABLES_DEFAULT - v.visibleRooms.length);
    // Per al lobby general, available NO inclou placeholders (no es mostren placeholders)
    expect(v.availableCount).toBe(v.joinableCount);
  });

  it("Cap mesa duplicada entre Lobby (vista sala) i la mateixa sala a Sales", () => {
    // Mateixa entrada → mateixa sortida visible. Això és el que evita la
    // desincronització entre /online/sales i /online/lobby/:sala.
    const slug: SalaSlug = "truquers";
    const rooms: LobbyRoomDTO[] = [
      makeRoom({ code: "TRUQUERS-1" }),
      makeRoom({ code: "TRUQUERS-2", status: "playing" }),
      fillHumans(makeRoom({ code: "TRUQUERS-3" })),
      makeRoom({ code: "LA-FALTA-9" }),
    ];
    const lobbyView = summarizeLobbyView({ rooms, salaSlug: slug });
    const salesSummary = summarizeSala(rooms, slug);
    expect(lobbyView.visibleRooms.map((r) => r.code))
      .toEqual(salesSummary.visibleReal.map((r) => r.code));
    expect(lobbyView.placeholderCount).toBe(salesSummary.placeholders);
    expect(lobbyView.availableCount).toBe(salesSummary.available);
  });
});

describe("playersInSala", () => {
  const players: OnlinePlayer[] = [
    { deviceId: "d1", name: "Anna", roomCode: "LA-FALTA-1", salaSlug: "la-falta" },
    { deviceId: "d2", name: "Bernat", roomCode: "TRUQUERS-7", salaSlug: "truquers" },
    { deviceId: "d3", name: "Cesc", roomCode: null, salaSlug: null },
    { deviceId: "d4", name: "Dolors", roomCode: "LA-FALTA-2", salaSlug: "la-falta" },
  ];
  it("filtra per sala usant la mateixa funció determinista", () => {
    expect(playersInSala(players, "la-falta").map((p) => p.name).sort())
      .toEqual(["Anna", "Dolors"]);
    expect(playersInSala(players, "truquers").map((p) => p.name)).toEqual(["Bernat"]);
    expect(playersInSala(players, "joc-fora")).toHaveLength(0);
  });
  it("ignora jugadors sense roomCode", () => {
    for (const slug of SALA_SLUGS) {
      expect(playersInSala(players, slug).every((p) => p.roomCode !== null)).toBe(true);
    }
  });
});

describe("Casos borde — mai 0 disponibles incorrectes", () => {
  it("salaForRoom: codis amb prefix exacte (sense guió de sufix) també compten", () => {
    expect(salaForRoom({ code: "LA-FALTA" })).toBe("la-falta");
    expect(salaForRoom({ code: "truquers" })).toBe("truquers");
    expect(salaForRoom({ code: "9-BONES" })).toBe("9-bones");
  });

  it("salaForRoom: codi buit/null/whitespace cau a una sala estable sense excepcions", () => {
    expect(SALA_SLUGS).toContain(salaForRoom({ code: "" }));
    expect(SALA_SLUGS).toContain(salaForRoom({ code: "   " }));
    expect(SALA_SLUGS).toContain(salaForRoom({ code: null }));
    expect(SALA_SLUGS).toContain(salaForRoom({ code: undefined }));
  });

  it("salaForRoom: prefixos parcials que NO acaben amb '-' ni són exactes van per hash", () => {
    // "LA-FALTAX" no és sala "la-falta" (prefix parcial, sense guió ni igualtat)
    const slug = salaForRoom({ code: "LA-FALTAX" });
    expect(SALA_SLUGS).toContain(slug);
  });

  it("playersInSala: ignora roomCode buit, whitespace i null", () => {
    const players: OnlinePlayer[] = [
      { deviceId: "d1", name: "A", roomCode: "", salaSlug: null },
      { deviceId: "d2", name: "B", roomCode: "   ", salaSlug: null },
      { deviceId: "d3", name: "C", roomCode: null, salaSlug: null },
      { deviceId: "d4", name: "D", roomCode: "LA-FALTA-1", salaSlug: "la-falta" },
    ];
    expect(playersInSala(players, "la-falta")).toHaveLength(1);
    for (const slug of SALA_SLUGS.filter((s) => s !== "la-falta")) {
      expect(playersInSala(players, slug)).toHaveLength(0);
    }
  });

  it("summarizeSala: amb >12 meses 'playing', les unibles s'incloen primer i 'available' > 0", () => {
    const slug: SalaSlug = "truquers";
    const rooms: LobbyRoomDTO[] = [];
    // 14 meses en joc + 2 unibles
    for (let i = 0; i < 14; i++) {
      rooms.push(fillHumans(makeRoom({ code: `TRUQUERS-P${i}`, status: "playing" })));
    }
    rooms.push(makeRoom({ code: "TRUQUERS-OPEN-1" }));
    rooms.push(makeRoom({ code: "TRUQUERS-OPEN-2" }));
    const v = summarizeLobbyView({ rooms, salaSlug: slug });
    expect(v.visibleRooms.length).toBe(VISIBLE_TABLES_PER_SALA);
    expect(v.joinableCount).toBeGreaterThanOrEqual(2);
    expect(v.availableCount).toBeGreaterThan(0);
  });

  it("summarizeSala: meses amb status desconegut (p.ex. 'finished') s'ignoren", () => {
    const slug: SalaSlug = "joc-fora";
    const rooms: LobbyRoomDTO[] = [
      makeRoom({ code: "JOC-FORA-X", status: "finished" as LobbyRoomDTO["status"] }),
    ];
    const v = summarizeLobbyView({ rooms, salaSlug: slug });
    expect(v.visibleRooms).toHaveLength(0);
    // Tota la sala és placeholders → totalment disponible.
    expect(v.placeholderCount).toBe(VISIBLE_TABLES_PER_SALA);
    expect(v.availableCount).toBe(VISIBLE_TABLES_PER_SALA);
  });
});

describe("summarizeSala — prioritat 'joinable' davant del límit visible", () => {
  const slug: SalaSlug = "la-falta";

  it("amb 13 'playing' i 1 'joinable': la 'joinable' apareix dins de les 12 visibles", () => {
    const rooms: LobbyRoomDTO[] = [];
    for (let i = 0; i < 13; i++) {
      rooms.push(fillHumans(makeRoom({ code: `LA-FALTA-P${i}`, status: "playing" })));
    }
    rooms.push(makeRoom({ code: "LA-FALTA-OPEN" }));
    const s = summarizeSala(rooms, slug);
    expect(s.visibleReal).toHaveLength(VISIBLE_TABLES_PER_SALA);
    expect(s.visibleReal.map((r) => r.code)).toContain("LA-FALTA-OPEN");
    expect(s.visibleReal.filter(roomHasFreeHumanSeat)).toHaveLength(1);
    expect(s.placeholders).toBe(0);
    expect(s.available).toBe(1);
    expect(s.playing).toBe(VISIBLE_TABLES_PER_SALA - 1);
  });

  it("amb 20 'playing' i 5 'joinable': totes les 5 unibles caben primer", () => {
    const rooms: LobbyRoomDTO[] = [];
    for (let i = 0; i < 20; i++) {
      rooms.push(fillHumans(makeRoom({ code: `LA-FALTA-P${i}`, status: "playing" })));
    }
    for (let i = 0; i < 5; i++) {
      rooms.push(makeRoom({ code: `LA-FALTA-J${i}` }));
    }
    const s = summarizeSala(rooms, slug);
    expect(s.visibleReal).toHaveLength(VISIBLE_TABLES_PER_SALA);
    const visibleCodes = s.visibleReal.map((r) => r.code);
    for (let i = 0; i < 5; i++) {
      expect(visibleCodes).toContain(`LA-FALTA-J${i}`);
    }
    expect(s.visibleReal.filter(roomHasFreeHumanSeat)).toHaveLength(5);
    expect(s.playing).toBe(VISIBLE_TABLES_PER_SALA - 5);
    expect(s.available).toBe(5);
  });

  it("les 'joinable' apareixen primer en l'ordre de visibleReal abans de qualsevol 'playing'", () => {
    const rooms: LobbyRoomDTO[] = [];
    // Intercalem playing i joinable a l'entrada per assegurar-nos que la
    // priorització no depèn de l'ordre de la llista crua.
    for (let i = 0; i < 15; i++) {
      rooms.push(fillHumans(makeRoom({ code: `LA-FALTA-P${i}`, status: "playing" })));
      if (i % 5 === 0) {
        rooms.push(makeRoom({ code: `LA-FALTA-J${i}` }));
      }
    }
    const s = summarizeSala(rooms, slug);
    expect(s.visibleReal).toHaveLength(VISIBLE_TABLES_PER_SALA);
    const firstNonJoinable = s.visibleReal.findIndex((r) => !roomHasFreeHumanSeat(r));
    const lastJoinable = (() => {
      for (let i = s.visibleReal.length - 1; i >= 0; i--) {
        if (roomHasFreeHumanSeat(s.visibleReal[i])) return i;
      }
      return -1;
    })();
    // Totes les unibles han d'aparèixer abans (índex menor) que qualsevol 'playing'.
    expect(lastJoinable).toBeLessThan(firstNonJoinable);
  });

  it("amb >12 'joinable': se'n mostren 12 i 'available' satura a 12 (sense placeholders)", () => {
    const rooms: LobbyRoomDTO[] = [];
    for (let i = 0; i < 18; i++) {
      rooms.push(makeRoom({ code: `LA-FALTA-J${i}` }));
    }
    const s = summarizeSala(rooms, slug);
    expect(s.visibleReal).toHaveLength(VISIBLE_TABLES_PER_SALA);
    expect(s.visibleReal.every(roomHasFreeHumanSeat)).toBe(true);
    expect(s.placeholders).toBe(0);
    expect(s.playing).toBe(0);
    expect(s.available).toBe(VISIBLE_TABLES_PER_SALA);
  });
});
