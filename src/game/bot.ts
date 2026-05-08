import type { Action, Card, MatchState, PlayerId } from "./types";
import { legalActions } from "./engine";
import { bestEnvit, cardStrength } from "./deck";
import { teamOf } from "./types";
import type { PartnerAdvice } from "./botConsult";
import { pickFortCard, pickMolestoCard, pickTresCard, type CardHint, type PlayStrengthHint } from "./playerIntents";
import { NEUTRAL_TUNING, type BotTuning } from "./profileAdaptation";

export interface BotHints {
  cardHint?: CardHint;
  playStrength?: PlayStrengthHint;
  silentTruc?: boolean;
  foldTruc?: boolean;
  /**
   * El company humà ha indicat "Truca!" — si és legal cantar truc i no
   * està en mode `silentTruc`, fes-ho immediatament.
   */
  forceTruc?: boolean;
  /**
   * El company humà ha indicat "Envida!" — si és legal cantar envit,
   * fes-ho immediatament sense considerar la força de la mà.
   */
  forceEnvit?: boolean;
  /**
   * Mode sincer: indica si algun rival ha mostrat força en aquesta ronda
   * dient "Vine a mi!" (vine-a-mi) o "Algo tinc" (tinc-bona). Quan és
   * `true`, mai es reserva una carta forta (manilla d'espases o manilla
   * d'oros) confiant que la mesa és inofensiva.
   */
  rivalShownStrength?: boolean;
}

export function botDecide(
  m: MatchState,
  player: PlayerId,
  partnerAdvice: PartnerAdvice = "neutral",
  hints: BotHints = {},
  tuning: BotTuning = NEUTRAL_TUNING,
  bluffRate: number = 0,
): Action | null {
  const decision = botDecideInner(m, player, partnerAdvice, hints, tuning, bluffRate);
  if (!decision) return decision;
  // Salvaguarda: en la 2a baza, si el meu equip ha guanyat la 1a i el bot
  // decideix tirar una carta "top" (manilla d'oros, manilla d'espases,
  // As bastos o As espases), ha de cantar TRUC abans en lloc de gastar la
  // carta sense pressionar. Només si el truc encara no està decidit i hi ha
  // acció legal de truc disponible i no s'ha demanat silenci.
  if (decision.type === "play-card") {
    const r = m.round;
    if (r.tricks.length === 2 && r.tricks[0] && r.tricks[0].parda !== true) {
      const myTeam = teamOf(player);
      const wonFirst =
        r.tricks[0].winner !== undefined && teamOf(r.tricks[0].winner!) === myTeam;
      if (wonFirst) {
        const hand = r.hands[player];
        const card = hand.find((c) => c.id === (decision as Extract<Action, { type: "play-card" }>).cardId);
        const isTop = (c?: Card) =>
          !!c &&
          ((c.rank === 7 && (c.suit === "oros" || c.suit === "espases")) ||
            (c.rank === 1 && (c.suit === "bastos" || c.suit === "espases")));
        if (isTop(card) && !(decision as any).covered && !hints.silentTruc) {
          const trucDecided = r.trucState.kind === "accepted" || r.trucState.kind === "rejected";
          if (!trucDecided) {
            const actionsAvail = legalActions(m, player);
            const trucAct = actionsAvail.find(
              (a) => a.type === "shout" && a.what === "truc",
            );
            if (trucAct) return trucAct;
          }
        }
      }
    }
  }
  return decision;
}

function botDecideInner(
  m: MatchState,
  player: PlayerId,
  partnerAdvice: PartnerAdvice = "neutral",
  hints: BotHints = {},
  tuning: BotTuning = NEUTRAL_TUNING,
  bluffRate: number = 0,
): Action | null {
  const actions = legalActions(m, player);
  if (actions.length === 0) return null;

  const r = m.round;
  const hand = r.hands[player];
  const handStrength = avgStrength(hand);
  const myEnvit = bestEnvit(hand);

  if (r.envitState.kind === "pending" && teamOf(player) === r.envitState.awaitingTeam) {
    const isManoMe = r.mano === player;
    const trucStrength = estimateTrucStrength(hand);
    return decideEnvitResponse(actions, myEnvit, r.envitState.level, isManoMe, trucStrength, player, tuning, bluffRate, m, partnerAdvice);
  }
  if (r.trucState.kind === "pending" && teamOf(player) === r.trucState.awaitingTeam) {
    // Ordre del company humà: "Au, anem-se'n!" => rebutja el truc si és possible.
    if (hints.foldTruc) {
      const noVull = actions.find(a => a.type === "shout" && a.what === "no-vull");
      if (noVull) return noVull;
    }
    return decideTrucResponse(actions, hand, m, player, partnerAdvice, tuning, bluffRate);
  }

  // ---- OBLIGACIÓ ABSOLUTA: 2a baza, hem PERDUT la 1a, sóc l'últim de la
  // meua parella en tirar (el meu company ja ha tirat) i tinc alguna
  // carta que guanya a la millor jugada a la mesa → l'he de tirar SÍ
  // o SÍ. Aquesta regla té prioritat sobre tot (truc, tapar, reservar
  // manilles…) perquè perdre la 2a després d'haver perdut la 1a tanca
  // el truc i la mà.
  {
    const myTeamMust = teamOf(player);
    const firstTMust = r.tricks[0];
    const lostFirstMust =
      !!firstTMust &&
      firstTMust.parda !== true &&
      firstTMust.winner !== undefined &&
      teamOf(firstTMust.winner!) !== myTeamMust;
    const curTrickMust = r.tricks[r.tricks.length - 1];
    const inSecondTrickMust =
      r.tricks.length === 2 &&
      !!curTrickMust &&
      !curTrickMust.cards.some((tc) => tc.player === player);
    const partnerPlayedMust =
      !!curTrickMust &&
      curTrickMust.cards.some(
        (tc) => teamOf(tc.player) === myTeamMust && tc.player !== player,
      );
    if (lostFirstMust && inSecondTrickMust && partnerPlayedMust) {
      const tableBestMust = curTrickMust!.cards.reduce(
        (mx, tc) => Math.max(mx, cardStrength(tc.card)),
        -1,
      );
      const tableLeaderMust = curTrickMust!.cards.reduce(
        (best, tc) =>
          best === null || cardStrength(tc.card) > cardStrength(best.card)
            ? tc
            : best,
        null as { player: PlayerId; card: Card } | null,
      );
      const partnerWinsMust =
        !!tableLeaderMust && teamOf(tableLeaderMust.player) === myTeamMust;
      const allFourPlayedExceptMe = curTrickMust!.cards.length === 3;
      if (!(partnerWinsMust && allFourPlayedExceptMe)) {
        const playActsMust = actions.filter(
          (a) => a.type === "play-card",
        ) as Extract<Action, { type: "play-card" }>[];
        const sortedAscMust = [...hand].sort(
          (a, b) => cardStrength(a) - cardStrength(b),
        );
        const winnersMust = sortedAscMust.filter(
          (c) => cardStrength(c) > tableBestMust,
        );
        if (winnersMust.length > 0) {
          const matchAct = playActsMust.find(
            (a) => a.cardId === winnersMust[0]!.id,
          );
          if (matchAct) return { type: "play-card", cardId: matchAct.cardId };
        }
      }
    }
  }


  // ---- 2a baza, equip ja ha guanyat la 1a, només em queden cartes top
  //      (o un 3 + una carta top): NO consultar al company; en lloc d'això,
  //      o bé canto truc abans de tirar, o bé jugue tapada la carta més
  //      baixa que tinga (sense trucar). Mai gaste les cartes fortes en
  //      una baza que ja no necessitem guanyar.
  // "Carta top de truc" = manilla d'oros (7 oros), manilla d'espases (7 espases),
  // As bastos o As espases.
  {
    const r2 = r;
    const myTeam2 = teamOf(player);
    const firstTrick2 = r2.tricks[0];
    const firstTrickParda2 = !!firstTrick2 && firstTrick2.parda === true;
    const wonFirstTrick2 =
      !!firstTrick2 &&
      firstTrick2.winner !== undefined &&
      firstTrick2.parda !== true &&
      teamOf(firstTrick2.winner!) === myTeam2;
    const currentTrick2 = r2.tricks[r2.tricks.length - 1];
    const inSecondTrick =
      r2.tricks.length === 2 &&
      !!currentTrick2 &&
      !currentTrick2.cards.some((tc) => tc.player === player);
    if (inSecondTrick) {
      // Prioritat absoluta: si l'equip ja ha guanyat la 1a, sóc 3r a tirar
      // (hi ha 2 cartes a la mesa) i el company NO guanya, i tinc un 3
      // que supera la millor carta de la mesa, juga'l SEMPRE — encara que
      // tinga cartes top reservables. Tancar la 2a baza ací val més que
      // reservar manilles.
      if (wonFirstTrick2 && currentTrick2.cards.length === 2) {
        const tableBestStr = currentTrick2.cards.reduce(
          (mx, tc) => Math.max(mx, cardStrength(tc.card as any)),
          -1,
        );
        const tableLeader = currentTrick2.cards.reduce(
          (best, tc) =>
            best === null || cardStrength(tc.card as any) > cardStrength(best.card as any) ? tc : best,
          null as { player: PlayerId; card: Card } | null,
        );
        const partnerWins = !!tableLeader && teamOf(tableLeader.player) === myTeam2;
        if (!partnerWins) {
          const winningThree = hand.find(
            (c) => c.rank === 3 && cardStrength(c as any) > tableBestStr,
          );
          if (winningThree) {
            const playActs = actions.filter(
              (a) => a.type === "play-card",
            ) as Extract<Action, { type: "play-card" }>[];
            const matchAct = playActs.find((a) => a.cardId === winningThree.id);
            if (matchAct) return matchAct;
          }
        }
      }
      // Si la 1a baza s'ha empardat, MAI cobrir la carta: cal mirar de
      // guanyar la 2a (qui guanye la 2a guanya la mà). Es juga la carta
      // més alta disponible i no s'aplica la lògica de truc/tapar.
      if (firstTrickParda2) {
        const playActs = actions.filter(
          (a) => a.type === "play-card",
        ) as Extract<Action, { type: "play-card" }>[];
        if (playActs.length > 0 && hand.length > 0) {
          const sortedDesc = [...hand].sort(
            (a, b) => cardStrength(b as any) - cardStrength(a as any),
          );
          const highest = sortedDesc[0]!;
          const matchAct = playActs.find((a) => a.cardId === highest.id);
          if (matchAct) {
            return { type: "play-card", cardId: matchAct.cardId };
          }
        }
        // Si no podem trobar la jugada (cas anòmal), no apliquem truc/tapar:
        // deixem que la lògica posterior decideixi però sense cobrir.
      } else {
        const isTop = (c: { suit: string; rank: number }) =>
          (c.rank === 7 && (c.suit === "oros" || c.suit === "espases")) ||
          (c.rank === 1 && (c.suit === "bastos" || c.suit === "espases"));
        const isThree = (c: { suit: string; rank: number }) => c.rank === 3;
        const allTop = hand.length > 0 && hand.every(isTop);
        const oneThreePlusTop =
          hand.length >= 2 &&
          hand.every((c) => isTop(c) || isThree(c)) &&
          hand.some(isTop) &&
          hand.some(isThree);
        // Si l'equip ja ha guanyat la 1a baza, aplica la regla amb mans
        // "totes top" o "3 + top". Si no l'ha guanyada (i no és parda),
        // aplica només si TOTES les cartes restants són top.
        const trigger =
          (wonFirstTrick2 && (allTop || oneThreePlusTop)) ||
          (!wonFirstTrick2 && allTop);
        if (trigger) {
          const trucAct = actions.find(
            (a) => a.type === "shout" && a.what === "truc",
          );
          // Probabilitat de cantar truc en lloc de jugar tapada.
          // Modulada per la propensió de cant del perfil del bot.
          const pTruc = Math.min(1, 0.55 * tuning.callPropensity);
          if (trucAct && !hints.silentTruc && Math.random() < pTruc) {
            return trucAct;
          }
          // Alternativa: jugar la carta més baixa per reservar les cartes
          // fortes per a la 3a baza o per a un possible truc/retruc posterior.
          // Si l'equip ja ha guanyat la 1a baza i totes les cartes que em
          // queden són top/3 (allTop o oneThreePlusTop), NO tape: tapar
          // només té sentit si serveix per a ocultar una carta top o un 3,
          // però ací TOTES són top/3, així que tapar la més baixa no
          // amaga res. Es juga descoberta.
          const coverCard =
            !(wonFirstTrick2 && (allTop || oneThreePlusTop));
          const playActs = actions.filter(
            (a) => a.type === "play-card",
          ) as Extract<Action, { type: "play-card" }>[];
          if (playActs.length > 0) {
            const sortedByStrength = [...hand].sort(
              (a, b) => cardStrength(a as any) - cardStrength(b as any),
            );
            const lowest = sortedByStrength[0]!;
            const matchAct = playActs.find((a) => a.cardId === lowest.id);
            if (matchAct) {
              return coverCard
                ? { type: "play-card", cardId: matchAct.cardId, covered: true }
                : { type: "play-card", cardId: matchAct.cardId };
            }
          }
        }
      }
    }
  }

  // ---- Rol "primer de la pareja a tirar" en la baza actual ----
  // Si en la baza actual ningú del meu equip ha tirat encara, sóc el
  // primer del meu equip a tirar. Cantar envit o truc en aquesta posició
  // sol ser una mala estratègia: el rival respon amb info completa i el
  // company encara no ha pogut donar pistes. Per defecte, evita-ho;
  // només ho fa de tant en tant per a no ser previsible.
  const currentTrickForRole = r.tricks[r.tricks.length - 1];
  const teammatePlayedInCurrentTrick = !!currentTrickForRole?.cards.some(
    tc => teamOf(tc.player) === teamOf(player) && tc.player !== player,
  );
  const isFirstOfTeamToPlay = !teammatePlayedInCurrentTrick;
  // Probabilitat base d'autoritzar el cant tot i ser el primer del equip
  // (≈ 15%). S'incrementa lleugerament si el perfil és més agressiu.
  const firstOfTeamBypass = Math.random() < 0.15 * tuning.callPropensity;

  // ---- Restricció dura per a "primer de la parella en la 1a baza" ----
  // Si soc el primer del meu equip a tirar en la PRIMERA baza, NO puc
  // envidar ni truquejar tret que tinga envit alt (≥31) i com a mínim
  // DUES cartes top de truc (As bastos, As espases, 7 espases o 7 oros).
  const isFirstTrickForRole = r.tricks.length === 1;
  const topCardsCount = hand.filter(
    (c) =>
      (c.rank === 1 && (c.suit === "bastos" || c.suit === "espases")) ||
      (c.rank === 7 && (c.suit === "espases" || c.suit === "oros")),
  ).length;
  const firstOfTeamFirstTrickAllowsCall =
    !isFirstOfTeamToPlay ||
    !isFirstTrickForRole ||
    (myEnvit >= 31 && topCardsCount >= 2);

  // ---- Estratègia "trampa" d'envit ----
  // Si sóc MÀ amb envit molt fort (≥31), sovint NO envide i espere que
  // ho faça el rival per a guanyar més pedres. El PEU (segon de la
  // parella) en canvi, si té envit (≥31), envida directament: no té
  // sentit esperar perquè ja és el seu torn d'envidar.
  const isMano = r.mano === player;
  const trapEnvit =
    (isMano && myEnvit >= 31) ||
    ((partnerAdvice === "strong" || partnerAdvice === "three") && myEnvit >= 28);

  const canEnvit = actions.some(a => a.type === "shout" && a.what === "envit");
  // Si el company humà ha indicat "Envida!", el bot canta envit
  // immediatament sense avaluar la força de la mà.
  if (canEnvit && hints.forceEnvit) {
    return { type: "shout", what: "envit" };
  }
  // Estratègia: la MÀ (primer jugador de la pareja) NO envida proactivament.
  // En lloc d'envidar i encadenar truc (combo "Envit + Truc" que sol donar
  // pocs punts perquè el rival pot rebutjar el truc i quedar-se l'envit
  // baix), espera que envide el rival per a poder renvidar i guanyar més
  // pedres. Si la mà té cartes molt fortes, el millor és esperar i deixar
  // que els rivals canten primer per a poder pujar les apostes.
  // El PEU (segon de la parella) sí pot envidar amb envit alt: ja és el seu
  // torn i no encadenarà cap truc no desitjat.
  const envitAllowedForRole = !isMano;
  // Freno addicional: si sóc el primer del meu equip a tirar en aquesta
  // baza, normalment no envide (excepte el bypass aleatori).
  const envitAllowedByPosition = !isFirstOfTeamToPlay || firstOfTeamBypass;

  // Peu amb envit (≥31): envida sí o sí, sense consultar ni esperar.
  // Aquesta excepció es manté fins i tot si és el primer del equip a tirar:
  // tindre 31+ d'envit és una jugada segura que no depèn de l'ordre.
  if (canEnvit && !isMano && myEnvit >= 31 && firstOfTeamFirstTrickAllowsCall) {
    return { type: "shout", what: "envit" };
  }
  // Mode honest (bluffRate === 0): només envida si realment té possibilitats
  // reals de guanyar l'envit (≥31). Si la mà és, envida; si és peu ja s'ha
  // tractat més amunt. Sense farols ni envits especulatius amb 27/30.
  // En mode honest la mà MAI envida proactivament (`envitAllowedForRole`).
  if (canEnvit && envitAllowedForRole && envitAllowedByPosition && firstOfTeamFirstTrickAllowsCall && bluffRate === 0) {
    if (myEnvit >= 31) return { type: "shout", what: "envit" };
    // No fer cap altre envit en mode sincer.
  } else
  if (canEnvit && envitAllowedForRole && envitAllowedByPosition && firstOfTeamFirstTrickAllowsCall && !trapEnvit) {
    if (myEnvit >= 30 && Math.random() < 0.8 * tuning.callPropensity) {
      return { type: "shout", what: "envit" };
    }
    if (myEnvit >= 27 && Math.random() < 0.3 * tuning.callPropensity) {
      return { type: "shout", what: "envit" };
    }
    // Bluff envit: només si el perfil ho permet (bluffRate > 0).
    if (bluffRate > 0 && myEnvit < 24 && Math.random() < bluffRate * tuning.bluffPropensity * tuning.callPropensity) {
      return { type: "shout", what: "envit" };
    }
  }
  // Amb trampa activa, de tant en tant igualment envida (per no ser previsible).
  // En mode sincer no s'aplica aquesta aleatorietat.
  if (canEnvit && envitAllowedForRole && envitAllowedByPosition && firstOfTeamFirstTrickAllowsCall && trapEnvit && bluffRate > 0 && Math.random() < 0.12) {
    return { type: "shout", what: "envit" };
  }

  const canTruc = actions.some(a => a.type === "shout" && a.what === "truc");
  if (canTruc && !hints.silentTruc) {
    // Si el company humà ha indicat "Truca!", el bot canta truc
    // immediatament sense avaluar la força de la mà.
    if (hints.forceTruc) {
      const trucAct = actions.find(a => a.type === "shout" && a.what === "truc");
      if (trucAct) return trucAct;
    }
    // Freno: si sóc el primer del meu equip a tirar en aquesta baza,
    // normalment NO truque proactivament (excepte el bypass aleatori).
    // El truc oportunista de 3a baza dins `decideProactiveTruc` segueix
    // protegit per açò perquè és precisament la situació en què tinc la
    // millor carta i té sentit pujar.
    if ((!isFirstOfTeamToPlay || firstOfTeamBypass) && firstOfTeamFirstTrickAllowsCall) {
      const trucAction = decideProactiveTruc(m, player, hand, handStrength, partnerAdvice, tuning, bluffRate, hints);
      if (trucAction) return trucAction;
    }
  }

  const playActions = actions.filter(a => a.type === "play-card") as Extract<Action, { type: "play-card" }>[];
  if (playActions.length === 0) {
    return actions[0]!;
  }

  // Ordres del company humà sobre quina carta tirar
  if (hints.cardHint === "fort") {
    const myTeamWonFirst = r.tricks[0]?.winner !== undefined && teamOf(r.tricks[0]!.winner!) === teamOf(player);
    const card = pickFortCard(hand, myTeamWonFirst);
    if (card) {
      const match = playActions.find(a => a.cardId === card.id);
      if (match) return match;
    }
  }
  if (hints.cardHint === "molesto") {
    const card = pickMolestoCard(hand);
    if (card) {
      const match = playActions.find(a => a.cardId === card.id);
      if (match) return match;
    }
  }
  if (hints.cardHint === "tres") {
    const card = pickTresCard(hand);
    if (card) {
      const match = playActions.find(a => a.cardId === card.id);
      if (match) return match;
    }
  }

  return choosePlayCard(m, player, playActions, partnerAdvice, hints.playStrength ?? null, hints.rivalShownStrength ?? false);
}

function avgStrength(hand: Array<{ suit: string; rank: number }>): number {
  if (hand.length === 0) return 0;
  let s = 0;
  for (const c of hand) s += cardStrength(c as any);
  return s / hand.length;
}

function estimateTrucStrength(hand: Array<{ suit: string; rank: number }>): number {
  // 0..1 aprox. Cartes molt fortes (≥85: manilla d'oros, manilla d'espases,
  // As bastos, As espases) valen molt; el 3 val mitjà; resta poc.
  let s = 0;
  for (const c of hand) {
    const v = cardStrength(c as any);
    if (v >= 85) s += 0.5;          // topTrucCards fortes + asos
    else if (v >= 70) s += 0.3;     // tres
    else if (v >= 50) s += 0.12;    // 6 o 7 menor
    else s += 0.04;
  }
  return Math.min(1, s);
}

/**
 * Distribució discreta aproximada del valor d'envit del rival que ja ha
 * cantat al nivell donat. Cobreix de 20 a 40 (valors típics). Pesos
 * estimats segons l'agressivitat creixent: més nivell → distribució
 * desplaçada cap a valors alts.
 */
function opponentEnvitDistribution(level: 2 | 4 | "falta"): Map<number, number> {
  // Pesos relatius. Es normalitzen després.
  const dist = new Map<number, number>();
  const set = (v: number, w: number) => dist.set(v, (dist.get(v) ?? 0) + w);

  if (level === 2) {
    // Envit simple: la majoria envida amb 29-33; cua fins a 38; algun bluff baix.
    set(25, 0.3); set(26, 0.5); set(27, 0.8); set(28, 1.2);
    set(29, 2.0); set(30, 3.0); set(31, 3.2); set(32, 2.8);
    set(33, 2.2); set(34, 1.6); set(35, 1.0); set(36, 0.6); set(37, 0.4); set(38, 0.2);
  } else if (level === 4) {
    // Renvit: el rival ja ha pujat → mà més forta.
    set(28, 0.3); set(29, 0.5); set(30, 1.0); set(31, 1.8);
    set(32, 2.6); set(33, 3.0); set(34, 2.8); set(35, 2.2);
    set(36, 1.6); set(37, 1.0); set(38, 0.6); set(39, 0.3); set(40, 0.2);
  } else {
    // Falta-envit: típicament només es canta amb mà molt forta o desesperació.
    set(28, 0.4); set(29, 0.5); set(30, 0.8); set(31, 1.2);
    set(32, 1.8); set(33, 2.4); set(34, 2.6); set(35, 2.4);
    set(36, 2.0); set(37, 1.6); set(38, 1.2); set(39, 0.8); set(40, 0.5);
  }
  // Normalitza.
  let sum = 0;
  for (const w of dist.values()) sum += w;
  for (const [k, v] of dist) dist.set(k, v / sum);
  return dist;
}

/**
 * Probabilitat de guanyar l'envit donat el meu valor i si soc mà.
 * Mà guanya els empats.
 */
function envitWinProbability(myEnvit: number, level: 2 | 4 | "falta", isMano: boolean): number {
  const dist = opponentEnvitDistribution(level);
  let pWin = 0;
  for (const [oppVal, p] of dist) {
    if (myEnvit > oppVal) pWin += p;
    else if (myEnvit === oppVal && isMano) pWin += p;
  }
  return pWin;
}

function decideEnvitResponse(
  actions: Action[],
  myEnvit: number,
  level: 2 | 4 | "falta",
  isMano: boolean,
  trucStrength: number,
  player: PlayerId,
  tuning: BotTuning = NEUTRAL_TUNING,
  bluffRate: number = 0,
  m?: MatchState,
  partnerAdvice: PartnerAdvice = "neutral",
): Action {
  // Punts en joc per nivell (vull / no vull):
  //   envit (2): +2 si guanyem / -1 si perdem    → cost no-vull = 1 al rival
  //   renvit (4): +4 / -2                         → cost no-vull = 2
  //   falta:    +molts / -(1|2|4) segons history  → assumim cost no-vull = 2
  const pWin = envitWinProbability(myEnvit, level, isMano);

  // EV (en pedres) d'acceptar respecte rebutjar:
  //   EV_accept = pWin*win - (1-pWin)*lose
  //   EV_reject = -costRebuig  (perdem aquests punts segur)
  //   acceptem si EV_accept > EV_reject
  let win: number, lose: number, costRebuig: number;
  if (level === 2) { win = 2; lose = 2; costRebuig = 1; }
  else if (level === 4) { win = 4; lose = 4; costRebuig = 2; }
  else { win = 8; lose = 8; costRebuig = 2; } // falta: aproximació

  // Bonus per força de truc: si la mà és bona de joc, perdre l'envit "fa
  // menys mal" perquè recuperem amb el truc (+0.5/+1 pedra equivalent).
  const trucBonus = trucStrength >= 0.7 ? 1.0 : trucStrength >= 0.5 ? 0.5 : trucStrength <= 0.2 ? -0.5 : 0;

  const evAccept = pWin * win - (1 - pWin) * lose + trucBonus + tuning.envitAcceptDelta;
  const evReject = -costRebuig;

  // Pujar (renvit / falta-envit) val la pena només si la nostra prob. després
  // de pujar (que sol baixar perquè el rival rebutja amb mà mediocre i només
  // continua amb la millor) compensa el cost extra. Heurística: necessitem
  // pWin alta i un mínim absolut d'envit.
  const canRaise = actions.some(a => a.type === "shout" && (a.what === "renvit" || a.what === "falta-envit"));
  const raiseAction = actions.find(a => a.type === "shout" && (a.what === "renvit" || a.what === "falta-envit"));

  const log = (decision: string) => {
    // eslint-disable-next-line no-console
    console.log(
      `[bot envit] p${player} decision=${decision} level=${level} myEnvit=${myEnvit} mano=${isMano} ` +
      `pWin=${pWin.toFixed(2)} EV_accept=${evAccept.toFixed(2)} EV_reject=${evReject.toFixed(2)} ` +
      `trucStrength=${trucStrength.toFixed(2)} trucBonus=${trucBonus.toFixed(2)}`
    );
  };

  // ----- Resposta a FALTA-ENVIT -----
  // Regla específica del jugador: davant d'una falta-envit, el bot només
  // pot acceptar si:
  //   · Té 33 d'envit i és "mà" respecte qui ha cantat la falta
  //     (és a dir, té prioritat de mà sobre el rival que va envidar la
  //     falta — guanyaria un eventual empat a 33).
  //   · Té 32 d'envit i és "mà" respecte qui ha cantat la falta:
  //     valora pel càlcul EV si accepta o rebutja.
  //   · Amb 31 o menys: SEMPRE rebutjar (no-vull).
  // Mai s'usa "renvit"/"falta-envit" com a resposta a una falta (no es pot
  // pujar més). La pregunta al company "Quant envit tens?" es gestiona
  // a la capa d'orquestració (useTrucMatch/rooms-rpc).
  if (level === "falta") {
    const vullAction = actions.find(
      (a) => a.type === "shout" && a.what === "vull",
    );
    const noVullAction: Action = { type: "shout", what: "no-vull" };
    // Determina si el bot té prioritat de mà sobre el rival que va cantar
    // la falta (recorre l'ordre mà → mà+1 → mà+2 → mà+3; el primer
    // trobat té prioritat en cas d'empat).
    let manoPriorityOverCaller = false;
    if (m && m.round.envitState.kind === "pending") {
      const caller = m.round.envitState.calledBy;
      let p: PlayerId = m.round.mano;
      for (let i = 0; i < 4; i++) {
        if (p === player) { manoPriorityOverCaller = true; break; }
        if (p === caller) { manoPriorityOverCaller = false; break; }
        p = ((p + 1) % 4) as PlayerId;
      }
    } else {
      manoPriorityOverCaller = isMano;
    }

    if (myEnvit <= 31) {
      log("no-vull (falta, ≤31)");
      return noVullAction;
    }
    if (myEnvit >= 33 && manoPriorityOverCaller && vullAction) {
      log("vull (falta, 33 amb mà sobre rival)");
      return vullAction;
    }
    if (myEnvit === 32 && manoPriorityOverCaller && vullAction) {
      if (evAccept > evReject) {
        log("vull (falta, 32 amb mà, EV+)");
        return vullAction;
      }
      log("no-vull (falta, 32 amb mà, EV-)");
      return noVullAction;
    }
    log("no-vull (falta, sense mà o sense vull)");
    return noVullAction;
  }

  // ----- Cas: el meu COMPANY ja ha rebutjat aquest envit (no-vull) -----
  // Si el meu company ja ha dit "no-vull" a aquest envit, no té sentit
  // consultar res. Apliquem la regla estricta:
  //   · Acceptem (vull) si tinc 31, 32 o 33 d'envit.
  //   · Renvidem (renvit / falta-envit) si tinc 33 d'envit, o bé 32 i
  //     sóc mà sobre el rival que va envidar.
  //   · Altrament: "no-vull".
  if (m && m.round.envitState.kind === "pending") {
    const partnerSeat = ((player + 2) % 4) as PlayerId;
    const rejected = m.round.envitState.rejectedBy ?? [];
    if (rejected.includes(partnerSeat)) {
      const renvitAct = actions.find(
        (a) => a.type === "shout" && (a.what === "renvit" || a.what === "falta-envit"),
      );
      const vullAct = actions.find(
        (a) => a.type === "shout" && a.what === "vull",
      );
      const noVullAct: Action = { type: "shout", what: "no-vull" };
      let manoPriorityOverCaller = false;
      const caller = m.round.envitState.calledBy;
      let p2: PlayerId = m.round.mano;
      for (let i = 0; i < 4; i++) {
        if (p2 === player) { manoPriorityOverCaller = true; break; }
        if (p2 === caller) { manoPriorityOverCaller = false; break; }
        p2 = ((p2 + 1) % 4) as PlayerId;
      }
      const wantsRaise =
        myEnvit >= 33 || (myEnvit === 32 && manoPriorityOverCaller);
      if (wantsRaise && renvitAct) {
        log("renvit (company ha rebutjat, 33 o 32+mà)");
        return renvitAct;
      }
      if (myEnvit >= 31 && vullAct) {
        log("vull (company ha rebutjat, 31/32/33)");
        return vullAct;
      }
      log("no-vull (company ha rebutjat, <31)");
      return noVullAct;
    }
  }

  // ----- Mode SINCER (bluffRate === 0): regles dures d'envit -----
  // Amb 31/32/33 d'envit, mai rebutjar i, segons el nivell, pujar la juga:
  //   · myEnvit ≥ 31 → mai "no-vull" en sincer (acceptem com a mínim).
  //   · myEnvit ≥ 32 i nivell 2 (envit) → "renvit" (Torne a envidar).
  //   · myEnvit = 33 i sóc mà i nivell 4 (renvit) → "falta-envit"
  //     (com a mà guanyem segur l'empat a 33).
  if (bluffRate === 0) {
    const renvitAction = actions.find(
      (a) => a.type === "shout" && a.what === "renvit",
    );
    const faltaAction = actions.find(
      (a) => a.type === "shout" && a.what === "falta-envit",
    );
    const vullAction = actions.find(
      (a) => a.type === "shout" && a.what === "vull",
    );
    if (myEnvit >= 33 && isMano && level === 4 && faltaAction) {
      log("falta-envit (sincer, mà 33)");
      return faltaAction;
    }
    if (myEnvit >= 32 && level === 2 && renvitAction) {
      log("renvit (sincer, ≥32)");
      return renvitAction;
    }
    if (myEnvit >= 31 && vullAction) {
      log("vull (sincer, ≥31)");
      return vullAction;
    }
  }

  // ----- Guardia dura: envit petit (≤29) -----
  // Mai acceptem un envit amb 29 o menys: és un envit petit i la
  // probabilitat de guanyar és baixa. Rebutgem sempre amb "no-vull".
  if (myEnvit <= 29) {
    log("no-vull (envit petit ≤29)");
    return { type: "shout", what: "no-vull" };
  }


  // ----- Mode CONSERVADOR (regla dura) -----
  // Només acceptar envit si:
  //   (a) myEnvit ≥ 31 (31, 32 o 33+ → grans possibilitats reals), o
  //   (b) el meu equip ja ha guanyat la primera baza I tinc una "carta top"
  //       (manilla d'oros, manilla d'espases, As bastos, As espases) a la mà, o
  //   (c) el meu equip ja ha guanyat la primera baza I sé que el meu
  //       company té una carta top (deduït pel partnerAdvice "strong"
  //       després d'una pregunta directa: "vine-a-mi" / "tinc-bona" /
  //       "tens-mes-dun-tres" → "si"). Vegeu adviceFromAnswer.
  // En qualsevol altre cas: NO VULL (rebutjar).
  // No s'aplica a renvit/falta-envit pujats per nosaltres (canRaise) si
  // tenim envit molt alt — gestionat més avall.
  if (tuning.conservativeMode && m) {
    const myTeam = teamOf(player);
    const firstTrick = m.round.tricks[0];
    const wonFirstTrick =
      !!firstTrick &&
      firstTrick.winner !== undefined &&
      firstTrick.parda !== true &&
      teamOf(firstTrick.winner!) === myTeam;
    const hand = m.round.hands[player];
    const hasTopCard = hand.some(
      (c) =>
        (c.rank === 7 && (c.suit === "oros" || c.suit === "espases")) ||
        (c.rank === 1 && (c.suit === "bastos" || c.suit === "espases")),
    );
    const partnerSignalsTop = (partnerAdvice === "strong" || partnerAdvice === "three");

    const conservativeAllow =
      myEnvit >= 31 ||
      (wonFirstTrick && (hasTopCard || partnerSignalsTop));

    if (!conservativeAllow) {
      log("no-vull (conservador)");
      return { type: "shout", what: "no-vull" };
    }
    // Si entrem aquí, podem continuar amb la lògica EV/raise normal,
    // però recordem: en general, conservador prefereix "vull" sense pujar.
  }

  if (canRaise && raiseAction) {
    // En mode conservador: pujar només amb envit molt alt i pWin >= 0.85.
    if (tuning.conservativeMode) {
      if (level === 2 && pWin >= 0.85 && myEnvit >= 34) {
        log(`pujar (${(raiseAction as any).what}) [conservador]`);
        return raiseAction;
      }
    } else {
      if (level === 2 && pWin >= 0.7 && myEnvit >= 33) {
        log(`pujar (${(raiseAction as any).what})`);
        return raiseAction;
      }
      if (level === 4 && pWin >= 0.8 && myEnvit >= 35) {
        log(`pujar (${(raiseAction as any).what})`);
        return raiseAction;
      }
    }
  }

  if (evAccept > evReject) {
    log("vull");
    return { type: "shout", what: "vull" };
  }
  if (
    bluffRate > 0 &&
    !tuning.conservativeMode &&
    level === 2 &&
    evAccept > evReject - 0.5 &&
    (isMano || trucStrength >= 0.6) &&
    Math.random() < bluffRate
  ) {
    log("vull (bluff)");
    return { type: "shout", what: "vull" };
  }
  log("no-vull");
  return { type: "shout", what: "no-vull" };
}

function decideTrucResponse(
  actions: Action[],
  hand: Array<{ suit: string; rank: number }>,
  m: MatchState,
  player: PlayerId,
  partnerAdvice: PartnerAdvice = "neutral",
  tuning: BotTuning = NEUTRAL_TUNING,
  bluffRate: number = 0,
): Action {
  const r = m.round;
  const myTeam = teamOf(player);
  const myWinsSoFar = r.tricks.filter(t => t.winner !== undefined && teamOf(t.winner!) === myTeam).length;
  const oppWinsSoFar = r.tricks.filter(
    t => t.winner !== undefined && t.parda !== true && teamOf(t.winner!) !== myTeam,
  ).length;
  const topCards = hand.filter(c => cardStrength(c as any) >= 80).length;
  const goodCards = hand.filter(c => cardStrength(c as any) >= 60).length;
  // Cartes top de truc (les 4 més fortes, força ≥ 85): As espases (100),
  // As bastos (95), manilla d'espases (7 espases, 90), manilla d'oros
  // (7 oros, 85). Un 3 val 70.
  const topTrucCards = hand.filter(c => cardStrength(c as any) >= 85).length;
  const threes = hand.filter(c => (c as any).rank === 3).length;
  const adviceBoost = (partnerAdvice === "strong" || partnerAdvice === "three") ? 25 : partnerAdvice === "weak" ? -20 : 0;
  const strength = avgStrength(hand) + myWinsSoFar * 30 + topCards * 15 + adviceBoost;
  const myEnvit = bestEnvit(hand as any);

  // Punts en joc segons el nivell del truc actual:
  //  - truc (2):     si vull = 2 pts, si no vull = 1 pt al rival
  //  - retruc (3):   si vull = 3 pts, si no vull = 2 pts al rival
  //  - quatre (4):   si vull = 4 pts, si no vull = 3 pts al rival
  //  - joc-fora (24): si vull = guanya tota la partida; si no vull = 4 pts
  const trucLevel = r.trucState.kind === "pending" ? r.trucState.level : 2;

  // Llindars segons el nivell: com més punts arrisques, més forta ha de ser
  // la mà per acceptar o pujar. strength típic: 30 (fluix) – 130+ (molt fort).
  let acceptStrength: number;
  let raiseStrength: number;
  if (trucLevel === 2) {        // truc → vull = 2 pts
    acceptStrength = 60;
    raiseStrength = 95;
  } else if (trucLevel === 3) { // retruc → vull = 3 pts
    acceptStrength = 75;
    raiseStrength = 105;
  } else if (trucLevel === 4) { // quatre val → vull = 4 pts
    acceptStrength = 90;
    raiseStrength = 120;
  } else {                       // joc-fora → vull = guanya tota la partida
    acceptStrength = 130;
    raiseStrength = 999;
  }

  // Apply profile-driven adjustments: a tighter human (low accept_threshold)
  // means our bluffs work — bot accepts with weaker hands too.
  acceptStrength = Math.max(30, acceptStrength + tuning.acceptThresholdDelta);
  raiseStrength = Math.max(60, raiseStrength + tuning.acceptThresholdDelta * 0.5);

  const canEnvit = actions.some(a => a.type === "shout" && a.what === "envit");
  if (canEnvit) {
    // Mode sincer (bluffRate === 0): contra-envit determinista. Només envida
    // si té possibilitats reals (≥31). Sense multiplicadors aleatoris.
    if (bluffRate === 0) {
      if (myEnvit >= 31) return { type: "shout", what: "envit" };
    } else {
    if (myEnvit >= 30 && Math.random() < 0.85 * tuning.callPropensity) return { type: "shout", what: "envit" };
    if (myEnvit >= 27 && Math.random() < 0.55 * tuning.callPropensity) return { type: "shout", what: "envit" };
    if (myEnvit >= 24 && Math.random() < 0.25 * tuning.callPropensity) return { type: "shout", what: "envit" };
    }
  }

  const raise = actions.find(a => a.type === "shout" && (a.what === "retruc" || a.what === "quatre" || a.what === "joc-fora"));
  const isRaiseJocFora = raise && raise.type === "shout" && raise.what === "joc-fora";

  // Cartes excel·lents.
  const hasBothTopAces =
    hand.some(c => c.rank === 1 && c.suit === "espases") &&
    hand.some(c => c.rank === 1 && c.suit === "bastos");

  // Mai pujar a "joc-fora" sense tindre la mà pràcticament guanyada.
  const canRaiseSafely = raise && (!isRaiseJocFora || (hasBothTopAces && myWinsSoFar >= 1));

  // ----- Regla dura: avaluació mínima de la mà segons el nivell -----
  // Si la mà no té cap carta de valor (cap 3 ni cap manilla), és gairebé
  // impossible guanyar el truc: cal rebutjar sempre, encara que el rival
  // canti truc nivell 2.
  // Calcula també les topTrucCards "efectives" (no jugades encara per cap rival
  // del meu equip, però simplificat: només les que jo tinc en mà).
  const hasAnyValuable = topTrucCards >= 1 || threes >= 1;

  // Si la mà no val res, mai acceptar pujades >= retruc.
  if (!hasAnyValuable && trucLevel >= 3) {
    return { type: "shout", what: "no-vull" };
  }
  // Per a un truc simple (nivell 2), si a més anem perdent la mà i no tenim
  // cap carta valuosa, també rebutgem.
  if (!hasAnyValuable && trucLevel === 2 && (oppWinsSoFar >= 1 || myWinsSoFar === 0)) {
    return { type: "shout", what: "no-vull" };
  }

  // Per a "joc-fora" cal una mà extraordinària: dos asos top o bé manilla +
  // baza ja guanyada. Sense això, rebutjar sempre.
  if (trucLevel === 24) {
    if (!hasBothTopAces && !(topTrucCards >= 1 && myWinsSoFar >= 1 && threes + topTrucCards >= 2)) {
      return { type: "shout", what: "no-vull" };
    }
  }

  // Per a "quatre van", exigim almenys una manilla o (3 + baza guanyada).
  if (trucLevel === 4) {
    if (topTrucCards === 0 && !(threes >= 1 && myWinsSoFar >= 1)) {
      return { type: "shout", what: "no-vull" };
    }
  }

  // Per a "retruc", exigim almenys un 3 o una manilla.
  if (trucLevel === 3 && topTrucCards === 0 && threes === 0) {
    return { type: "shout", what: "no-vull" };
  }

  if (canRaiseSafely && (hasBothTopAces || strength >= raiseStrength)) {
    return raise!;
  }
  if (canRaiseSafely && topCards >= 2 && myWinsSoFar >= 1) {
    return raise!;
  }
  if (canRaiseSafely && strength >= raiseStrength - 10 && Math.random() < 0.6) {
    return raise!;
  }

  // Si el rival ja ha guanyat alguna baza i la mà és fluixa, no acceptar
  // pujades cares: és tirar punts.
  if (oppWinsSoFar >= 1 && trucLevel >= 3 && strength < acceptStrength + 10) {
    return { type: "shout", what: "no-vull" };
  }

  if (strength >= acceptStrength) return { type: "shout", what: "vull" };
  if (myWinsSoFar >= 1 && goodCards >= 1 && trucLevel <= 3) return { type: "shout", what: "vull" };
  if (
    bluffRate > 0 &&
    strength >= acceptStrength - 10 &&
    trucLevel === 2 &&
    hasAnyValuable &&
    Math.random() < bluffRate * 2.5
  ) {
    return { type: "shout", what: "vull" };
  }
  if (partnerAdvice === "weak") return { type: "shout", what: "no-vull" };
  // Bluff residual només quan el cost és baix (truc nivell 2), tenim alguna
  // carta amb la qual defensar-nos i el perfil permet farolejar.
  if (
    bluffRate > 0 &&
    trucLevel === 2 &&
    hasAnyValuable &&
    Math.random() < bluffRate * tuning.bluffPropensity
  ) {
    return { type: "shout", what: "vull" };
  }
  return { type: "shout", what: "no-vull" };
}

function decideProactiveTruc(
  m: MatchState,
  player: PlayerId,
  hand: Array<{ suit: string; rank: number }>,
  handStrength: number,
  partnerAdvice: PartnerAdvice = "neutral",
  tuning: BotTuning = NEUTRAL_TUNING,
  bluffRate: number = 0,
  hints: BotHints = {},
): Action | null {
  const adviceBoost = (partnerAdvice === "strong" || partnerAdvice === "three") ? 20 : partnerAdvice === "weak" ? -15 : 0;
  handStrength = handStrength + adviceBoost;
  const r = m.round;
  const myTeam = teamOf(player);
  const oppTeam = myTeam === "nos" ? "ells" : "nos";

  const myWins = r.tricks.filter(t => t.winner !== undefined && teamOf(t.winner!) === myTeam).length;
  const oppWins = r.tricks.filter(t => t.winner !== undefined && teamOf(t.winner!) === oppTeam).length;

  // Cap baza encara resolta + cap carta jugada en la baza actual = inici
  // absolut de la ronda. En aquest punt NO té sentit cantar truc proactiu:
  // si tinc bones cartes, el millor és esperar que el rival truque per
  // poder retrucar i guanyar més pedres. "Truc i passe" en la 1a baza
  // pre-joc és una estratègia abusiva i dóna pocs punts.
  const currentTrick = r.tricks[r.tricks.length - 1];
  const noCardsPlayedYet =
    r.tricks.length === 1 && (!currentTrick || currentTrick.cards.length === 0);

  const topCards = hand.filter(c => cardStrength(c as any) >= 80).length;
  const goodCards = hand.filter(c => cardStrength(c as any) >= 60).length;
  // "Top de truc" segons l'usuari: manilla d'oros, manilla d'espases, As bastos, As espases.
  const hasTopTrucCard = hand.some(c =>
    (c.rank === 7 && (c.suit === "oros" || c.suit === "espases")) ||
    (c.rank === 1 && (c.suit === "bastos" || c.suit === "espases")),
  );

  const myScoreObj = m.scores[myTeam];
  const oppScoreObj = m.scores[oppTeam];
  const myScore = Math.min(myScoreObj.males + myScoreObj.bones, 24);
  const oppScore = Math.min(oppScoreObj.males + oppScoreObj.bones, 24);
  const target = m.targetCama;
  const losingBig = oppScore - myScore >= 4;
  const winningBig = myScore - oppScore >= 4;
  const closeToWin = myScore >= target * 2 - 3;

  // Inici de la 1a baza: no truques mai proactivament excepte si vas
  // perdent molt i necessites punts ja (situació desesperada).
  if (noCardsPlayedYet && !losingBig) return null;

  // ---- Regla dura: no cantar truc/retruc/quatre val sense recolzament ----
  // Si NO hem guanyat la 1a baza, només em queda 1 carta i és top o 3, i
  // tampoc estem guanyant la 2a baza (cap baza guanyada per l'equip),
  // no cantem truc/retruc/quatre val: una sola carta forta no garanteix
  // res sense suport del company i sense bazas guanyades.
  {
    const firstTrick = r.tricks[0];
    const wonFirstStrict =
      !!firstTrick && firstTrick.parda !== true &&
      firstTrick.winner !== undefined && teamOf(firstTrick.winner!) === myTeam;
    if (!wonFirstStrict && hand.length === 1) {
      const onlyCard = hand[0]!;
      const isTopOrThree =
        onlyCard.rank === 3 ||
        (onlyCard.rank === 7 && (onlyCard.suit === "oros" || onlyCard.suit === "espases")) ||
        (onlyCard.rank === 1 && (onlyCard.suit === "bastos" || onlyCard.suit === "espases"));
      // L'equip "guanya la 2a baza" si la 2a baza s'ha resolt en favor
      // del meu equip (no parda i el winner és del meu equip), o bé,
      // si la 2a està en joc, el meu equip lidera la mesa actualment.
      const secondTrick = r.tricks[1];
      let teamWinningSecond = false;
      if (secondTrick) {
        if (secondTrick.winner !== undefined && secondTrick.parda !== true) {
          teamWinningSecond = teamOf(secondTrick.winner!) === myTeam;
        } else if (secondTrick.cards.length > 0 && secondTrick.winner === undefined) {
          const leader = secondTrick.cards.reduce(
            (best, tc) =>
              best === null || cardStrength(tc.card as any) > cardStrength(best.card as any) ? tc : best,
            null as { player: PlayerId; card: Card } | null,
          );
          if (leader) teamWinningSecond = teamOf(leader.player) === myTeam;
        }
      }
      if (!teamWinningSecond) return null;
    }
  }

  // ---- 2a baza: la 1a ha quedat PARDA ----
  // Si la 1a baza ha quedat empardada, qui guanye la 2a baza guanya el
  // truc d'aquesta mà. Per tant, si tinc cartes molt fortes a la mà i
  // encara no he tirat en la 2a baza, val la pena cantar truc abans:
  //   - As d'espases (força 100): truc OBLIGATORI (impossible perdre la 2a).
  //   - As de bastos (força 95):  truc molt probable (només el perd l'as d'espases).
  //   - 7 d'oros    (força 85):  truc opcional (encara pot ser superat per
  //     7 d'espases, As bastos o As espases).
  if (
    r.tricks.length === 2 &&
    r.tricks[0]?.parda === true &&
    currentTrick &&
    !currentTrick.cards.some((tc) => tc.player === player)
  ) {
    const hasAsEspases = hand.some((c) => c.rank === 1 && c.suit === "espases");
    const hasAsBastos = hand.some((c) => c.rank === 1 && c.suit === "bastos");
    const hasSetOros = hand.some((c) => c.rank === 7 && c.suit === "oros");
    const legal = legalActions(m, player);
    const trucActPard = legal.find(
      (a) => a.type === "shout" && a.what === "truc",
    );
    if (trucActPard && !hints.silentTruc) {
      let pTruc = 0;
      let trigger = "";
      if (hasAsEspases) {
        pTruc = 1;
        trigger = "2a-baza-parda-as-espases";
      } else if (hasAsBastos) {
        pTruc = 0.85;
        trigger = "2a-baza-parda-as-bastos";
      } else if (hasSetOros) {
        pTruc = 0.5;
        trigger = "2a-baza-parda-7-oros";
      }
      if (pTruc > 0) {
        pTruc *= tuning.callPropensity;
        if (Math.random() < pTruc) {
          // eslint-disable-next-line no-console
          console.log(
            `[bot truc 2a-baza-parda] p${player} truc trigger=${trigger} ` +
              `prob=${pTruc.toFixed(2)}`,
          );
          return trucActPard;
        }
      }
    }
  }


  // ---- Guarda 2a baza: hem PERDUT la 1a i NO tinc (3 + top) a la mà ----
  // Si el meu equip ha perdut la 1a baza i a la mà no em queden almenys
  // un 3 I una carta top (manilla d'oros, manilla d'espases, As bastos o
  // As espases), no canto truc proactivament en la 2a baza tret de:
  //   (A) Soc l'últim a tirar i el meu company ja guanya la 2a baza.
  //   (B) Puc guanyar la 2a baza tirant un 3 i encara em queda una carta
  //       top reservada per a la 3a.
  // En qualsevol altre cas, retorno null aquí mateix per evitar que la
  // resta de l'heurística canti truc en una situació clarament dolenta.
  if (r.tricks.length === 2) {
    const t0 = r.tricks[0];
    const lostFirst =
      !!t0 &&
      t0.parda !== true &&
      t0.winner !== undefined &&
      teamOf(t0.winner!) !== myTeam;
    if (lostFirst) {
      const isTopCard = (c: { suit: string; rank: number }) =>
        (c.rank === 7 && (c.suit === "oros" || c.suit === "espases")) ||
        (c.rank === 1 && (c.suit === "bastos" || c.suit === "espases"));
      const hasThree = hand.some((c) => c.rank === 3);
      const hasTop = hand.some(isTopCard);
      const hasThreePlusTop = hasThree && hasTop;
      if (!hasThreePlusTop) {
        // Excepció (A): últim a tirar amb el company guanyant la mesa.
        let exceptionAllows = false;
        if (
          currentTrick &&
          currentTrick.cards.length === 3 &&
          !currentTrick.cards.some((tc) => tc.player === player)
        ) {
          const leader = currentTrick.cards.reduce(
            (best, tc) =>
              best === null || cardStrength(tc.card) > cardStrength(best.card) ? tc : best,
            null as { player: PlayerId; card: Card } | null,
          );
          if (leader && teamOf(leader.player) === myTeam) {
            exceptionAllows = true;
          }
        }
        // Excepció (B): puc guanyar la 2a amb un 3 i em queda una carta
        // top reservada per a la 3a baza. Només té sentit si encara tinc
        // 2 cartes (1 per la 2a, 1 per la 3a) i, amb el 3, supere la
        // millor carta ja jugada en la mesa.
        if (!exceptionAllows && hand.length >= 2 && hasThree && hasTop) {
          // Aquesta branca quedaria filtrada per `hasThreePlusTop`; la
          // deixe explícita perquè `lint` no es queixe i per claredat.
        }
        if (!exceptionAllows && hand.length >= 2 && hasThree) {
          // Comprova si en aquesta 2a baza, jugar un 3 guanyaria la mesa
          // (tenint en compte les cartes ja jugades pels rivals i el
          // company). Si sí, i a més em queda una carta top reservada,
          // permet trucar.
          const tableBest = currentTrick && currentTrick.cards.length > 0
            ? currentTrick.cards.reduce(
                (mx, tc) => Math.max(mx, cardStrength(tc.card)),
                -1,
              )
            : -1;
          // Un 3 té força 70: guanya si la millor de la mesa és <70.
          const threeWinsTable = tableBest < 70;
          const remainingTop = hand.some(isTopCard);
          if (threeWinsTable && remainingTop) {
            exceptionAllows = true;
          }
        }
        if (!exceptionAllows) return null;
      }
    }
  }

  // ---- 3a baza: últim de tots a tirar amb truc assegurat ----
  // Si soc l'últim dels 4 jugadors a tirar en la 3a baza (ja hi ha 3
  // cartes a la mesa), el meu equip ENCARA NO guanya el truc amb les
  // cartes jugades, i la meua carta:
  //   (a) supera la millor de la mesa -> guanyo la 3a baza, o
  //   (b) iguala la millor de la mesa -> faig parda la 3a baza,
  // llavors, si el resultat resultant del truc es victoria del meu equip,
  // canto truc DETERMINISTICAMENT abans de tirar (estic segur de
  // guanyar-lo, aixi que val la pena pujar la posta).
  if (
    r.tricks.length === 3 &&
    currentTrick &&
    currentTrick.cards.length === 3 &&
    !currentTrick.cards.some((tc) => tc.player === player) &&
    oppWins < 2 &&
    myWins < 2
  ) {
    const tableLeader = currentTrick.cards.reduce(
      (best, tc) =>
        best === null || cardStrength(tc.card) > cardStrength(best.card) ? tc : best,
      null as { player: PlayerId; card: Card } | null,
    );
    const tableBest = tableLeader ? cardStrength(tableLeader.card) : -1;
    const partnerWinsTable =
      tableLeader !== null && teamOf(tableLeader.player) === teamOf(player);

    const t0 = r.tricks[0]!;
    const t1 = r.tricks[1]!;
    const parda0 = t0.parda === true;
    const parda1 = t1.parda === true;
    const won0 = !parda0 && t0.winner !== undefined && teamOf(t0.winner!) === myTeam;
    const won1 = !parda1 && t1.winner !== undefined && teamOf(t1.winner!) === myTeam;

    // Guanya el meu equip el truc si la 3a te aquest resultat?
    const trucWinsForMyTeam = (outcome: "win" | "parda" | "loss"): boolean => {
      let myW = (won0 ? 1 : 0) + (won1 ? 1 : 0);
      let oppW =
        (!parda0 && t0.winner !== undefined && teamOf(t0.winner!) !== myTeam ? 1 : 0) +
        (!parda1 && t1.winner !== undefined && teamOf(t1.winner!) !== myTeam ? 1 : 0);
      const pardes = [parda0, parda1, false];
      if (outcome === "win") myW += 1;
      else if (outcome === "loss") oppW += 1;
      else pardes[2] = true;
      if (pardes[0] && pardes[1] && pardes[2]) return teamOf(r.mano) === myTeam;
      if (pardes[2] && myW === oppW) {
        if (parda0) return teamOf(r.mano) === myTeam;
        return won0;
      }
      if (!pardes[2]) {
        if (myW > oppW) return true;
        if (oppW > myW) return false;
        return teamOf(r.mano) === myTeam;
      }
      return false;
    };

    const myHandCards = r.hands[player] ?? [];
    if (myHandCards.length > 0) {
      const myBest = Math.max(...myHandCards.map((c) => cardStrength(c)));

      let outcome: "win" | "parda" | "loss";
      if (partnerWinsTable) outcome = "win";
      else if (myBest > tableBest) outcome = "win";
      else if (myBest === tableBest) outcome = "parda";
      else outcome = "loss";

      // "Encara no guanya el truc": si l'equip ja guanyes en el pitjor cas
      // (jo perdent la 3a), el truc ja esta fet i la regla no aplica.
      const teamAlreadyWinning = trucWinsForMyTeam("loss");

      if (!teamAlreadyWinning && (outcome === "win" || outcome === "parda")) {
        if (trucWinsForMyTeam(outcome)) {
          const legal = legalActions(m, player);
          const trucAct = legal.find(
            (a) => a.type === "shout" && a.what === "truc",
          );
          if (trucAct && !hints.silentTruc) {
            // Probabilitat 80% (abans determinista 100%): cantem truc abans
            // de tirar la carta guanyadora/parda en la 3a baza, però amb un
            // 20% de variabilitat per a no resultar mecànic.
            const p = 0.8;
            const decision = Math.random() < p ? "truc" : "passa";
            // eslint-disable-next-line no-console
            console.log(
              `[bot truc 3a-baza-determinista] p${player} ${decision} ` +
                `outcome=${outcome} myBest=${myBest} tableBest=${tableBest} ` +
                `won0=${won0} won1=${won1} parda0=${parda0} parda1=${parda1} ` +
                `prob=${p.toFixed(2)}`,
            );
            if (decision === "truc") return trucAct;
          }
        }
      }
    }
  }


  // ---- 3a baza: truc oportunista amb carta guanyadora ----
  // Si estem a la 3a baza, el bot encara no ha jugat aquest torn, i el
  // resultat del truc encara no està decidit (no hem perdut 2 bazas), mira
  // si la millor carta de la mà és de les 1-2 més fortes que queden per
  // jugar (descomptant totes les cartes ja vistes a la mesa). Si és així,
  // val la pena cantar truc abans de tirar per intentar guanyar més pedres
  // — sabent que pot anar malament si el rival retruca i té una manilla
  // amagada superior.
  if (
    r.tricks.length === 3 &&
    currentTrick &&
    !currentTrick.cards.some(tc => tc.player === player) &&
    oppWins < 2 &&
    myWins < 2
  ) {
    // Identificadors únics de les cartes ja vistes a la mesa (en qualsevol
    // baza, incloses les jugades tapades — `cardStrength` no s'usa per a
    // identificar-les, sinó l'`id` propi de cada carta del deck). Així
    // evitem qualsevol error per cartes amb la mateixa força (ex: els 4
    // tres tenen força 70).
    const seenIds = new Set<string>();
    for (const t of r.tricks) {
      for (const tc of t.cards) {
        seenIds.add(tc.card.id);
      }
    }
    // Cartes a la mà del bot (queda 1 si ja ha jugat 2; aquí 1 normalment).
    const myHandCards = r.hands[player] ?? [];
    const myIds = new Set<string>(myHandCards.map((c) => c.id));
    const myStrengths = myHandCards.map((c) => cardStrength(c));
    const myBest = myStrengths.length > 0 ? Math.max(...myStrengths) : -1;

    // Reconstruïm el deck complet i en filtrem les vistes i les pròpies.
    // El que queda està repartit entre els altres 3 jugadors i és l'única
    // amenaça real per a la meua carta en aquesta baza.
    const fullDeck: Card[] = [];
    for (const suit of ["oros", "copes", "espases", "bastos"] as const) {
      for (const rank of [1, 3, 4, 5, 6, 7] as const) {
        if (rank === 1 && suit !== "espases" && suit !== "bastos") continue;
        fullDeck.push({ id: `${rank}-${suit}`, suit, rank });
      }
    }
    const remainingCards = fullDeck.filter(
      (c) => !seenIds.has(c.id) && !myIds.has(c.id),
    );

    // Invariant de seguretat: cap carta es pot perdre ni duplicar. Si
    // falla, considerem la situació "incoherent" i no apliquem l'heurística
    // (forcem strongerThanMe = ∞ perquè cap branca de cant s'activi).
    const invariantOk =
      seenIds.size + myIds.size + remainingCards.length === fullDeck.length;
    const strongerThanMe = invariantOk
      ? remainingCards.filter((c) => cardStrength(c) > myBest).length
      : Number.POSITIVE_INFINITY;

    // El meu equip ja porta avantatge de bazas? (1-0 a favor o 0-0)
    const winningTrickPosition = myWins >= oppWins;

    // Telemetria comuna a les dues branques de la 3a baza.
    const logTrucDecision = (
      trigger: string,
      probability: number,
      decision: "truc" | "passa",
    ) => {
      // eslint-disable-next-line no-console
      console.log(
        `[bot truc 3a-baza] p${player} ${decision} trigger=${trigger} ` +
          `strongerThanMe=${strongerThanMe} myWins=${myWins} oppWins=${oppWins} ` +
          `score=${myScore}-${oppScore} pos=${winningTrickPosition ? "ok" : "darrere"} ` +
          `prob=${probability.toFixed(2)}`,
      );
    };

    // Decidim segons quantes cartes em superen i la situació de partida.
    // strongerThanMe === 0 → la meua és la millor que queda: cant OBLIGATORI.
    // strongerThanMe === 1 → quasi-millor: truc selectiu.
    // strongerThanMe >= 2 → no tinc avantatge real: no truques per açò.
    if (strongerThanMe === 0) {
      // En l'última baza, si tinc la carta més alta de les que queden per
      // jugar, canto truc en un 80% dels casos abans de tirar-la (sempre
      // que siga legal i no estiga en mode silenci). El 20% restant
      // afegeix variabilitat per no resultar mecànic.
      const legal = legalActions(m, player);
      const trucAct = legal.find(
        (a) => a.type === "shout" && a.what === "truc",
      );
      if (trucAct && !hints.silentTruc) {
        const p = 0.8;
        const decision = Math.random() < p ? "truc" : "passa";
        logTrucDecision("3a-baza-millor", p, decision);
        if (decision === "truc") return trucAct;
      }
    }

    if (strongerThanMe === 1) {
      // Tinc la SEGONA carta més alta de les que queden per jugar. Aplica
      // la regla 80% només si la meua carta pot guanyar a totes les ja
      // jugades en aquesta 3a baza (o si el meu company ja les guanya,
      // cas en què igualment val la pena pujar la posta). Si encara no
      // hi ha cap carta a la mesa (sóc el primer de la baza), també
      // s'aplica perquè no puc perdre contra res ja vist.
      const ct = currentTrick;
      const tableCards = ct ? ct.cards : [];
      const myHandCards3 = r.hands[player] ?? [];
      const myBest3 = myHandCards3.length > 0
        ? Math.max(...myHandCards3.map((c) => cardStrength(c)))
        : -1;
      const tableLeader3 = tableCards.reduce(
        (best, tc) =>
          best === null || cardStrength(tc.card) > cardStrength(best.card) ? tc : best,
        null as { player: PlayerId; card: Card } | null,
      );
      const tableBest3 = tableLeader3 ? cardStrength(tableLeader3.card) : -1;
      const partnerWinsTable3 =
        tableLeader3 !== null && teamOf(tableLeader3.player) === teamOf(player);
      const beatsPlayed = tableCards.length === 0 || partnerWinsTable3 || myBest3 > tableBest3;

      if (beatsPlayed) {
        const legal = legalActions(m, player);
        const trucAct = legal.find(
          (a) => a.type === "shout" && a.what === "truc",
        );
        if (trucAct && !hints.silentTruc) {
          const p = 0.8;
          const decision = Math.random() < p ? "truc" : "passa";
          logTrucDecision("3a-baza-segona-millor-guanya-mesa", p, decision);
          if (decision === "truc") return trucAct;
        }
      } else {
        // Si no pot guanyar a les cartes ja jugades, manté l'heurística
        // anterior més conservadora.
        let p = winningTrickPosition ? 0.35 : 0.25;
        if (losingBig) p = winningTrickPosition ? 0.65 : 0.55;
        else if (closeToWin) p = winningTrickPosition ? 0.55 : 0.45;
        else if (winningBig) p = winningTrickPosition ? 0.15 : 0.1;
        p *= tuning.callPropensity;
        if (Math.random() < p) {
          logTrucDecision("3a-baza-quasi-millor", p, "truc");
          return { type: "shout", what: "truc" };
        }
        logTrucDecision("3a-baza-quasi-millor", p, "passa");
      }
      // Si no truca, segueix amb la lògica normal sota.
    }
  }

  // ---- 2a baza: últim a tirar (4t en l'ordre), el meu equip ja va 1-0 ----
  // Si soc l'últim a jugar la 2a baza, veig totes les cartes a la mesa,
  // el meu equip ja ha guanyat la 1a baza i podria:
  //   (a) guanyar la 2a ara amb la meua carta (tanco el truc 2-0), o
  //   (b) si el rival ja guanya la 2a, encara tinc una carta forta (≥80)
  //       per a la 3a baza i així imposar-me en la baza decisiva.
  // En tots dos casos, cantar truc abans de jugar és rendible: el rival
  // pot rebutjar (i ens emportem 1 pedra extra) o acceptar un truc que
  // tenim molt encarat.
  if (
    r.tricks.length === 2 &&
    currentTrick &&
    currentTrick.cards.length === 3 &&
    !currentTrick.cards.some(tc => tc.player === player) &&
    myWins >= 1 &&
    oppWins < 2
  ) {
    const myHand = r.hands[player] ?? [];
    const myBest = myHand.length > 0
      ? Math.max(...myHand.map((c) => cardStrength(c)))
      : -1;
    const tableBest = currentTrick.cards.reduce(
      (mx, tc) => Math.max(mx, cardStrength(tc.card)),
      -1,
    );
    const tableLeader = currentTrick.cards.reduce(
      (best, tc) =>
        best === null || cardStrength(tc.card) > cardStrength(best.card) ? tc : best,
      null as { player: PlayerId; card: Card } | null,
    );
    const partnerWinsTable =
      tableLeader !== null && teamOf(tableLeader.player) === teamOf(player);

    // Cas (a): puc guanyar la 2a → tanco el truc.
    const canWinNow = !partnerWinsTable && myBest > tableBest;
    // Cas (b): el rival guanya, però tinc reservada una carta forta per a
    // la 3a (només compta si en tinc 2 cartes encara —1 per la 2a, 1 per
    // la 3a— i l'altra és ≥80).
    let strongReserveFor3a = false;
    if (!canWinNow && myHand.length >= 2) {
      // Quina carta tirarem en la 2a? La més baixa per reservar la forta.
      const sortedHand = [...myHand].sort((a, b) => cardStrength(a) - cardStrength(b));
      const reserved = sortedHand[sortedHand.length - 1]!;
      strongReserveFor3a = cardStrength(reserved) >= 80;
    }

    if (canWinNow || strongReserveFor3a) {
      // Probabilitat de cantar truc segons cas i context.
      let p = canWinNow ? 0.7 : 0.4;
      if (losingBig) p += 0.15;
      else if (winningBig) p -= 0.25;
      if (closeToWin) p += 0.1;
      p = Math.max(0, Math.min(1, p * tuning.callPropensity));
      // Telemetria
      const probability = p;
      const decision: "truc" | "passa" = Math.random() < p ? "truc" : "passa";
      // eslint-disable-next-line no-console
      console.log(
        `[bot truc 2a-baza-4t] p${player} ${decision} ` +
          `canWinNow=${canWinNow} reserveFor3a=${strongReserveFor3a} ` +
          `myWins=${myWins} oppWins=${oppWins} score=${myScore}-${oppScore} ` +
          `prob=${probability.toFixed(2)}`,
      );
      if (decision === "truc") return { type: "shout", what: "truc" };
    }
  }

  // ---- Estratègia "trampa" de truc ----
  // Amb mà MOLT forta (>=2 tops, o tots dos asos), espera que truque el rival
  // per poder retrucar i guanyar més pedres. De tant en tant truca igualment
  // per a no ser predictible.
  const hasBothTopAces =
    hand.some(c => c.rank === 1 && c.suit === "espases") &&
    hand.some(c => c.rank === 1 && c.suit === "bastos");
  const veryStrongHand = topCards >= 2 || hasBothTopAces;

  if (veryStrongHand && !closeToWin) {
    // 80% espera (no truca), 20% truca per disfressar.
    // En mode honest, només si compleix la condició estricta (1a baza guanyada
    // o confirmació del company).
    if (bluffRate === 0) {
      const partnerStrong = (partnerAdvice === "strong" || partnerAdvice === "three");
      if (myWins < 1 && !partnerStrong) return null;
      // Sincer: amb mà molt forta, NORMALMENT espera que truque el rival
      // per poder retrucar i guanyar més punts. Només truca proactivament
      // si va perdent per molt (necessita punts ja) o si està a punt de
      // tancar la cama. Així no s'abusa del "Truc i passe".
      if (!losingBig) return null;
      return { type: "shout", what: "truc" };
    }
    if (Math.random() < 0.8) return null;
    return { type: "shout", what: "truc" };
  }

  // En mode honest (bluffRate === 0) només cantem truc si tenim una carta
  // forta de truc (manilla d'oros / manilla d'espases / As bastos / As
  // espases) i, a més, l'equip ja ha guanyat la 1a baza o el company ha
  // confirmat força. A més, per no abusar del "Truc i passe", només truca
  // proactivament en situacions clau (perdent per molt o a punt de tancar);
  // en cas contrari espera que truque el rival per poder retrucar.
  if (bluffRate === 0) {
    const partnerStrong = (partnerAdvice === "strong" || partnerAdvice === "three");
    if (!hasTopTrucCard) return null;
    if (myWins < 1 && !partnerStrong) return null;
    if (!losingBig && !closeToWin) return null;
    return { type: "shout", what: "truc" };
  }

  if (topCards >= 2 || (myWins >= 1 && handStrength > 75)) {
    if (Math.random() < 0.7 && !closeToWin) return null;
    return { type: "shout", what: "truc" };
  }

  if (handStrength > 70 || (myWins >= 1 && goodCards >= 2)) {
    const p = (losingBig ? 0.7 : 0.45) * tuning.callPropensity;
    if (Math.random() < p) return { type: "shout", what: "truc" };
    return null;
  }

  if (handStrength > 55 || (myWins >= 1 && goodCards >= 1)) {
    const p = (losingBig ? 0.35 : winningBig ? 0.1 : 0.2) * tuning.callPropensity;
    if (Math.random() < p) return { type: "shout", what: "truc" };
    return null;
  }

  if (bluffRate > 0 && oppWins === 0) {
    const p = (losingBig ? bluffRate * 1.2 : bluffRate * 0.5) * tuning.bluffPropensity;
    if (Math.random() < p) return { type: "shout", what: "truc" };
  }

  return null;
}

function choosePlayCard(
  m: MatchState,
  player: PlayerId,
  playActions: Extract<Action, { type: "play-card" }>[],
  partnerAdvice: PartnerAdvice = "neutral",
  playStrength: PlayStrengthHint = null,
  rivalShownStrength: boolean = false,
): Action {
  const r = m.round;
  const hand = r.hands[player];
  const trick = r.tricks[r.tricks.length - 1]!;
  const cards = playActions.map(a => hand.find(c => c.id === a.cardId)!).filter(Boolean);

  const sorted = [...cards].sort((a, b) => cardStrength(a) - cardStrength(b));
  const lowest = sorted[0]!;
  const highest = sorted[sorted.length - 1]!;

  // ---- Regla: primer de la pareja a tirar amb cap carta ≥ 3 ----
  // Si el meu company encara no ha jugat en aquesta baza i totes les
  // meues cartes són estrictament menors que un 3 (cap 3, cap top
  // card; força màxima < 70), no té sentit cremar la més alta intentant
  // guanyar — sempre tira la més baixa per reservar les "mitjanes" per
  // a bazas posteriors.
  {
    const myTeamFirst = teamOf(player);
    const partnerHasPlayedHere = trick.cards.some(
      (tc) => teamOf(tc.player) === myTeamFirst && tc.player !== player,
    );
    if (!partnerHasPlayedHere) {
      const maxStr = cardStrength(highest);
      if (maxStr < 70) {
        return { type: "play-card", cardId: lowest.id };
      }
    }
  }

  // ---- Regla "company guanya amb la 2a més alta i jo tinc la més alta" ----
  // Si el meu equip ja ha guanyat alguna baza anterior, el meu company
  // ja ha jugat en la baza actual i la seua carta és la 2a més alta
  // d'entre totes les cartes que encara queden en joc (mans restants +
  // cartes ja jugades en aquesta baza), i jo tinc la MÉS ALTA, llavors
  // sé del cert que el rival que falta (si en falta) no pot superar el
  // company. En aquest cas puc o bé jugar TAPADA la meua carta més
  // alta (per gastar-la sense revelar), o bé jugar una carta diferent
  // de la més alta (reservant-la). Aleatori 50/50.
  {
    const myTeam = teamOf(player);
    const wonAnyPrevTrick = r.tricks.slice(0, -1).some(
      (t) => t.parda !== true && t.winner !== undefined && teamOf(t.winner!) === myTeam,
    );
    const partnerCardInTrick = trick.cards.find(
      (tc) => teamOf(tc.player) === myTeam && tc.player !== player && !tc.covered,
    );
    if (wonAnyPrevTrick && partnerCardInTrick && cards.length >= 2) {
      // Conjunt de cartes "vives": cartes a totes les mans restants +
      // cartes jugades en aquesta baza (descobertes).
      const liveCards: Card[] = [];
      for (const pid of [0, 1, 2, 3] as PlayerId[]) {
        for (const c of r.hands[pid]) liveCards.push(c);
      }
      for (const tc of trick.cards) {
        if (!tc.covered) liveCards.push(tc.card);
      }
      const liveSorted = [...liveCards].sort(
        (a, b) => cardStrength(b) - cardStrength(a),
      );
      const top1 = liveSorted[0];
      const top2 = liveSorted[1];
      const partnerCard = partnerCardInTrick.card;
      const myHighestStr = cardStrength(highest);
      if (
        top1 && top2 &&
        myHighestStr === cardStrength(top1) &&
        cardStrength(partnerCard) === cardStrength(top2) &&
        cardStrength(top1) > cardStrength(top2)
      ) {
        const playNonHighest = Math.random() < 0.5;
        if (playNonHighest) {
          const others = sorted.filter((c) => c.id !== highest.id);
          const pick = others[0] ?? lowest;
          const matchAct = playActions.find((a) => a.cardId === pick.id);
          if (matchAct) return matchAct;
        }
        // Alternativa: tapar la carta més alta.
        const matchHigh = playActions.find((a) => a.cardId === highest.id);
        if (matchHigh) return { type: "play-card", cardId: highest.id, covered: true };
      }
    }
  }

  // Regla universal: si sóc l'últim dels 4 jugadors a tirar en aquesta
  // baza i el meu company ja la guanya, no té cap sentit cremar una
  // carta bona. Tira sempre la més baixa per reservar les fortes per a
  // bazas posteriors.
  if (trick.cards.length === 3) {
    const tableLeader = trick.cards.reduce(
      (best, tc) =>
        best === null || cardStrength(tc.card) > cardStrength(best.card) ? tc : best,
      null as { player: PlayerId; card: Card } | null,
    );
    if (tableLeader && teamOf(tableLeader.player) === teamOf(player)) {
      return { type: "play-card", cardId: lowest.id };
    }
    // Rival guanya la mesa: si tinc alguna carta que la supere, juga
    // SEMPRE la més baixa de les que guanyen. Si no en tinc cap però en
    // la 1a baza puc empatar (parda) amb una carta de la mateixa força
    // (típicament un 3 si el rival ha tret un 3), tira eixa carta —
    // millor parda que perdre la 1a baza per res.
    if (tableLeader) {
      const tableBest = cardStrength(tableLeader.card);
      const winners = sorted.filter((c) => cardStrength(c) > tableBest);
      if (winners.length > 0) {
        return { type: "play-card", cardId: winners[0]!.id };
      }
      if (r.tricks.length === 1) {
        const tiers = sorted.filter((c) => cardStrength(c) === tableBest);
        if (tiers.length > 0) {
          return { type: "play-card", cardId: tiers[0]!.id };
        }
      }
      return { type: "play-card", cardId: lowest.id };
    }
  }

  // ---- Obligació: si hem PERDUT la 1a baza i estem a la 2a, en posició
  // de 3r o 4t a tirar (ja hi ha 2 o 3 cartes a la mesa), guanyar la
  // baza és obligatori si és possible. Tira la carta MÉS BAIXA que
  // supere la millor carta jugada a la mesa. Aquesta regla té prioritat
  // sobre qualsevol compromís ("vine a mi", "tinc un tres", reservar
  // manilles, etc.) perquè perdre la 2a baza després d'haver perdut la
  // 1a significa perdre el truc directament.
  {
    const myTeam = teamOf(player);
    const firstT = r.tricks[0];
    const lostFirst =
      !!firstT &&
      firstT.parda !== true &&
      firstT.winner !== undefined &&
      teamOf(firstT.winner!) !== myTeam;
    if (
      lostFirst &&
      r.tricks.length === 2 &&
      (trick.cards.length === 2 || trick.cards.length === 3)
    ) {
      const tableBest = trick.cards.reduce(
        (mx, tc) => Math.max(mx, cardStrength(tc.card)),
        -1,
      );
      const tableBestPlayer = trick.cards.reduce(
        (best, tc) =>
          best === null || cardStrength(tc.card) > cardStrength(best.card)
            ? tc
            : best,
        null as { player: PlayerId; card: Card } | null,
      );
      const partnerWinsTable =
        tableBestPlayer !== null && teamOf(tableBestPlayer.player) === myTeam;
      if (trick.cards.length === 3 && partnerWinsTable) {
        return { type: "play-card", cardId: lowest.id };
      }
      const winners = sorted.filter((c) => cardStrength(c) > tableBest);
      if (winners.length > 0) {
        return { type: "play-card", cardId: winners[0]!.id };
      }
      return { type: "play-card", cardId: lowest.id };
    }
  }

  // ---- Obligació: si hem GUANYAT la 1a baza i estem a la 2a, en posició
  // de 3r a tirar (ja hi ha 2 cartes a la mesa), si tinc un 3 que supera
  // la millor carta jugada, juga'l SEMPRE — encara que tinga una carta
  // inferior que també guanyaria. Així assegurem la baza amb la carta
  // més forta possible (un 3) i evitem que el 4t rival ens supere amb
  // una carta intermèdia. Aquesta regla té prioritat sobre compromisos
  // de company ("vine a mi", "tinc un tres") i sobre la lògica de
  // reservar manilles, perquè guanyar la 2a baza després d'haver guanyat
  // la 1a tanca el truc immediatament.
  {
    const myTeam2 = teamOf(player);
    const firstT2 = r.tricks[0];
    const wonFirst2 =
      !!firstT2 &&
      firstT2.parda !== true &&
      firstT2.winner !== undefined &&
      teamOf(firstT2.winner!) === myTeam2;
    if (
      wonFirst2 &&
      r.tricks.length === 2 &&
      trick.cards.length === 2
    ) {
      const tableBest2 = trick.cards.reduce(
        (mx, tc) => Math.max(mx, cardStrength(tc.card)),
        -1,
      );
      const tableBestPlayer2 = trick.cards.reduce(
        (best, tc) =>
          best === null || cardStrength(tc.card) > cardStrength(best.card)
            ? tc
            : best,
        null as { player: PlayerId; card: Card } | null,
      );
      const partnerWinsTable2 =
        tableBestPlayer2 !== null && teamOf(tableBestPlayer2.player) === myTeam2;
      if (!partnerWinsTable2) {
        const winningThree2 = sorted.find(
          (c) => c.rank === 3 && cardStrength(c) > tableBest2,
        );
        if (winningThree2) {
          const matchAct = playActions.find((a) => a.cardId === winningThree2.id);
          if (matchAct) return matchAct;
        }
      }
    }
  }

  // Pista directa de força del company humà via chat.
  // "low"  → tira la carta més baixa (l'humà cobreix amb una bona).
  // "high" → tira la carta més alta (l'humà no té res, salva tu la baza).
  // "free" → segueix amb la lògica normal (no força res).
  // "vine-a-vore" → el bot mateix s'ha compromés a tindre 7 d'oros o un 3:
  //   ha de jugar eixa carta si guanya la mesa, sino guardar-la i tirar
  //   la més baixa. Excepció: totes les cartes de la mesa són < 3 (str<70)
  //   i cap rival ha mostrat força → pot reservar el 7 d'oros i tirar el 3.
  if (playStrength === "low") {
    return { type: "play-card", cardId: lowest.id };
  }
  if (playStrength === "high") {
    // El company ha dit "A tu!" / "No tinc res": demana que jo intente
    // guanyar la baza. En la 1a baza, si tinc una carta TOP (manilla
    // d'oros, manilla d'espases, As bastos o As espases) o un 3 que
    // guanyen o empardin la millor carta ja jugada en la mesa, juga
    // PREFERENTMENT la carta top; en defecte, juga el 3. Així no es
    // crema una carta forta innecessàriament: només es treu si serveix.
    const tableBest = trick.cards.length > 0
      ? trick.cards.reduce((mx, tc) => Math.max(mx, cardStrength(tc.card)), -1)
      : -1;
    if (r.tricks.length === 1) {
      const isTopCardATu = (c: Card) =>
        (c.rank === 1 && (c.suit === "bastos" || c.suit === "espases")) ||
        (c.rank === 7 && (c.suit === "espases" || c.suit === "oros"));
      // Cartes top que guanyen O empardin la mesa (tableBest = -1 si la
      // mesa està buida, en eixe cas qualsevol carta serveix).
      const winningTops = cards
        .filter((c) => isTopCardATu(c) && cardStrength(c) >= tableBest)
        .sort((a, b) => cardStrength(a) - cardStrength(b));
      if (winningTops.length > 0) {
        const pick = winningTops[0]!; // la top més baixa que serveix
        const matchAct = playActions.find((a) => a.cardId === pick.id);
        if (matchAct) return matchAct;
      }
      // En defecte, qualsevol 3 que guanye O empardi la mesa.
      const winningThrees = cards
        .filter((c) => c.rank === 3 && cardStrength(c) >= tableBest)
        .sort((a, b) => cardStrength(a) - cardStrength(b));
      if (winningThrees.length > 0) {
        const pick = winningThrees[0]!;
        const matchAct = playActions.find((a) => a.cardId === pick.id);
        if (matchAct) return matchAct;
      }
    }
    // Si la meua carta més alta no és suficient per a superar la millor
    // carta ja jugada en la mesa, no té sentit cremar-la — la guarde per
    // a una baza posterior i tire la més baixa.
    if (tableBest >= 0 && cardStrength(highest) <= tableBest) {
      return { type: "play-card", cardId: lowest.id };
    }
    // Si la baza ja està oberta i el meu equip va guanyant amb la carta
    // més alta, no cal cremar la millor; tira igualment alta perquè
    // l'humà ha demanat que jo me'n faça càrrec.
    return { type: "play-card", cardId: highest.id };
  }
  if (playStrength === "vine-a-vore") {
    // Cartes "compromeses": 7 d'oros (str=85) o qualsevol 3 (str=70).
    const committedCards = cards
      .filter((c) => (c.rank === 7 && c.suit === "oros") || c.rank === 3)
      .sort((a, b) => cardStrength(a) - cardStrength(b));
    if (committedCards.length > 0) {
      const tableBest = trick.cards.length > 0
        ? trick.cards.reduce((mx, tc) => Math.max(mx, cardStrength(tc.card)), -1)
        : -1;
      const tableBestPlayer = trick.cards.length > 0
        ? trick.cards.reduce(
            (best, tc) =>
              best === null || cardStrength(tc.card) > cardStrength(best.card)
                ? tc
                : best,
            null as { player: PlayerId; card: Card } | null,
          )
        : null;
      const partnerWinsTable =
        tableBestPlayer !== null && teamOf(tableBestPlayer.player) === teamOf(player);

      if (partnerWinsTable) {
        // El company ja guanya: no cal cremar res. Tira la més baixa.
        return { type: "play-card", cardId: lowest.id };
      }

      const winningCommitted = committedCards.find((c) => cardStrength(c) > tableBest);
      if (winningCommitted) {
        // Excepció: totes les cartes de la mesa són < 3 (str<70) i cap
        // rival ha mostrat força → si tinc el 7 d'oros, reserve'l i tire
        // el 3 si també guanya.
        const allWeak = trick.cards.every((tc) => cardStrength(tc.card) < 70);
        if (allWeak && !rivalShownStrength) {
          const three = committedCards.find(
            (c) => c.rank === 3 && cardStrength(c) > tableBest,
          );
          const has7Oros = committedCards.some((c) => c.rank === 7 && c.suit === "oros");
          if (three && has7Oros) {
            const matchAct = playActions.find((a) => a.cardId === three.id);
            if (matchAct) return matchAct;
          }
        }
        // Juga la carta compromesa més baixa que guanya la mesa.
        const matchAct = playActions.find((a) => a.cardId === winningCommitted.id);
        if (matchAct) return matchAct;
      }
      // Cap carta compromesa guanya la mesa: guarda-les per a una baza
      // posterior i tira la més baixa de les altres (o la més baixa
      // absoluta si totes són compromeses).
      const nonCommitted = cards
        .filter((c) => !((c.rank === 7 && c.suit === "oros") || c.rank === 3))
        .sort((a, b) => cardStrength(a) - cardStrength(b));
      const fallback = nonCommitted[0] ?? lowest;
      const matchAct = playActions.find((a) => a.cardId === fallback.id);
      if (matchAct) return matchAct;
    }
    // Sense cartes compromeses (cas anòmal): segueix amb la lògica normal.
  }
  if (playStrength === "vine-al-meu-tres" || playStrength === "tinc-un-tres") {
    // Compromís: el bot ha dit "Vine al meu tres" o "Tinc un 3" i té un 3.
    // Regles (mateixes per a les dues respostes):
    //   1) Si la mesa està buida (sóc primer): si el meu equip ha guanyat
    //      la 1a baza, tire un 3 per pressionar (assegure baza/parda).
    //      Si no, juga la lògica normal.
    //   2) Si la mesa té cartes:
    //      a) Si el meu company ja guanya, no cal cremar: més baixa.
    //      b) Si tinc un 3 que GUANYA la millor de la mesa → juga'l.
    //      c) Si el meu equip ha guanyat la 1a baza i el meu 3 EMPATA
    //         (str de la millor de la mesa = 70 = un altre 3) → juga el 3
    //         per assegurar la parda (que en aquesta 2a baza ens fa
    //         guanyar el truc).
    //      d) Si no pot guanyar ni empatar amb cap 3 → guarda els 3 i
    //         tira la més baixa no compromesa.
    const myThrees = cards
      .filter((c) => c.rank === 3)
      .sort((a, b) => cardStrength(a) - cardStrength(b));
    if (myThrees.length > 0) {
      const myTeam = teamOf(player);
      const firstTrick = r.tricks[0];
      const wonFirstTrick =
        !!firstTrick &&
        firstTrick.winner !== undefined &&
        firstTrick.parda !== true &&
        teamOf(firstTrick.winner!) === myTeam;

      if (trick.cards.length === 0) {
        // Sóc primer: tire un 3 si el meu equip ja va 1-0 (o si és la
        // primera baza, ja que el compromís ho exigeix com a posicionament).
        const pickThree = myThrees[0]!;
        const matchAct = playActions.find((a) => a.cardId === pickThree.id);
        if (matchAct) return matchAct;
      } else {
        const tableBest = trick.cards.reduce(
          (mx, tc) => Math.max(mx, cardStrength(tc.card)),
          -1,
        );
        const tableBestPlayer = trick.cards.reduce(
          (best, tc) =>
            best === null || cardStrength(tc.card) > cardStrength(best.card)
              ? tc
              : best,
          null as { player: PlayerId; card: Card } | null,
        );
        const partnerWinsTable =
          tableBestPlayer !== null && teamOf(tableBestPlayer.player) === teamOf(player);

        if (partnerWinsTable) {
          return { type: "play-card", cardId: lowest.id };
        }

        // Cap 3 té força > 70, per tant "winning" només si tableBest < 70.
        const winningThree = myThrees.find((c) => cardStrength(c) > tableBest);
        if (winningThree) {
          const matchAct = playActions.find((a) => a.cardId === winningThree.id);
          if (matchAct) return matchAct;
        }
        // Empat amb el 3 (algun rival també ha tirat un 3) i el meu equip
        // ja ha guanyat la 1a baza → empardar la baza ens dóna el truc.
        const tieingThree = myThrees.find((c) => cardStrength(c) === tableBest);
        if (tieingThree && wonFirstTrick) {
          const matchAct = playActions.find((a) => a.cardId === tieingThree.id);
          if (matchAct) return matchAct;
        }
        // Ni guanya ni empata útil: guarda el 3, tira la més baixa no-3.
        const nonThree = cards
          .filter((c) => c.rank !== 3)
          .sort((a, b) => cardStrength(a) - cardStrength(b));
        const fallback = nonThree[0] ?? lowest;
        const matchAct = playActions.find((a) => a.cardId === fallback.id);
        if (matchAct) return matchAct;
      }
    }
    // Sense 3 (cas anòmal): segueix lògica normal.
  }

  // ----- Regla mode sincer: compromís de "Vine a mi!" / "Algo tinc" -----
  // Si el jugador té una carta forta (str ≥ 80: manilla d'espases, manilla
  // d'oros, As bastos o As espases) i la baza ja està oberta:
  //   1) Si la carta forta GUANYA la millor de la mesa → juga-la.
  //      Excepció: totes les cartes de la mesa són < 3 (str < 70) i tinc
  //      una alternativa més feble (3 o manilla d'oros) que també guanyaria →
  //      reserve la carta forta per a una baza posterior.
  //   2) Si cap carta forta no guanya → guarda-les i tira la més baixa.
  // Aquesta regla té prioritat perquè honora el compromís implícit del
  // "Vine a mi!" o "Algo tinc" (manilla d'espases o manilla d'oros).
  // EXCEPCIÓ: si el meu COMPANY ha promés força ((partnerAdvice === "strong" || partnerAdvice === "three"):
  // "Vine a mi!", "Algo tinc", "Tinc un 3", "Vine al meu tres") és ell qui
  // ha de cremar la carta forta. Jo, com a parella, no quemo res — tire la
  // més baixa per reservar les meues bones per a bazas posteriors.
  if (trick.cards.length > 0 && (partnerAdvice === "strong" || partnerAdvice === "three")) {
    return { type: "play-card", cardId: lowest.id };
  }
  if (trick.cards.length > 0) {
    const myTopCards = cards
      .filter((c) => cardStrength(c) >= 80)
      .sort((a, b) => cardStrength(a) - cardStrength(b));
    if (myTopCards.length > 0) {
      const tableBest = trick.cards.reduce(
        (mx, tc) => Math.max(mx, cardStrength(tc.card)),
        -1,
      );
      const tableBestPlayer = trick.cards.reduce(
        (best, tc) =>
          best === null || cardStrength(tc.card) > cardStrength(best.card)
            ? tc
            : best,
        null as { player: PlayerId; card: Card } | null,
      );
      const partnerWinsTable =
        tableBestPlayer !== null && teamOf(tableBestPlayer.player) === teamOf(player);

      if (!partnerWinsTable) {
        const winningTop = myTopCards.find((c) => cardStrength(c) > tableBest);
        if (winningTop) {
          // Reserve la carta forta NOMÉS si totes les cartes de la mesa
          // són < 3 (str < 70) I cap rival ha mostrat força (vine-a-mi /
          // tinc-bona) en aquesta ronda. Si algun rival ha senyalitzat
          // que té cartes fortes, juga la carta de força per assegurar
          // la baza —especialment crucial en la 1a baza.
          const allWeak = trick.cards.every((tc) => cardStrength(tc.card) < 70);
          if (allWeak && !rivalShownStrength) {
            const winningTopStr = cardStrength(winningTop);
            const reserve = cards
              .filter(
                (c) =>
                  cardStrength(c) < winningTopStr &&
                  cardStrength(c) > tableBest &&
                  (c.rank === 3 || (c.rank === 7 && c.suit === "oros")),
              )
              .sort((a, b) => cardStrength(a) - cardStrength(b))[0];
            if (reserve) {
              const matchAct = playActions.find((a) => a.cardId === reserve.id);
              if (matchAct) return matchAct;
            }
          }
          const matchAct = playActions.find((a) => a.cardId === winningTop.id);
          if (matchAct) return matchAct;
        } else {
          return { type: "play-card", cardId: lowest.id };
        }
      }
    }
  }


  // Si yo soy el primero de mi pareja en tirar (o abro la baza),
  // aplica el consejo del compañero:
  //  - strong → tira baja para reservar la alta
  //  - weak   → tira alta para intentar ganar
  //  - neutral → comportamiento original
  if (trick.cards.length === 0) {
    // Si la 1a baza ha quedat parda, la 2a baza decideix el truc:
    // sempre tira la carta més alta per intentar guanyar-la.
    if (r.tricks.length === 2 && r.tricks[0]!.parda) {
      return { type: "play-card", cardId: highest.id };
    }

    // ----- 2a baza: hem guanyat la 1a → obrir amb un 3 si en tenim, si no la més baixa -----
    // Si el meu equip va 1-0 i no tinc el truc clarament guanyat (sense
    // els dos asos forts ni una carta dominant ja imbatible), obrir amb
    // un 3 pressiona els rivals: si volen guanyar la baza hauran de
    // cremar les seues millors cartes (manilles fortes i asos),
    // assegurant-nos més probabilitats de tancar el truc en la 3a baza
    // o per parda. Si no tenim cap 3, conservem les cartes fortes per
    // a la 3a baza i tirem la més baixa.
    if (r.tricks.length === 2 && !r.tricks[0]!.parda) {
      const myTeam = teamOf(player);
      const wonFirst =
        r.tricks[0]!.winner !== undefined && teamOf(r.tricks[0]!.winner!) === myTeam;
      if (wonFirst && partnerAdvice !== "weak") {
        const hasAsEspases = cards.some(c => c.rank === 1 && c.suit === "espases");
        const hasAsBastos = cards.some(c => c.rank === 1 && c.suit === "bastos");
        const trucWonAlready = hasAsEspases && hasAsBastos;
        // "Carta dominant assegurada": una carta ≥85 (As bastos/manilla
        // espases) i totes les superiors a ella ja s'han jugat.
        const myHighScore = cardStrength(highest);
        const playedHigher = r.tricks.some(t =>
          t.cards.some(tc => cardStrength(tc.card) > myHighScore),
        );
        const dominantSecured = myHighScore >= 90 && playedHigher;
        const myThrees = cards.filter(c => c.rank === 3);
        if (!trucWonAlready && !dominantSecured && myThrees.length >= 1) {
          // Si en té diversos, juga el de pal "fluix" (oros/copes) per
          // reservar els forts.
          const ordered = [...myThrees].sort((a, b) => cardStrength(a) - cardStrength(b));
          const pick = ordered[0]!;
          const matchAct = playActions.find(a => a.cardId === pick.id);
          if (matchAct) return matchAct;
        }
      }
      if (wonFirst) {
        return { type: "play-card", cardId: lowest.id };
      }
      // Hem perdut la 1a baza i sóc el primer de la pareja en obrir
      // la 2a. Si he preguntat "Tens més d'un tres?" al company:
      //  - resposta forta (té carta top) → tire la més baixa per
      //    reservar les meues fortes per a la 3a baza.
      //  - resposta dèbil (no té res) → tire una carta superior a
      //    un 3 (str > 70). Si en tinc dues "tops" (≥ 85), trie la
      //    més baixa d'eixes dues per reservar la millor per a la 3a.
      const lostFirst = !wonFirst && r.tricks[0]!.winner !== undefined;
      if (lostFirst) {
        if (partnerAdvice === "strong" || partnerAdvice === "three") {
          return { type: "play-card", cardId: lowest.id };
        }
        if (partnerAdvice === "weak") {
          const myTops = cards.filter((c) => cardStrength(c) >= 85);
          if (myTops.length >= 2) {
            const lowerTop = [...myTops].sort((a, b) => cardStrength(a) - cardStrength(b))[0]!;
            const matchAct = playActions.find((a) => a.cardId === lowerTop.id);
            if (matchAct) return matchAct;
          }
          const aboveThree = cards
            .filter((c) => cardStrength(c) > 70)
            .sort((a, b) => cardStrength(a) - cardStrength(b));
          if (aboveThree.length >= 1) {
            const pick = aboveThree[0]!;
            const matchAct = playActions.find((a) => a.cardId === pick.id);
            if (matchAct) return matchAct;
          }
          return { type: "play-card", cardId: highest.id };
        }
      }
    }

    if (partnerAdvice === "three") {
      // El company ha respost "Tinc un 3" (té un 3, sense carta top
      // confirmada). Si jo, com a primer de la pareja en obrir la baza,
      // tinc un 3 i a més un AS DE BASTOS o AS D'ESPASES, obre amb eixa
      // as: és més probable que així guanyem el truc (el company pot
      // arribar amb el seu 3 i nosaltres reservem el nostre 3). Si la
      // meua carta top és una manilla (7 oros/espases), preferixo
      // reservar-la i tirar la baixa, perquè la manilla val més que un as.
      const myThreesAdv = cards.filter((c) => c.rank === 3);
      const myAces = cards.filter(
        (c) => c.rank === 1 && (c.suit === "bastos" || c.suit === "espases"),
      );
      if (myThreesAdv.length >= 1 && myAces.length >= 1) {
        const acePick = myAces.sort((a, b) => cardStrength(a) - cardStrength(b))[0]!;
        const matchAct = playActions.find((a) => a.cardId === acePick.id);
        if (matchAct) return matchAct;
      }
      // Si no, comportament equivalent a "strong": tira baixa per reservar.
      return { type: "play-card", cardId: lowest.id };
    }
    if (partnerAdvice === "strong") {
      return { type: "play-card", cardId: lowest.id };
    }
    if (partnerAdvice === "weak") {
      return { type: "play-card", cardId: highest.id };
    }
    if (r.tricks.length === 1) {
      // 1a baza: és crucial guanyar-la — si la guanyem i alguna de les
      // següents queda parda, guanyem el truc. Per defecte obrim amb la
      // carta més alta. Excepció: si tenim una carta dominant (≥80,
      // típicament manilla d'oros/espases o asos forts) i a més una altra
      // carta mig-alta (≥55), reservem la dominant i obrim amb la segona millor.
      const dominant = sorted[sorted.length - 1]!;
      const second = sorted[sorted.length - 2];
      const dominantScore = cardStrength(dominant);
      const secondScore = second ? cardStrength(second) : 0;
      if (dominantScore >= 80 && secondScore >= 55) {
        return { type: "play-card", cardId: second!.id };
      }
      return { type: "play-card", cardId: highest.id };
    }
    return { type: "play-card", cardId: highest.id };
  }

  let bestOnTable = -1;
  let bestPlayer: PlayerId | null = null;
  for (const tc of trick.cards) {
    const s = cardStrength(tc.card);
    if (s > bestOnTable) { bestOnTable = s; bestPlayer = tc.player; }
  }

  const partnerWinning = bestPlayer !== null && teamOf(bestPlayer) === teamOf(player);

  // Si la 1a baza ha quedat parda, la 2a baza decideix el truc:
  // sempre tira la carta més alta per intentar guanyar-la (fins i tot
  // si el company va guanyant la mesa actualment, perquè una carta
  // rival posterior podria superar-lo).
  if (r.tricks.length === 2 && r.tricks[0]!.parda) {
    return { type: "play-card", cardId: highest.id };
  }

  // ----- Regla: hem perdut la 1a baza, ara hem de guanyar la 2a -----
  // Si el meu equip ha perdut la 1a baza (no la vam empardar) i estem
  // jugant la 2a, no podem perdre m\u00e9s bazas: cal guanyar aquesta s\u00ed o
  // s\u00ed (i tamb\u00e9 la 3a). Casos especials:
  //   a) La 2a baza ja porta parda a la mesa (algun rival ha igualat la
  //      millor carta entre equips): si parda la 2a havent perdut la 1a,
  //      perdem el truc. Cal jugar una carta que SUPERE la millor de la
  //      mesa (no nom\u00e9s igualar-la). Si en tinc, juga la m\u00e9s baixa
  //      que guanya.
  //   b) Encara queden rivals per jugar i el meu equip no t\u00e9 una carta
  //      a la mesa que clarament guanya: prioritza jugar una carta
  //      guanyadora abans que reservar-la.
  if (r.tricks.length === 2 && !r.tricks[0]!.parda) {
    const myTeam = teamOf(player);
    const wonFirst =
      r.tricks[0]!.winner !== undefined && teamOf(r.tricks[0]!.winner!) === myTeam;
    if (!wonFirst) {
      // Hi ha parda entre equips a la mesa? (millor carta empatada en
      // for\u00e7a per cartes de l'equip rival)
      let tableParda = false;
      if (trick.cards.length >= 2 && bestPlayer !== null) {
        for (const tc of trick.cards) {
          if (
            tc.player !== bestPlayer &&
            teamOf(tc.player) !== teamOf(bestPlayer) &&
            cardStrength(tc.card) === bestOnTable
          ) {
            tableParda = true;
            break;
          }
        }
      }
      const winningCards = sorted.filter((c) => cardStrength(c) > bestOnTable);
      // (a) Parda a la mesa: hem d'intentar superar-la s\u00ed o s\u00ed.
      if (tableParda && winningCards.length > 0) {
        const pick = winningCards[0]!; // m\u00e9s baixa que guanya
        const matchAct = playActions.find((a) => a.cardId === pick.id);
        if (matchAct) return matchAct;
      }
      // (b) Si el meu company NO va guanyant clarament i tinc cartes que
      // superen la mesa, juga la m\u00e9s baixa que guanya. No reservem
      // cartes: si perdem la 2a tamb\u00e9, perdem el truc.
      if (!partnerWinning && winningCards.length > 0) {
        const pick = winningCards[0]!;
        const matchAct = playActions.find((a) => a.cardId === pick.id);
        if (matchAct) return matchAct;
      }
    }
  }

  // ----- Regla: 3r en l'ordre de la 1a baza amb 3 + carta top -----
  // Si soc el 3r en jugar de la primera baza (el meu company ha jugat
  // primer, el rival segon) i tinc tant un 3 com una carta TOP (As
  // bastos, As espases, 7 espases o 7 d'oros, str ≥ 80), i la carta
  // top supera la millor carta de la mesa: juga la top per assegurar
  // la 1a baza. Guanyar-la és cr\u00edtic, i tindre encara un 3 a la m\u00e0
  // garanteix joc fort per a les bazas restants. Aplica tant si el
  // company va guanyant (per blindar contra el 4t rival) com si no.
  if (r.tricks.length === 1 && trick.cards.length === 2 && (partnerAdvice !== "strong" && partnerAdvice !== "three")) {
    const isTopCard = (c: Card) =>
      (c.rank === 1 && (c.suit === "bastos" || c.suit === "espases")) ||
      (c.rank === 7 && (c.suit === "espases" || c.suit === "oros"));
    const myThrees = cards.filter((c) => c.rank === 3);
    const myTopCards = cards.filter(isTopCard).sort((a, b) => cardStrength(a) - cardStrength(b));
    if (myThrees.length >= 1 && myTopCards.length >= 1) {
      const winningTop = myTopCards.find((c) => cardStrength(c) > bestOnTable);
      if (winningTop) {
        const matchAct = playActions.find((a) => a.cardId === winningTop.id);
        if (matchAct) return matchAct;
      }
    }
  }

  // ----- Regla: 2n de la parella en jugar a la 1a baza -----
  // Si soc el 2n jugador de la meua parella a la 1a baza (el meu company
  // ja ha jugat ac\u00ed) i el meu equip encara no t\u00e9 la baza guanyada amb
  // un 3 o una carta TOP (str ≥ 70), tire SEMPRE la meua MAJOR carta si
  // \u00e9s un 3 o una top i \u00e9s suficient per guanyar O empardar la millor
  // de la mesa. Si la meua major 3/top no arriba a empardar, tire la m\u00e9s
  // baixa per no cremar cartes \u00fatils. Guanyar o empardar la 1a baza \u00e9s
  // cr\u00edtic per tindre opcions de guanyar el truc.
  if (r.tricks.length === 1 && (partnerAdvice !== "strong" && partnerAdvice !== "three")) {
    const partnerSeat = ((player + 2) % 4) as PlayerId;
    const partnerHasPlayedHere = trick.cards.some((tc) => tc.player === partnerSeat);
    if (partnerHasPlayedHere) {
      const teamWinningWithThreeOrBetter =
        partnerWinning && bestOnTable >= 70;
      if (!teamWinningWithThreeOrBetter) {
        const isTopCard = (c: Card) =>
          (c.rank === 1 && (c.suit === "bastos" || c.suit === "espases")) ||
          (c.rank === 7 && (c.suit === "espases" || c.suit === "oros"));
        const myStrongCards = cards
          .filter((c) => c.rank === 3 || isTopCard(c))
          .sort((a, b) => cardStrength(b) - cardStrength(a));
        const myHighestStrong = myStrongCards[0];
        if (myHighestStrong && cardStrength(myHighestStrong) >= bestOnTable) {
          const matchAct = playActions.find((a) => a.cardId === myHighestStrong.id);
          if (matchAct) return matchAct;
        } else {
          // No tinc cap 3 ni top que arribe a empardar: tire la m\u00e9s
          // baixa per no cremar cartes \u00fatils per a les bazas seg\u00fcents.
          const matchAct = playActions.find((a) => a.cardId === lowest.id);
          if (matchAct) return matchAct;
        }
      }
    }
  }

  if (partnerWinning) {
    return { type: "play-card", cardId: lowest.id };
  }

  // ----- 2a baza, vam guanyar la 1a, no obro: prefereix tirar un 3 -----
  // Si el meu equip ja va 1-0 i la 2a baza està en marxa (no soc el
  // primer en obrir-la, però el meu company tampoc està guanyant la
  // mesa), tirar un 3 abans que cremar una carta forta:
  //   · Pressiona el rival que falte per jugar (haurà de cremar una
  //     manilla/As per guanyar la baza).
  //   · Si ningú supera el meu 3, l'empardem o guanyem i el truc és nostre.
  //   · Reserve les cartes top (As bastos / 7 espases / manilles) per a
  //     una possible 3a baza on poder cantar truc oportunista.
  // Particularment important quan soc el 3r en l'ordre (trick.cards.length
  // === 2): forço l'últim rival a decidir si crema una carta bona.
  if (
    r.tricks.length === 2 &&
    !r.tricks[0]!.parda &&
    trick.cards.length >= 1 &&
    partnerAdvice !== "weak"
  ) {
    const myTeam = teamOf(player);
    const wonFirst =
      r.tricks[0]!.winner !== undefined && teamOf(r.tricks[0]!.winner!) === myTeam;
    const hasAsEspases = cards.some(c => c.rank === 1 && c.suit === "espases");
    const hasAsBastos = cards.some(c => c.rank === 1 && c.suit === "bastos");
    const trucWonAlready = hasAsEspases && hasAsBastos;
    const myHighScore = cardStrength(highest);
    const playedHigher = r.tricks.some(t =>
      t.cards.some(tc => cardStrength(tc.card) > myHighScore),
    );
    const dominantSecured = myHighScore >= 90 && playedHigher;
    if (wonFirst && !trucWonAlready && !dominantSecured) {
      const myThrees = cards.filter(c => c.rank === 3);
      // Cap 3 té força > 70: només té sentit si pot guanyar o empardar
      // (bestOnTable ≤ 70). Si bestOnTable > 70 (rival ha jugat manilla
      // forta o As), no tirem el 3 — passa avall a la lògica normal que
      // ja reserva les top cards.
      if (myThrees.length >= 1 && bestOnTable <= 70) {
        const ordered = [...myThrees].sort((a, b) => cardStrength(a) - cardStrength(b));
        // Si ja hi ha un 3 a la mesa, juga el meu 3 més fort per intentar
        // superar-lo (cap el guanya, però l'empat ja ens dóna la baza/parda).
        // Si no n'hi ha, juga el més fluix per reservar el 3 fort per la 3a.
        const pick = bestOnTable === 70 ? ordered[ordered.length - 1]! : ordered[0]!;
        const matchAct = playActions.find(a => a.cardId === pick.id);
        if (matchAct) return matchAct;
      }
    }
  }

  // ----- Regla específica: 2n de la parella en la 1a baza -----
  // Si soc el segon en jugar de la meua parella en la primera baza
  // (el company encara no ha jugat i la mesa té 1 carta, d'un rival),
  // he d'intentar guanyar la baza amb la carta de truc més alta possible
  // perquè guanyar la primera dóna avantatge davant un empat posterior.
  // Excepcions per no cremar la millor carta:
  //  a) Tinc As espases + As bastos → ja tinc el truc guanyat; tire baixa.
  //  b) Tinc As bastos + 7 espases i l'As espases ja s'ha jugat en aquesta
  //     ronda → l'As bastos és invencible; tire baixa.
  //  c) Tinc As espases i un 3, i la millor carta de la mesa és un 3 →
  //     podem empardar amb el 3 (reserve l'As espases).
  const partnerSeat = ((player + 2) % 4) as PlayerId;
  const partnerHasPlayedHere = trick.cards.some(tc => tc.player === partnerSeat);
  const isFirstTrick = r.tricks.length === 1;
  const iAmSecondOfPair = isFirstTrick && trick.cards.length === 1 && !partnerHasPlayedHere;
  if (iAmSecondOfPair && (partnerAdvice !== "strong" && partnerAdvice !== "three")) {
    const hasAsEspases = hand.some(c => c.rank === 1 && c.suit === "espases");
    const hasAsBastos = hand.some(c => c.rank === 1 && c.suit === "bastos");
    const has7Espases = hand.some(c => c.rank === 7 && c.suit === "espases");
    const myThrees = cards.filter(c => c.rank === 3);
    // Comprova si l'As espases ja ha eixit en alguna baza d'aquesta ronda
    // (només pot ser en aquesta mateixa primera baza, però ho generalitzem).
    const asEspasesPlayed = r.tricks.some(t =>
      t.cards.some(tc => tc.card.rank === 1 && tc.card.suit === "espases"),
    );

    // (a) Truc ja guanyat amb tots dos asos forts.
    const trucWonAlready = hasAsEspases && hasAsBastos;
    // (b) As bastos invencible perquè l'As espases ja s'ha jugat.
    const asBastosInvincible = hasAsBastos && has7Espases && asEspasesPlayed;

    if (!trucWonAlready && !asBastosInvincible) {
      // (c) Empardar amb el 3 si el rival ha jugat un 3 i jo tinc As espases.
      const tableTopIsThree = trick.cards[0]!.card.rank === 3;
      if (tableTopIsThree && hasAsEspases && myThrees.length >= 1) {
        const myThree = myThrees[0]!;
        const matchAct = playActions.find(a => a.cardId === myThree.id);
        if (matchAct) return matchAct;
      }
      // Carta de truc més alta (≥70) que supere la del rival.
      const trucCards = sorted.filter(c => cardStrength(c) >= 70);
      const winningTrucCards = trucCards.filter(c => cardStrength(c) > bestOnTable);
      if (winningTrucCards.length > 0) {
        // Agafa la més alta per assegurar la baza.
        const pick = winningTrucCards[winningTrucCards.length - 1]!;
        const matchAct = playActions.find(a => a.cardId === pick.id);
        if (matchAct) return matchAct;
      }
      // Si la meua carta més alta no supera la del rival, no la malgaste:
      // tire la més baixa per reservar les bones per a bazas següents.
      if (cardStrength(highest) <= bestOnTable) {
        return { type: "play-card", cardId: lowest.id };
      }
    }
  }

  // Si voy en tercer lugar (mi compañero aún no jugó) y tengo consejo:
  const partner = ((player + 2) % 4) as PlayerId;
  const partnerPlayed = trick.cards.some(tc => tc.player === partner);
  if (!partnerPlayed) {
    if ((partnerAdvice === "strong" || partnerAdvice === "three")) {
      return { type: "play-card", cardId: lowest.id };
    }
    if (partnerAdvice === "weak") {
      const winners = sorted.filter(c => cardStrength(c) > bestOnTable);
      if (winners.length > 0) {
        return { type: "play-card", cardId: highest.id };
      }
    }
  }

  const winners = sorted.filter(c => cardStrength(c) > bestOnTable);
  if (winners.length > 0) {
    return { type: "play-card", cardId: winners[0]!.id };
  }
  return { type: "play-card", cardId: lowest.id };
}
