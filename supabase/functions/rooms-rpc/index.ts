// Edge function that exposes all room-related RPCs.
// Body: { fn: "createRoom" | "joinRoom" | ..., data: {...} }
// Service role key bypasses RLS for trusted server operations.
// Public access (no auth) — identity is the client-generated device_id.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  applyAction,
  createMatch,
  legalActions,
  startNextRound,
} from "./_shared/engine.ts";
import { botDecide, type BotHints } from "./_shared/bot.ts";
import {
  adviceFromAnswer,
  hasGoodTrucCard,
  isBotOpeningForTeam,
  partnerAnswerFor,
  pickQuestion,
  shouldConsultPartner,
  type PartnerAdvice,
} from "./_shared/botConsult.ts";
import { cardStrength, playerTotalEnvit } from "./_shared/deck.ts";
import type { ChatPhraseId } from "./_shared/phrases.ts";
import { nextPlayer, partnerOf, teamOf } from "./_shared/types.ts";
import type { Action, MatchState, PlayerId } from "./_shared/types.ts";
import { tuningFromProfile, NEUTRAL_TUNING, applyDifficulty, type BotTuning, type PlayerProfile } from "./_shared/profileAdaptation.ts";
import {
  BOT_DELAY_MS,
  CONSULT_QUESTION_DELAY_MS,
  CONSULT_ANSWER_DELAY_MS,
  CONSULT_BOT_ANSWER_DELAY_MS,
  CONSULT_DECIDE_DELAY_MS,
  CONSULT_HUMAN_TIMEOUT_MS,
  SECOND_PLAYER_WAIT_MS,
  OPENER_WAIT_FOR_PARTNER_INFO_MS,
  PEU_SPONTANEOUS_INFO_DELAY_MS,
  PARTNER_BOT_INSTRUCTION_DELAY_MS,
  RIVAL_FIRST_TRICK_PRE_QUESTION_DELAY_MS,
  RIVAL_FIRST_TRICK_BUBBLE_MS,
  SHOUT_FLASH_HOLD_MS,
  SHOUT_FLASH_BUFFER_MS,
  LOW_LATENCY_ROUND_END_MS,
  LOW_LATENCY_ENVIT_REVEAL_ROUND_END_MS,
} from "./_shared/chatTimings.ts";

type SeatKind = "human" | "bot" | "empty";

interface RoomFullDTO {
  room: {
    id: string;
    code: string;
    status: "lobby" | "playing" | "finished" | "abandoned";
    targetCames: number;
    targetCama: number;
    turnTimeoutSec: number;
    initialMano: PlayerId;
    seatKinds: SeatKind[];
    hostDevice: string;
    matchState: MatchState | null;
    /** Server-anchored timestamp when the current turn started. */
    turnStartedAt: string | null;
    /** When non-null, the match is paused — no actions are accepted. */
    pausedAt: string | null;
    /** Collective proposal in flight (pause/restart). */
    pendingProposal: unknown | null;
  };
  players: { seat: PlayerId; name: string; deviceId: string; isOnline: boolean; lastSeen: string }[];
  mySeat: PlayerId | null;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ";
const DIGITS = "23456789";
function generateRoomCode(): string {
  let code = "";
  for (let i = 0; i < 4; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  for (let i = 0; i < 2; i++) code += DIGITS[Math.floor(Math.random() * DIGITS.length)];
  return code;
}

const SALA_SLUGS = ["la-falta", "truquers", "joc-fora", "9-bones"] as const;
const FROZEN_PLACEHOLDER_CODES: Record<string, readonly string[]> = {
  "la-falta": ["QB4UPU", "P0QR8C", "OT3VU6", "NISIAP", "U7KT62", "TGMJ3T", "STVTLQ", "RIFK8T", "IFYH1H", "H71P72", "ZJLZKX", "006UZH"],
  "truquers": ["9ECCHX", "ADULW0", "78IWA5", "8RR2T6", "5D8I5G", "6Y8P41", "3FKWZI", "4C9DGD", "HQZS14", "IXSI9D", "MQRBW1", "LPCRMR"],
  "joc-fora": ["1IUGRD", "2DDRF9", "ZFA5WA", "0VXM28", "5U69ME", "6L4LMX", "3SSVCA", "4BHJ9H", "TP5H9W", "U67UNK", "E0B32M", "DZF3DX"],
  "9-bones": ["BG6QQG", "CFINU0", "DEZB29", "EPX0XZ", "F08VX6", "G79EFY", "HYGEQD", "I5XH77", "3SC4Q6", "435VMN", "8MM1PL", "7WKFKR"],
};

function normalizeCode(code: unknown): string {
  return typeof code === "string" ? code.trim().toUpperCase() : "";
}

function frozenSalaForCode(code: unknown): string | null {
  const normalized = normalizeCode(code);
  for (const slug of SALA_SLUGS) {
    if (FROZEN_PLACEHOLDER_CODES[slug]?.includes(normalized)) return slug;
  }
  return null;
}

function frozenSlotForCode(slug: string, code: unknown): number | null {
  const idx = FROZEN_PLACEHOLDER_CODES[slug]?.indexOf(normalizeCode(code)) ?? -1;
  return idx >= 0 ? idx : null;
}

function maskMatchStateForSeat(state: MatchState, mySeat: PlayerId | null): MatchState {
  const r = state.round;
  const hands = r.hands;

  // When the round has ended and envit was accepted (not rejected), reveal
  // all hands so the client can run the envit reveal animation with the
  // real cards instead of the masked ace-of-oros placeholders.
  const revealAll =
    (r.phase === "round-end" || r.phase === "game-end") &&
    r.envitState.kind === "accepted";

  const masked: MatchState["round"]["hands"] = { 0: [], 1: [], 2: [], 3: [] };
  for (const p of [0, 1, 2, 3] as PlayerId[]) {
    if (p === mySeat || revealAll) {
      masked[p] = hands[p].map((c) => ({ ...c }));
    } else {
      masked[p] = hands[p].map((_, i) => ({ id: `hidden-${p}-${i}`, suit: "oros", rank: 1 } as never));
    }
  }
  return { ...state, round: { ...state.round, hands: masked } };
}

interface RoomRow {
  id: string;
  code: string;
  status: "lobby" | "playing" | "finished" | "abandoned";
  target_cames: number;
  target_cama?: number;
  turn_timeout_sec?: number;
  initial_mano: number;
  seat_kinds: SeatKind[];
  host_device: string;
  match_state: MatchState | null;
  bot_intents?: BotIntents;
  turn_started_at?: string | null;
  paused_at?: string | null;
  pending_proposal?: unknown | null;
}

interface PlayerRow {
  seat: number;
  device_id: string;
  name: string;
  is_online: boolean;
  last_seen: string;
}

function buildFullDTO(room: RoomRow, players: PlayerRow[], myDeviceId: string | null): RoomFullDTO {
  const me = myDeviceId ? players.find((p) => p.device_id === myDeviceId) ?? null : null;
  const mySeat = me ? (me.seat as PlayerId) : null;
  const matchState = room.match_state ? maskMatchStateForSeat(room.match_state, mySeat) : null;
  return {
    room: {
      id: room.id,
      code: room.code,
      status: room.status,
      targetCames: room.target_cames,
      targetCama: room.target_cama ?? 12,
      turnTimeoutSec: room.turn_timeout_sec ?? 30,
      initialMano: room.initial_mano as PlayerId,
      seatKinds: room.seat_kinds,
      hostDevice: room.host_device,
      matchState,
      turnStartedAt: room.turn_started_at ?? null,
      pausedAt: room.paused_at ?? null,
      pendingProposal: (room.pending_proposal ?? null) as RoomFullDTO["room"]["pendingProposal"],
    },
    players: players.map((p) => ({
      seat: p.seat as PlayerId,
      name: p.name,
      deviceId: p.device_id,
      isOnline: p.is_online,
      lastSeen: p.last_seen,
    })),
    mySeat,
  };
}

/**
 * Returns the seat (0..3) that is currently expected to act, or null if none.
 * Used to decide whether the "turn" has changed across two states (and thus
 * whether to bump `turn_started_at`).
 */
function currentActor(state: MatchState | null): PlayerId | null {
  if (!state) return null;
  const r = state.round;
  if (r.phase === "game-end" || r.phase === "round-end") return null;
  for (const p of [0, 1, 2, 3] as PlayerId[]) {
    if (legalActions(state, p).length === 0) continue;
    if (
      (r.envitState.kind === "pending" && r.envitState.awaitingTeam === (p % 2 === 0 ? "nos" : "ells")) ||
      (r.trucState.kind === "pending" && r.trucState.awaitingTeam === (p % 2 === 0 ? "nos" : "ells")) ||
      r.turn === p
    ) {
      return p;
    }
  }
  return null;
}

function localBotActorForValidation(state: MatchState): PlayerId | null {
  const r = state.round;
  if (r.phase === "game-end" || r.phase === "round-end") return null;
  for (const p of [0, 1, 2, 3] as PlayerId[]) {
    const acts = legalActions(state, p);
    if (acts.length > 0) {
      if (
        (r.envitState.kind === "pending" && r.envitState.awaitingTeam === (p % 2 === 0 ? "nos" : "ells")) ||
        (r.trucState.kind === "pending" && r.trucState.awaitingTeam === (p % 2 === 0 ? "nos" : "ells")) ||
        r.turn === p
      ) {
        return p;
      }
    }
  }
  return null;
}

function logBotOrderInconsistency(roomId: string, reason: string, state: MatchState, details: Record<string, unknown>) {
  const r = state.round;
  console.warn("[online-bot-order-inconsistency]", JSON.stringify({
    roomId,
    reason,
    phase: r.phase,
    turn: r.turn,
    envitState: r.envitState.kind,
    envitAwaitingTeam: r.envitState.kind === "pending" ? r.envitState.awaitingTeam : null,
    trucState: r.trucState.kind,
    trucAwaitingTeam: r.trucState.kind === "pending" ? r.trucState.awaitingTeam : null,
    trickIdx: r.tricks.length - 1,
    historyLen: state.history.length,
    ...details,
  }));
}

/**
 * Decides the new value for `turn_started_at`:
 *   - If the actor changed compared to `prevState`, anchor to `now`.
 *   - Otherwise keep the previous timestamp so countdowns don't restart on
 *     unrelated row updates (chat, presence-driven re-saves, etc.).
 */
function computeTurnStartedAt(
  prevState: MatchState | null,
  nextState: MatchState | null,
  prevTurnStartedAt: string | null,
): string | null {
  const nextActor = currentActor(nextState);
  if (nextActor == null) return null;
  const prevActor = currentActor(prevState);
  if (prevActor === nextActor && prevTurnStartedAt) return prevTurnStartedAt;
  return new Date().toISOString();
}

function matchLog(state: MatchState) {
  return Array.isArray((state as any).log) ? (state as any).log as MatchState["log"] : [];
}

function matchHistory(state: MatchState) {
  return Array.isArray((state as any).history) ? (state as any).history as MatchState["history"] : [];
}

interface BotIntents {
  cardHint?: Record<number, "fort" | "molesto" | "tres">;
  playStrength?: Record<number, "low" | "high" | "free" | "vine-a-vore" | "vine-al-meu-tres" | "tinc-un-tres">;
  silentTruc?: Record<number, boolean>;
  foldTruc?: Record<number, boolean>;
  forceTruc?: Record<number, boolean>;
  forceEnvit?: Record<number, boolean>;
  pendingChainedTruc?: Record<number, boolean>;
  chatSignals?: Record<number, ChatPhraseId[]>;
  botFlow?: {
    id: string;
    actor: PlayerId;
    kind:
      | "action"
      | "consult-question"
      | "consult-answer"
      | "consult-decide"
      | "second-wait"
      | "truc-envit-wait"
      | "opener-wait"
      | "peu-info"
      | "round-end";
    dueAt: string;
    payload?: Record<string, unknown>;
  } | null;
}

function nowMs(): number {
  return Date.now();
}

function dueIso(delayMs: number): string {
  return new Date(nowMs() + Math.max(0, delayMs)).toISOString();
}

function scheduleBotFlow(
  intents: BotIntents,
  flow: NonNullable<BotIntents["botFlow"]>,
): null {
  intents.botFlow = flow;
  return null;
}

function clearBotFlow(intents: BotIntents) {
  intents.botFlow = null;
}

function flowDue(flow: NonNullable<BotIntents["botFlow"]>): boolean {
  return new Date(flow.dueAt).getTime() <= nowMs();
}

function currentFlowId(state: MatchState, actor: PlayerId): string {
  const r = state.round;
  return `${matchHistory(state).length}-${Math.max(0, r.tricks.length - 1)}-${actor}-${r.turn}-${r.envitState.kind}-${r.trucState.kind}`;
}

function hintsForBot(intents: BotIntents, seat: PlayerId): BotHints {
  const myTeam = teamOf(seat);
  const rivalShownStrength = Object.entries(intents.chatSignals ?? {}).some(([player, phrases]) => {
    if (teamOf(Number(player) as PlayerId) === myTeam) return false;
    return phrases.includes("vine-a-mi") || phrases.includes("tinc-bona");
  });
  return {
    cardHint: intents.cardHint?.[seat] ?? null,
    playStrength: intents.playStrength?.[seat] ?? null,
    silentTruc: intents.silentTruc?.[seat] ?? false,
    foldTruc: intents.foldTruc?.[seat] ?? false,
    forceTruc: !!intents.forceTruc?.[seat] || !!intents.pendingChainedTruc?.[seat],
    forceEnvit: !!intents.forceEnvit?.[seat],
    rivalShownStrength: rivalShownStrength || undefined,
  };
}

function isPlayCardTurn(state: MatchState, actor: PlayerId): boolean {
  const r = state.round;
  return r.turn === actor &&
    r.envitState.kind !== "pending" &&
    r.trucState.kind !== "pending" &&
    (r.phase === "playing" || (r.phase === "envit" && r.tricks.length === 1));
}

function firstPendingResponseActor(state: MatchState, actor: PlayerId): boolean {
  const r = state.round;
  return (r.envitState.kind === "pending" && r.envitState.awaitingTeam === teamOf(actor)) ||
    (r.trucState.kind === "pending" && r.trucState.awaitingTeam === teamOf(actor));
}

function isFirstOfPair(player: PlayerId, mano: PlayerId): boolean {
  return ((player - mano + 4) % 4) < ((partnerOf(player) - mano + 4) % 4);
}

function recordBotChat(intents: BotIntents, seat: PlayerId, phraseId: ChatPhraseId) {
  intents.chatSignals ??= {};
  intents.chatSignals[seat] ??= [];
  intents.chatSignals[seat].push(phraseId);
  intents.playStrength ??= {};
  if (phraseId === "vine-a-vore" || phraseId === "vine-al-meu-tres" || phraseId === "tinc-un-tres") {
    intents.playStrength[seat] = phraseId;
  }
  const partner = partnerOf(seat);
  if (
    phraseId === "vine-a-mi" ||
    phraseId === "vine-al-meu-tres" ||
    phraseId === "vine-a-vore"
  ) intents.playStrength[partner] = "low";
  else if (phraseId === "tinc-bona" || phraseId === "tinc-un-tres") intents.playStrength[partner] = "free";
  else if (phraseId === "a-tu" || phraseId === "no-tinc-res") intents.playStrength[partner] = "high";

  intents.cardHint ??= {};
  intents.silentTruc ??= {};
  intents.foldTruc ??= {};
  if (phraseId === "pon-fort") intents.cardHint[partner] = "fort";
  else if (phraseId === "pon-molesto") intents.cardHint[partner] = "molesto";
  else if (phraseId === "vine-al-teu-tres") intents.cardHint[partner] = "tres";
  else if (phraseId === "juega-callado") intents.silentTruc[partner] = true;
  else if (phraseId === "truca") (intents.forceTruc ??= {})[partner] = true;
  else if (phraseId === "envida") (intents.forceEnvit ??= {})[partner] = true;
  else if (phraseId === "vamonos") intents.foldTruc[partner] = true;
}

function rivalSaidNoTincRes(intents: BotIntents, player: PlayerId): boolean {
  const playerTeam = teamOf(player);
  return Object.entries(intents.chatSignals ?? {}).some(([p, phrases]) => {
    if (teamOf(Number(p) as PlayerId) === playerTeam) return false;
    return phrases.includes("no-tinc-res");
  });
}

function shouldWaitForResponseFlash(state: MatchState): boolean {
  const log = matchLog(state);
  const last = log[log.length - 1];
  return !!last && last.action.type === "shout" &&
    (last.action.what === "vull" || last.action.what === "no-vull");
}

function botActionBaseDelayMs(state: MatchState, actor: PlayerId): number {
  let delay = BOT_DELAY_MS;
  const r = state.round;
  const firstTrick = r.tricks[0];
  const aboutToPlayCard =
    r.turn === actor &&
    r.envitState.kind !== "pending" &&
    r.trucState.kind !== "pending" &&
    (r.phase === "envit" || (r.phase === "playing" && r.tricks.length === 1));
  if (firstTrick && aboutToPlayCard && !r.envitResolved && firstTrick.cards.length < 4) {
    const peuNos: PlayerId = teamOf(r.mano) === "nos" ? partnerOf(r.mano) : partnerOf(nextPlayer(r.mano));
    const peuElls: PlayerId = teamOf(r.mano) === "ells" ? partnerOf(r.mano) : partnerOf(nextPlayer(r.mano));
    const actorIsPeu = actor === peuNos || actor === peuElls;
    const partnerHasNotPlayedYet = !firstTrick.cards.some((tc) => tc.player === partnerOf(actor));
    if (actorIsPeu && partnerHasNotPlayedYet) delay = Math.max(delay, SECOND_PLAYER_WAIT_MS);
  }
  if (shouldWaitForResponseFlash(state)) delay = Math.max(delay, SHOUT_FLASH_HOLD_MS + SHOUT_FLASH_BUFFER_MS);
  return delay;
}

async function insertBotChat(roomId: string, seat: PlayerId, phraseId: ChatPhraseId) {
  await admin.from("room_chat").insert({ room_id: roomId, seat, phrase_id: phraseId });
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function botReplyToHumanQuestion(
  state: MatchState,
  botSeat: PlayerId,
  question: ChatPhraseId,
  intents: BotIntents,
  bluffRate: number,
): ChatPhraseId | null {
  const r = state.round;
  if (question === "tens-envit") {
    const envit = playerTotalEnvit(r, botSeat);
    if (envit >= 31) return Math.random() < 0.5 ? "envida" : "si";
    if (envit === 30) return Math.random() < 0.25 ? "si-tinc-n" : "si";
    return "no";
  }
  if (question === "vols-envide") {
    const envit = playerTotalEnvit(r, botSeat);
    if (envit >= 31) return Math.random() < 0.5 ? "envida" : "si";
    if (envit === 29 || envit === 30) return Math.random() < 0.25 ? "si-tinc-n" : "no";
    return "no";
  }
  if (question === "quant-envit") return "si-tinc-n";
  if (question === "puc-anar" || question === "que-tens" || question === "portes-un-tres" || question === "tens-mes-dun-tres") {
    return partnerAnswerFor(state, botSeat, question, bluffRate, { rivalSaidNoTincRes: rivalSaidNoTincRes(intents, botSeat) });
  }
  return null;
}

function botInfoPhrases(): ChatPhraseId[] {
  return [
    "vine-a-mi", "vine-a-vore", "vine-al-meu-tres", "vine-al-teu-tres",
    "tinc-bona", "tinc-un-tres", "a-tu", "no-tinc-res",
  ];
}

function envitInstructionPhrases(): ChatPhraseId[] {
  return ["envida", "tira-falta", "si", "no", "si-tinc-n"];
}

function coerceAdvice(value: unknown): PartnerAdvice {
  return value === "strong" || value === "three" || value === "weak" || value === "neutral"
    ? value
    : "neutral";
}

function buildEnvitInstructionAction(
  state: MatchState,
  actor: PlayerId,
  instruction: ChatPhraseId | null,
): Action | null {
  const acts = legalActions(state, actor);
  const myEnvit = playerTotalEnvit(state.round, actor);
  const canEnvit = acts.some((a) => a.type === "shout" && a.what === "envit");
  if (instruction === "envida" || instruction === "tira-falta") {
    const desired = instruction === "tira-falta" ? "falta-envit" : "envit";
    return acts.find((a) => a.type === "shout" && a.what === desired) ??
      acts.find((a) => a.type === "shout" && a.what === "envit") ??
      null;
  }
  if (canEnvit && (instruction === "si" || instruction === "si-tinc-n")) return { type: "shout", what: "envit" };
  if (canEnvit && instruction === "no" && myEnvit >= 30 && Math.random() < 0.4) return { type: "shout", what: "envit" };
  return null;
}

async function decideOnlineBotAction(
  roomId: string,
  state: MatchState,
  actor: PlayerId,
  seatKinds: SeatKind[],
  intents: BotIntents,
  tuning: BotTuning,
  bluffRate: number,
): Promise<Action | null> {
  intents.cardHint ??= {};
  intents.playStrength ??= {};
  intents.silentTruc ??= {};
  intents.foldTruc ??= {};
  intents.forceTruc ??= {};
  intents.forceEnvit ??= {};
  intents.pendingChainedTruc ??= {};
  intents.chatSignals ??= {};

  const r = state.round;
  const trickIdx = Math.max(0, r.tricks.length - 1);
  const flowId = currentFlowId(state, actor);
  const questionDelayMs = trickIdx === 0 && isPlayCardTurn(state, actor) && partnerOf(actor) !== 0 && isBotOpeningForTeam(state, actor)
    ? RIVAL_FIRST_TRICK_PRE_QUESTION_DELAY_MS
    : CONSULT_QUESTION_DELAY_MS;
  const answerDelayMs = CONSULT_BOT_ANSWER_DELAY_MS;
  const decideDelayMs = trickIdx === 0 && isPlayCardTurn(state, actor) && partnerOf(actor) !== 0 && isBotOpeningForTeam(state, actor)
    ? RIVAL_FIRST_TRICK_BUBBLE_MS
    : CONSULT_DECIDE_DELAY_MS;

  const existing = intents.botFlow;
  if (existing && (existing.actor !== actor || existing.id !== flowId)) {
    clearBotFlow(intents);
  }
  if (intents.botFlow && intents.botFlow.actor === actor && intents.botFlow.id === flowId) {
    if (!flowDue(intents.botFlow)) return null;
    const payload = intents.botFlow.payload ?? {};
    switch (intents.botFlow.kind) {
      case "peu-info": {
        const speaker = Number(payload.speaker) as PlayerId;
        const phrase = payload.phrase as ChatPhraseId;
        await insertBotChat(roomId, speaker, phrase);
        recordBotChat(intents, speaker, phrase);
        clearBotFlow(intents);
        return null;
      }
      case "action": {
        clearBotFlow(intents);
        return (payload.action as Action | undefined) ?? null;
      }
      case "consult-question": {
        const question = payload.question as ChatPhraseId;
        const partner = Number(payload.partner) as PlayerId;
        await insertBotChat(roomId, actor, question);
        recordBotChat(intents, actor, question);
        if (seatKinds[partner] === "bot") {
          const answer = (payload.answer as ChatPhraseId | undefined) ??
            partnerAnswerFor(state, partner, question, bluffRate, { rivalSaidNoTincRes: rivalSaidNoTincRes(intents, partner) });
          scheduleBotFlow(intents, {
            id: flowId,
            actor,
            kind: "consult-answer",
            dueAt: dueIso(answerDelayMs),
            payload: { question, partner, answer },
          });
          return null;
        }
        scheduleBotFlow(intents, {
          id: flowId,
          actor,
          kind: "consult-decide",
          dueAt: dueIso(CONSULT_HUMAN_TIMEOUT_MS),
          payload: { question, partner, advice: "neutral", awaitingHuman: true },
        });
        return null;
      }
      case "consult-answer": {
        const question = payload.question as ChatPhraseId;
        const partner = Number(payload.partner) as PlayerId;
        const answer = payload.answer as ChatPhraseId;
        await insertBotChat(roomId, partner, answer);
        recordBotChat(intents, partner, answer);
        scheduleBotFlow(intents, {
          id: flowId,
          actor,
          kind: "consult-decide",
          dueAt: dueIso(decideDelayMs),
          payload: {
            question,
            partner,
            advice: adviceFromAnswer(answer, question),
            // Si el company respon "no" a "Vols tornar a envidar?", el bot
            // accepta l'envit del rival amb "Vull" (té envit suficient).
            forceVull: question === "vols-tornar-envidar" && answer === "no",
          },
        });
        return null;
      }
      case "consult-decide": {
        clearBotFlow(intents);
        const advice = coerceAdvice(payload.advice);
        if (payload.forceNoVull === true) {
          const noVull = legalActions(state, actor).find(
            (a) => a.type === "shout" && a.what === "no-vull",
          );
          if (noVull) return noVull;
        }
        return botDecide(state, actor, advice, hintsForBot(intents, actor), tuning, bluffRate);
      }
      case "second-wait": {
        const stage = String(payload.stage ?? "timeout");
        const partner = Number(payload.partner) as PlayerId;
        if (stage === "ask") {
          await insertBotChat(roomId, actor, "vols-envide");
          recordBotChat(intents, actor, "vols-envide");
          if (seatKinds[partner] === "bot") {
            const answer = partnerAnswerFor(state, partner, "vols-envide", bluffRate);
            scheduleBotFlow(intents, {
              id: flowId,
              actor,
              kind: "second-wait",
              dueAt: dueIso(CONSULT_BOT_ANSWER_DELAY_MS),
              payload: { stage: "answer", partner, answer },
            });
          } else {
            scheduleBotFlow(intents, {
              id: flowId,
              actor,
              kind: "second-wait",
              dueAt: dueIso(CONSULT_HUMAN_TIMEOUT_MS),
              payload: { stage: "finalize", partner, instruction: null, awaitingHuman: true },
            });
          }
          return null;
        }
        if (stage === "answer") {
          const answer = payload.answer as ChatPhraseId;
          await insertBotChat(roomId, partner, answer);
          recordBotChat(intents, partner, answer);
          const instruction: ChatPhraseId = answer === "si" || answer === "si-tinc-n" ? "envida" : answer;
          scheduleBotFlow(intents, {
            id: flowId,
            actor,
            kind: "second-wait",
            dueAt: dueIso(CONSULT_DECIDE_DELAY_MS),
            payload: { stage: "finalize", partner, instruction },
          });
          return null;
        }
        if (stage === "partner-instruction") {
          const instruction = payload.instruction as ChatPhraseId;
          await insertBotChat(roomId, partner, instruction);
          recordBotChat(intents, partner, instruction);
          scheduleBotFlow(intents, {
            id: flowId,
            actor,
            kind: "second-wait",
            dueAt: dueIso(CONSULT_DECIDE_DELAY_MS),
            payload: { stage: "finalize", partner, instruction },
          });
          return null;
        }
        clearBotFlow(intents);
        const instruction = (payload.instruction as ChatPhraseId | null | undefined) ?? null;
        return buildEnvitInstructionAction(state, actor, instruction) ??
          botDecide(state, actor, "neutral", hintsForBot(intents, actor), tuning, bluffRate);
      }
      case "opener-wait": {
        const advice = payload.advice == null ? null : coerceAdvice(payload.advice);
        if (advice) {
          scheduleBotFlow(intents, {
            id: flowId,
            actor,
            kind: "consult-decide",
            dueAt: dueIso(CONSULT_DECIDE_DELAY_MS),
            payload: { advice },
          });
          return null;
        }
        const hand = state.round.hands[actor] ?? [];
        const strengths = hand.map((c) => cardStrength(c)).sort((a, b) => b - a);
        const polarized = (strengths[0] ?? 0) >= 65 && (strengths[strengths.length - 1] ?? 0) <= 30 && hand.length >= 2;
        if (polarized) {
          const question: ChatPhraseId = Math.random() < 0.5 ? "que-tens" : "puc-anar";
          scheduleBotFlow(intents, {
            id: flowId,
            actor,
            kind: "consult-question",
            dueAt: dueIso(CONSULT_QUESTION_DELAY_MS),
            payload: { question, partner: partnerOf(actor) },
          });
          return null;
        }
        scheduleBotFlow(intents, {
          id: flowId,
          actor,
          kind: "consult-decide",
          dueAt: dueIso(CONSULT_DECIDE_DELAY_MS),
          payload: { advice: "neutral" },
        });
        return null;
      }
      case "truc-envit-wait": {
        const stage = String(payload.stage ?? "finalize");
        const partner = Number(payload.partner) as PlayerId;
        if (stage === "ask") {
          await insertBotChat(roomId, actor, "vols-envide");
          recordBotChat(intents, actor, "vols-envide");
          if (seatKinds[partner] === "bot") {
            const answer = partnerAnswerFor(state, partner, "vols-envide", bluffRate);
            scheduleBotFlow(intents, {
              id: flowId,
              actor,
              kind: "truc-envit-wait",
              dueAt: dueIso(CONSULT_BOT_ANSWER_DELAY_MS),
              payload: { stage: "answer", partner, answer },
            });
          } else {
            scheduleBotFlow(intents, {
              id: flowId,
              actor,
              kind: "truc-envit-wait",
              dueAt: dueIso(CONSULT_HUMAN_TIMEOUT_MS),
              payload: { stage: "finalize", partner, instruction: null, awaitingHuman: true },
            });
          }
          return null;
        }
        if (stage === "answer") {
          const answer = payload.answer as ChatPhraseId;
          await insertBotChat(roomId, partner, answer);
          recordBotChat(intents, partner, answer);
          const instruction: ChatPhraseId = answer === "si" || answer === "si-tinc-n" ? "envida" : answer;
          scheduleBotFlow(intents, {
            id: flowId,
            actor,
            kind: "truc-envit-wait",
            dueAt: dueIso(CONSULT_DECIDE_DELAY_MS),
            payload: { stage: "finalize", partner, instruction },
          });
          return null;
        }
        clearBotFlow(intents);
        const instruction = (payload.instruction as ChatPhraseId | null | undefined) ?? null;
        const acts = legalActions(state, actor);
        const envitAct = acts.find((a) => a.type === "shout" && a.what === "envit");
        if (envitAct && (instruction === "envida" || instruction === "si" || instruction === "si-tinc-n")) {
          return envitAct;
        }
        return botDecide(state, actor, "neutral", hintsForBot(intents, actor), tuning, bluffRate);
      }
      case "round-end":
        return null;
    }
  }

  if (isPlayCardTurn(state, actor) && trickIdx === 0 && isBotOpeningForTeam(state, actor)) {
    const partner = partnerOf(actor);
    const firstTrick = r.tricks[0];
    const partnerIsPeuBot = seatKinds[partner] === "bot" && firstTrick && !firstTrick.cards.some((tc) => tc.player === partner);
    const alreadySaidInfo = (intents.chatSignals?.[partner] ?? []).some((p) => botInfoPhrases().includes(p));
    if (partnerIsPeuBot && firstTrick.cards.length > 0 && !alreadySaidInfo && Math.random() < 0.55) {
      let phrase = partnerAnswerFor(state, partner, "que-tens", bluffRate, { rivalSaidNoTincRes: rivalSaidNoTincRes(intents, partner) });
      // Cas especial: si a la mesa ja hi ha una carta TOP (força ≥70:
      // 3, 7 oros, 7 espases, As bastos, As espases) jugada per un
      // RIVAL del peu-bot, la resposta espontània al company ha de ser
      // binària segons si el peu-bot pot guanyar-la o no:
      //   · Pot guanyar-la → "Vine a mi!"
      //   · No pot guanyar-la → "A tu!"
      // Mai "Tinc un 3" en aquest context (mateix comportament que offline).
      const peuTeam = teamOf(partner);
      let bestRivalTopOnTable = -1;
      for (const tc of firstTrick.cards) {
        if (teamOf(tc.player) === peuTeam) continue;
        const s = cardStrength(tc.card);
        if (s >= 70 && s > bestRivalTopOnTable) bestRivalTopOnTable = s;
      }
      if (bestRivalTopOnTable >= 70) {
        const peuHand = state.round.hands[partner] ?? [];
        const canBeatTop = peuHand.some((c) => cardStrength(c) > bestRivalTopOnTable);
        const lieBin = bluffRate > 0 && Math.random() < bluffRate;
        const truth: ChatPhraseId = canBeatTop ? "vine-a-mi" : "a-tu";
        phrase = lieBin ? (canBeatTop ? "a-tu" : "vine-a-mi") : truth;
      }
      // Iniciativa espontània (el company NO ha preguntat res): si no té
      // res, ha de dir "A tu!" i mai "No tinc res". "No tinc res" només
      // és vàlid com a resposta a "Que tens?" o "Puc anar a tu?".
      if (phrase === "no-tinc-res") {
        phrase = "a-tu";
      }
      return scheduleBotFlow(intents, {
        id: flowId,
        actor,
        kind: "peu-info",
        dueAt: dueIso(PEU_SPONTANEOUS_INFO_DELAY_MS),
        payload: { speaker: partner, phrase },
      });
    }
    const partnerSaid = (intents.chatSignals?.[partner] ?? []).filter((p) => botInfoPhrases().includes(p));
    if (partnerSaid.length > 0) {
      const advice = adviceFromAnswer(partnerSaid[partnerSaid.length - 1]!);
      return scheduleBotFlow(intents, {
        id: flowId,
        actor,
        kind: "consult-decide",
        dueAt: dueIso(decideDelayMs),
        payload: { advice },
      });
    }
  }

  if (isPlayCardTurn(state, actor) && trickIdx === 0 && isBotOpeningForTeam(state, actor) && !hasGoodTrucCard(state, actor)) {
    const action = botDecide(state, actor, "weak", hintsForBot(intents, actor), tuning, bluffRate);
    return action ? scheduleBotFlow(intents, { id: flowId, actor, kind: "action", dueAt: dueIso(questionDelayMs), payload: { action } }) : null;
  }

  const firstTrick = r.tricks[0];
  const partner = partnerOf(actor);
  const peuNos: PlayerId = teamOf(r.mano) === "nos" ? partnerOf(r.mano) : partnerOf(nextPlayer(r.mano));
  const peuElls: PlayerId = teamOf(r.mano) === "ells" ? partnerOf(r.mano) : partnerOf(nextPlayer(r.mano));
  const isSecondToPlayFirstTrick = !!firstTrick &&
    isPlayCardTurn(state, actor) &&
    trickIdx === 0 &&
    (actor === peuNos || actor === peuElls) &&
    firstTrick.cards.some((tc) => tc.player === partner) &&
    !firstTrick.cards.some((tc) => tc.player === actor) &&
    r.envitState.kind === "none" &&
    !r.envitResolved;
  if (isSecondToPlayFirstTrick) {
    const myEnvit = playerTotalEnvit(r, actor);
    const canEnvit = legalActions(state, actor).some((a) => a.type === "shout" && a.what === "envit");
    if (canEnvit && myEnvit >= 31) return scheduleBotFlow(intents, { id: flowId, actor, kind: "action", dueAt: dueIso(BOT_DELAY_MS), payload: { action: { type: "shout", what: "envit" } } });
    if (canEnvit && myEnvit >= 30 && Math.random() < 0.8) return scheduleBotFlow(intents, { id: flowId, actor, kind: "action", dueAt: dueIso(BOT_DELAY_MS), payload: { action: { type: "shout", what: "envit" } } });

    // Cas especial: si el peu-bot és el 4t en tirar a la 1a baza (ja hi
    // ha 3 cartes a la mesa) i amb la seua millor carta no pot guanyar
    // la baza, no espera ni depèn de probabilitat: pregunta directament
    // "Tens envit?" al company i actua segons la resposta.
    const cardsOnTable = firstTrick.cards;
    const isFourthToPlay = cardsOnTable.length === 3;
    const myHand = r.hands[actor] ?? [];
    const myBestStrength = myHand.length > 0 ? Math.max(...myHand.map((c) => cardStrength(c))) : -Infinity;
    const tableBestStrength = cardsOnTable.length > 0
      ? Math.max(...cardsOnTable.map((tc) => cardStrength(tc.card)))
      : -Infinity;
    const cannotWinTrick = myBestStrength <= tableBestStrength;
    const askDirectlyNoWait = canEnvit && isFourthToPlay && cannotWinTrick;

    if (askDirectlyNoWait) {
      // Pregunta sense esperar: dueAt mínim (0 ms) per a anar directament a "ask".
      return scheduleBotFlow(intents, { id: flowId, actor, kind: "second-wait", dueAt: dueIso(0), payload: { stage: "ask", partner } });
    }
    if (canEnvit && Math.random() < 0.35) {
      return scheduleBotFlow(intents, { id: flowId, actor, kind: "second-wait", dueAt: dueIso(CONSULT_QUESTION_DELAY_MS), payload: { stage: "ask", partner } });
    }
    if (seatKinds[partner] === "bot") {
      const partnerEnvit = playerTotalEnvit(r, partner);
      const trapPartner = partnerEnvit >= 32 && Math.random() < 0.75;
      if (!trapPartner && partnerEnvit >= 30) {
        // El bot primer de la parella en la 1a baza sempre diu "Envida!"
        // (mai "Tira la falta!"), encara que tinga 33: és més probable que
        // el rival accepte l'envit simple i així es guanyen més pedres.
        const instruction: ChatPhraseId = "envida";
        return scheduleBotFlow(intents, { id: flowId, actor, kind: "second-wait", dueAt: dueIso(PARTNER_BOT_INSTRUCTION_DELAY_MS), payload: { stage: "partner-instruction", partner, instruction } });
      }
    }
    return scheduleBotFlow(intents, { id: flowId, actor, kind: "second-wait", dueAt: dueIso(SECOND_PLAYER_WAIT_MS), payload: { stage: "finalize", partner, instruction: null } });
  }

  // Davant d'una falta-envit pendent, els bots no han de preguntar res del
  // joc de cartes (puc-anar/que-tens) ni "Vols tornar a envidar?" (no es pot
  // pujar més). Pregunten al company "Quant envit tens?" i el company respon
  // amb el seu valor real ("Tinc {n}", calculat al client). Després el bot
  // decideix amb la regla de falta de `decideEnvitResponse`.
  if (
    firstPendingResponseActor(state, actor) &&
    r.envitState.kind === "pending" &&
    r.envitState.level === "falta"
  ) {
    const partnerForFalta = partnerOf(actor);
    const partnerSpokenFalta = (intents.chatSignals?.[partnerForFalta] ?? []) as ChatPhraseId[];
    const alreadyAsked = partnerSpokenFalta.includes("si-tinc-n");
    if (!alreadyAsked) {
      return scheduleBotFlow(intents, {
        id: flowId,
        actor,
        kind: "consult-question",
        dueAt: dueIso(questionDelayMs),
        payload: { question: "quant-envit", partner: partnerForFalta, answer: "si-tinc-n" },
      });
    }
    // Ja consultat: decideix directament.
    const action = botDecide(state, actor, "neutral", hintsForBot(intents, actor), tuning, bluffRate);
    return action ? scheduleBotFlow(intents, { id: flowId, actor, kind: "action", dueAt: dueIso(decideDelayMs), payload: { action } }) : null;
  }

  // Fast-path: davant d'un envit del rival (no falta), si el bot té 33
  // d'envit o 32 essent mà sobre el caller, RENVIDA directament sense
  // consultar el company.
  if (
    firstPendingResponseActor(state, actor) &&
    r.envitState.kind === "pending" &&
    r.envitState.level !== "falta"
  ) {
    const myEnvitNow = playerTotalEnvit(r, actor);
    const acts = legalActions(state, actor);
    const renvitAct = acts.find(
      (a) => a.type === "shout" && (a.what === "renvit" || a.what === "falta-envit"),
    );
    const partnerSeat = partnerOf(actor);
    const partnerRejected = (r.envitState.rejectedBy ?? []).includes(partnerSeat);
    let manoPriorityOverCaller = false;
    const callerEnv = r.envitState.calledBy;
    let pm: PlayerId = r.mano;
    for (let i = 0; i < 4; i++) {
      if (pm === actor) { manoPriorityOverCaller = true; break; }
      if (pm === callerEnv) { manoPriorityOverCaller = false; break; }
      pm = ((pm + 1) % 4) as PlayerId;
    }
    const shouldRenvitDirect =
      !!renvitAct &&
      !partnerRejected &&
      (myEnvitNow >= 33 || (myEnvitNow === 32 && manoPriorityOverCaller));
    if (shouldRenvitDirect) {
      return scheduleBotFlow(intents, {
        id: flowId,
        actor,
        kind: "action",
        dueAt: dueIso(decideDelayMs),
        payload: { action: renvitAct },
      });
    }
  }

  // "Truc i passe!": davant d'un truc pendent en la 1a baza on encara
  // és possible envidar (l'engine ho permet), el bot consulta al company
  // "Vols envidar?" i, segons la resposta, envida o respon al truc. Si
  // ja té envit alt (≥30) envida directament sense consultar.
  if (firstPendingResponseActor(state, actor) && r.trucState.kind === "pending") {
    const actsTE = legalActions(state, actor);
    const envitActTE = actsTE.find((a) => a.type === "shout" && a.what === "envit");
    if (envitActTE) {
      const myEnvitTE = playerTotalEnvit(r, actor);
      if (myEnvitTE >= 30) {
        return scheduleBotFlow(intents, {
          id: flowId,
          actor,
          kind: "action",
          dueAt: dueIso(decideDelayMs),
          payload: { action: envitActTE },
        });
      }
      return scheduleBotFlow(intents, {
        id: flowId,
        actor,
        kind: "truc-envit-wait",
        dueAt: dueIso(questionDelayMs),
        payload: { stage: "ask", partner: partnerOf(actor) },
      });
    }
  }

  const shouldConsult =
    (isPlayCardTurn(state, actor) || firstPendingResponseActor(state, actor)) &&
    shouldConsultPartner(state, actor, tuning);
  if (shouldConsult) {
    if (
      isPlayCardTurn(state, actor) &&
      trickIdx === 0 &&
      isBotOpeningForTeam(state, actor) &&
      hasGoodTrucCard(state, actor) &&
      Math.random() < 0.5
    ) {
      return scheduleBotFlow(intents, { id: flowId, actor, kind: "opener-wait", dueAt: dueIso(OPENER_WAIT_FOR_PARTNER_INFO_MS), payload: {} });
    }
    const partnerForQ = partnerOf(actor);
    const partnerSpoken = (intents.chatSignals?.[partnerForQ] ?? []) as ChatPhraseId[];
    const question = pickQuestion(state, actor, partnerSpoken);
    if (question === null) {
      // Totes les preguntes possibles ja tenen resposta espontània del
      // company: no preguntem res. Si tenim alguna frase informativa
      // recent, l'usem com a advice; si no, neutral.
      const said = partnerSpoken.filter((p) => botInfoPhrases().includes(p));
      const advice: PartnerAdvice = said.length > 0
        ? adviceFromAnswer(said[said.length - 1]!)
        : "neutral";
      const action = botDecide(state, actor, advice, hintsForBot(intents, actor), tuning, bluffRate);
      return action ? scheduleBotFlow(intents, { id: flowId, actor, kind: "action", dueAt: dueIso(decideDelayMs), payload: { action } }) : null;
    }
    return scheduleBotFlow(intents, { id: flowId, actor, kind: "consult-question", dueAt: dueIso(questionDelayMs), payload: { question, partner: partnerForQ } });
  }

  const action = botDecide(state, actor, "neutral", hintsForBot(intents, actor), tuning, bluffRate);
  return action ? scheduleBotFlow(intents, { id: flowId, actor, kind: "action", dueAt: dueIso(botActionBaseDelayMs(state, actor)), payload: { action } }) : null;
}

function actionsEqual(a: Action, b: Action): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "play-card" && b.type === "play-card") return a.cardId === b.cardId;
  if (a.type === "shout" && b.type === "shout") return (a as any).what === (b as any).what;
  return false;
}

// Players whose `last_seen` is older than this are treated as bots so the
// match doesn't stall when somebody disconnects mid-game. They reclaim
// control automatically the moment they heartbeat or call getRoom.
const INACTIVITY_BOT_TAKEOVER_MS = 60_000;
const MAX_BOT_ACTIONS_PER_TICK = 1;

function roundEndVisualDelayMs(state: MatchState): number {
  const history = matchHistory(state);
  const lastSummary = history[history.length - 1];
  const envitRevealed = !!(
    lastSummary &&
    lastSummary.envitWinner &&
    !lastSummary.envitRejected &&
    lastSummary.envitPoints > 0
  );
  let delay = envitRevealed ? LOW_LATENCY_ENVIT_REVEAL_ROUND_END_MS : LOW_LATENCY_ROUND_END_MS;
  // Si la mà ha acabat amb un "No vull" al truc, apareix un cartell central
  // gran ("No vull") que cal mostrar sencer ABANS de començar la transició
  // de cartes quietes. Mateix comportament que la partida offline (que fa
  // `Math.max(delay, responseFlashRemainingMs() + LOW_LATENCY_ROUND_END_MS)`).
  if (lastSummary && (lastSummary as any).trucRejected) {
    delay = Math.max(delay, SHOUT_FLASH_HOLD_MS + SHOUT_FLASH_BUFFER_MS + LOW_LATENCY_ROUND_END_MS);
  }
  return delay;
}

/**
 * Returns a seat-kinds array where every "human" seat whose occupant has been
 * inactive for more than INACTIVITY_BOT_TAKEOVER_MS (or is missing entirely)
 * is treated as a "bot". Used to keep the game moving when a player drops.
 */
async function effectiveSeatKinds(
  roomId: string,
  baseSeatKinds: SeatKind[],
): Promise<SeatKind[]> {
  const { data: players } = await admin
    .from("room_players")
    .select("seat, last_seen, is_online")
    .eq("room_id", roomId);
  const now = Date.now();
  const result = [...baseSeatKinds];
  for (let s = 0; s < 4; s++) {
    if (result[s] !== "human") continue;
    const occupant = (players ?? []).find((p: any) => p.seat === s) as
      | { last_seen: string; is_online: boolean }
      | undefined;
    const lastSeen = occupant?.last_seen
      ? new Date(occupant.last_seen).getTime()
      : 0;
    const inactive = !occupant ||
      now - lastSeen > INACTIVITY_BOT_TAKEOVER_MS;
    if (inactive) result[s] = "bot";
  }
  return result;
}

/**
 * Executa una proposta col·lectiva ja aprovada (pause / restart).
 * `room` és la fila completa de `rooms`.
 */
async function executeProposal(room: any, kind: "pause" | "restart" | "resume"): Promise<{ ok: true }> {
  const nowIso = new Date().toISOString();
  if (kind === "pause") {
    await admin.from("rooms").update({
      paused_at: nowIso,
      updated_at: nowIso,
    }).eq("id", room.id);
    return { ok: true };
  }
  if (kind === "resume") {
    const update: Record<string, unknown> = {
      paused_at: null,
      updated_at: nowIso,
    };
    if ((room as any).match_state) {
      update.turn_started_at = nowIso;
    }
    await admin.from("rooms").update(update).eq("id", room.id);
    // Kick bots so the round continues immediately after resume.
    if ((room as any).match_state) {
      const state = (room as any).match_state as MatchState;
      const eff = await effectiveSeatKinds(room.id, room.seat_kinds as SeatKind[]);
      const intents: BotIntents = (room as any).bot_intents ?? {};
      await advanceBots(room.id, state, eff, intents, nowIso, MAX_BOT_ACTIONS_PER_TICK, nowIso);
    }
    return { ok: true };
  }
  // restart: crear un nou MatchState mantenint configuració
  const initialMano = room.initial_mano as PlayerId;
  const firstDealer = (((initialMano + 3) % 4) as PlayerId);
  const matchState = createMatch({
    targetCama: room.target_cama ?? 12,
    targetCames: room.target_cames,
    firstDealer,
  });
  const initialTurnStartedAt = computeTurnStartedAt(null, matchState, null);
  await admin.from("rooms").update({
    status: "playing",
    match_state: matchState,
    turn_started_at: initialTurnStartedAt,
    paused_at: null,
    bot_intents: {},
    updated_at: nowIso,
  }).eq("id", room.id);
  return { ok: true };
}

function bluffRateFromHonesty(h: string | null | undefined): number {
  if (h === "pillo") return 0.10;
  if (h === "mentider") return 0.20;
  return 0;
}

async function loadHumanTuning(roomId: string): Promise<{ tuning: BotTuning; bluffRate: number }> {
  // Aggregates the tuning of all human players in the room: average their
  // adaptive profile so bots react to the table's collective playstyle, and
  // apply each player's chosen bot difficulty preset before averaging.
  const { data: players } = await admin
    .from("room_players")
    .select("device_id")
    .eq("room_id", roomId);
  const deviceIds = (players ?? []).map((p: any) => p.device_id).filter(Boolean);
  if (deviceIds.length === 0) return { tuning: NEUTRAL_TUNING, bluffRate: 0 };
  const { data: profiles } = await admin
    .from("player_profiles")
    .select("*")
    .in("device_id", deviceIds);
  const list = (profiles ?? []) as (PlayerProfile & { bot_difficulty?: string; bot_honesty?: string })[];
  if (list.length === 0) return { tuning: NEUTRAL_TUNING, bluffRate: 0 };
  const tunings = list.map((p) => {
    const base = tuningFromProfile(p);
    const diff = (p.bot_difficulty as any) ?? "balanced";
    return applyDifficulty(base, diff);
  });
  const avg: BotTuning = {
    callPropensity: tunings.reduce((s, t) => s + t.callPropensity, 0) / tunings.length,
    bluffPropensity: tunings.reduce((s, t) => s + t.bluffPropensity, 0) / tunings.length,
    acceptThresholdDelta: tunings.reduce((s, t) => s + t.acceptThresholdDelta, 0) / tunings.length,
    envitAcceptDelta: tunings.reduce((s, t) => s + t.envitAcceptDelta, 0) / tunings.length,
    consultRate: tunings.reduce((s, t) => s + t.consultRate, 0) / tunings.length,
  };
  const bluffRates = list.map((p) => bluffRateFromHonesty(p.bot_honesty));
  const bluffRate = bluffRates.reduce((s, v) => s + v, 0) / bluffRates.length;
  return { tuning: avg, bluffRate };
}

async function advanceBots(
  roomId: string,
  initial: MatchState,
  seatKinds: SeatKind[],
  intents: BotIntents,
  prevTurnStartedAt: string | null = null,
  maxActions: number = 64,
  expectedUpdatedAt: string | null = null,
) {
  const { tuning, bluffRate } = await loadHumanTuning(roomId);
  let state = initial;
  // Snapshot intents JSON before mutating so the no-op short-circuit at
  // the bottom can detect "nothing actually changed" and avoid bumping
  // `updated_at` on every heartbeat (which would race against legitimate
  // concurrent CAS updates and starve them).
  const initialIntentsSnapshot = JSON.stringify(intents);
  // Buffer planned action inserts until after we win the optimistic CAS write
  // below. Without this, two concurrent advanceBots calls (e.g. from the
  // host's React effect AND a heartbeat firing on another participant) would
  // each insert duplicate `room_actions` rows for the same bot move, which
  // some clients perceive as cards being "replayed" and the match hanging.
  const pendingActions: { seat: PlayerId; action: Action }[] = [];
  let safety = 0;

  // If we enter advanceBots while the previous round has already finished
  // (phase === "round-end"), nobody can act — `legalActions` returns []
  // for every seat, so the loop below would `break` immediately and leave
  // the match permanently stuck in round-end. Detect this case here and
  // start the next round once the visual delay has elapsed; otherwise the
  // match would appear to "repeat" the same finished round forever.
  if (state.round.phase === "round-end") {
    const elapsedSinceTurnStart = prevTurnStartedAt ? Date.now() - new Date(prevTurnStartedAt).getTime() : 0;
    if (elapsedSinceTurnStart < roundEndVisualDelayMs(state)) {
      // Not yet — keep waiting; the next heartbeat / client tick will retry.
      return;
    }
    state = startNextRound(state);
    intents.cardHint = {};
    intents.playStrength = {};
    intents.silentTruc = {};
    intents.foldTruc = {};
    intents.forceTruc = {};
    intents.forceEnvit = {};
    intents.pendingChainedTruc = {};
    intents.chatSignals = {};
    intents.botFlow = null;
    // No deixem que els bots actuen en el mateix tick que iniciem la
    // nova mà: el client necessita reproduir l'animació de repartir
    // les cartes abans que aparegui cap acció. El següent tick
    // (heartbeat o efecte) farà jugar el primer bot quan toqui.
    // Saltem el bucle de bots i anem directament al commit.
    safety = maxActions;
  }

  while (safety++ < maxActions) {
    if (state.round.phase === "game-end") break;
    let actor: PlayerId | null = null;
    for (const p of [0, 1, 2, 3] as PlayerId[]) {
      if (legalActions(state, p).length > 0) {
        const r = state.round;
        if (
          (r.envitState.kind === "pending" && r.envitState.awaitingTeam === (p % 2 === 0 ? "nos" : "ells")) ||
          (r.trucState.kind === "pending" && r.trucState.awaitingTeam === (p % 2 === 0 ? "nos" : "ells")) ||
          r.turn === p
        ) {
          actor = p;
          break;
        }
      }
    }
    const localActor = localBotActorForValidation(state);
    if (actor !== localActor) {
      logBotOrderInconsistency(roomId, "actor-mismatch", state, { onlineActor: actor, localActor, safety });
      actor = localActor;
    }
    if (actor == null) break;
    if (seatKinds[actor] !== "bot") {
      logBotOrderInconsistency(roomId, "actor-is-not-online-bot", state, {
        actor,
        localActor,
        seatKind: seatKinds[actor],
        safety,
      });
      break;
    }

    const decision = await decideOnlineBotAction(roomId, state, actor, seatKinds, intents, tuning, bluffRate);
    if (!decision) break;
    const validBeforeApply = legalActions(state, actor).some((a) => actionsEqual(a, decision));
    if (!validBeforeApply) {
      logBotOrderInconsistency(roomId, "illegal-bot-action", state, { actor, decision, safety });
      break;
    }
    pendingActions.push({ seat: actor, action: decision });
    const prevRound = state.round;
    state = applyAction(state, actor, decision);
    if (decision.type === "shout") {
      intents.pendingChainedTruc ??= {};
      intents.forceTruc ??= {};
      intents.forceEnvit ??= {};
      if (
        (decision.what === "envit" || decision.what === "renvit" || decision.what === "falta-envit") &&
        isFirstOfPair(actor, prevRound.mano)
      ) intents.pendingChainedTruc[actor] = true;
      if (decision.what === "envit" || decision.what === "renvit" || decision.what === "falta-envit") {
        intents.forceEnvit[actor] = false;
      }
      if (decision.what === "truc" || decision.what === "retruc" || decision.what === "quatre" || decision.what === "joc-fora") {
        intents.pendingChainedTruc[actor] = false;
        intents.forceTruc[actor] = false;
      }
    }
    if (intents.cardHint) delete intents.cardHint[actor];
    if (intents.playStrength) delete intents.playStrength[actor];
    if (intents.silentTruc) delete intents.silentTruc[actor];
    if (intents.foldTruc) delete intents.foldTruc[actor];
    if (intents.forceTruc) delete intents.forceTruc[actor];
    if (intents.forceEnvit) delete intents.forceEnvit[actor];
    if (state.round.phase === "round-end") {
      // CRÍTIC: si un bot acaba de jugar la carta que decideix la mà,
      // hem de COMMITAR aquest estat tot sol perquè els clients vegen la
      // carta sobre la taula durant tota la transició visual (1.5s+,
      // animació de qui guanya l'envit, marcadors, 0.5s, recollida,
      // pas de mazo, repartiment). Si continuàrem el bucle i cridàrem
      // `startNextRound` aquí, el client rebria un sol update on
      // l'última carta jugada ja no es veu i les noves cartes ja estan
      // repartides → "salta a repartir sense veure la carta decisiva".
      // El següent tick (heartbeat o efecte de l'host) entrarà al bloc
      // de la línia ~913 i, una vegada haja transcorregut
      // `roundEndVisualDelayMs`, cridarà `startNextRound` en una
      // invocació separada (i sense fer jugar bots en el mateix tick).
      break;
    }
  }
  const newStatus = state.round.phase === "game-end" ? "finished" : "playing";
  // Anchor `turn_started_at` to "now" if the actor changed (or null when no
  // human turn is active). All clients read the same timestamp, so their
  // countdowns stay in sync regardless of network latency. When entering
  // `round-end`, anchor to "now" so the visual-delay gate inside this
  // function can measure elapsed time from this moment on subsequent ticks;
  // otherwise the gate would always see 0ms elapsed and never advance.
  const turnStartedAt = newStatus !== "playing"
    ? null
    : state.round.phase === "round-end"
      ? (initial.round.phase === "round-end" ? prevTurnStartedAt : new Date().toISOString())
      : computeTurnStartedAt(initial, state, prevTurnStartedAt);

  // No-op short-circuit: if nothing actually advanced (no actions taken,
  // state and intents unchanged, turn_started_at unchanged), skip the
  // write entirely. Otherwise repeated heartbeats would constantly bump
  // `updated_at`, racing against legitimate concurrent updates.
  const intentsUnchanged = JSON.stringify(intents) === JSON.stringify(initialIntentsSnapshot);
  if (
    pendingActions.length === 0 &&
    state === initial &&
    intentsUnchanged &&
    turnStartedAt === prevTurnStartedAt &&
    newStatus === "playing"
  ) {
    return;
  }

  // Optimistic concurrency control: only commit if the row hasn't been
  // mutated by anyone else since we started. Postgres serialises the row
  // lock so exactly one concurrent advanceBots wins; the loser silently
  // aborts (no actions inserted, no state overwrite). This eliminates the
  // duplicate `room_actions` inserts that caused the perceived "card replay
  // / hang" issue when host effect + heartbeat fired in parallel.
  const newUpdatedAt = new Date().toISOString();
  let cas = admin
    .from("rooms")
    .update({
      match_state: state,
      status: newStatus,
      bot_intents: intents,
      turn_started_at: turnStartedAt,
      updated_at: newUpdatedAt,
    })
    .eq("id", roomId);
  if (expectedUpdatedAt) cas = cas.eq("updated_at", expectedUpdatedAt);
  const { data: updatedRows, error: casErr } = await cas.select("id");
  if (casErr) throw new Error(casErr.message);
  if (!updatedRows || updatedRows.length === 0) {
    // Another concurrent advanceBots already advanced this room. Drop our
    // buffered actions on the floor — they would be exact duplicates of
    // what the winner inserted (same deterministic decisions).
    return;
  }
  if (pendingActions.length > 0) {
    await admin.from("room_actions").insert(
      pendingActions.map((a) => ({ room_id: roomId, seat: a.seat, action: a.action })),
    );
  }
}

// ──────────────────────────────────────────────────────────────────────
// RPC handlers
// ──────────────────────────────────────────────────────────────────────

const handlers: Record<string, (data: any) => Promise<unknown>> = {
  async createRoom(d) {
    if (d.seatKinds[d.hostSeat] !== "human") throw new Error("El seient de l'amfitrió ha de ser 'human'.");
    // SEMPRE assignem el codi del primer placeholder lliure, recorrent les
    // sales en l'ordre fix (la-falta → truquers → joc-fora → 9-bones) i, dins
    // de cada sala, els 12 slots en ordre. Un placeholder es considera
    // "lliure" si no existeix cap fila a `rooms` amb aquest codi, o si
    // existeix però no té jugadors i no està en estat playing/finished/
    // abandoned (mesa buida reciclable).
    let code = "";
    let existingEmptyRoom: any = null;

    // Helper: check if a candidate code is free (no row, or row exists but
    // empty and not playing/finished/abandoned). Returns { free, existing }.
    const checkCandidate = async (candidate: string): Promise<{ free: boolean; existing: any }> => {
      const { data: existing } = await admin
        .from("rooms")
        .select("*")
        .eq("code", candidate)
        .maybeSingle();
      if (!existing) return { free: true, existing: null };
      // Una mesa "playing" està ocupada: no es pot reciclar.
      if (existing.status === "playing") return { free: false, existing: null };
      // Mesures "abandoned" o "finished" sempre són reciclables: el codi
      // (p.ex. el placeholder congelat) ha de poder reutilitzar-se. Esborrem
      // els jugadors antics i tornem la fila perquè el camí d'UPDATE la
      // reinicialitzi conservant el mateix `code`.
      if (existing.status === "abandoned" || existing.status === "finished") {
        await admin.from("room_players").delete().eq("room_id", existing.id);
        return { free: true, existing };
      }
      // Mesa en estat "lobby": lliure només si no té cap jugador assegut.
      const { data: players } = await admin
        .from("room_players")
        .select("id")
        .eq("room_id", existing.id)
        .limit(1);
      if (!players || players.length === 0) return { free: true, existing };
      return { free: false, existing: null };
    };

    // 1) Si el client ha demanat un codi explícit i correspon a un
    //    placeholder congelat lliure, l'usem tal qual (sense canviar-lo).
    const requested = normalizeCode(d.requestedCode);
    if (requested && frozenSalaForCode(requested)) {
      const { free, existing } = await checkCandidate(requested);
      if (free) {
        code = requested;
        existingEmptyRoom = existing;
      }
    }

    // 2) Si no hi ha codi demanat o no està lliure, recorrem totes les
    //    sales i agafem el primer placeholder lliure.
    if (!code) {
      outer: for (const slug of SALA_SLUGS) {
        const codes = FROZEN_PLACEHOLDER_CODES[slug] ?? [];
        for (const candidate of codes) {
          const { free, existing } = await checkCandidate(candidate);
          if (free) {
            code = candidate;
            existingEmptyRoom = existing;
            break outer;
          }
        }
      }
    }
    if (!code) throw new Error("No hi ha cap mesa lliure ara mateix. Torna-ho a provar més tard.");

    const targetCama = d.targetCama === 9 || d.targetCama === 12 ? d.targetCama : 12;
    const turnTimeoutSec = [15, 30, 45, 60].includes(d.turnTimeoutSec) ? d.turnTimeoutSec : 30;
    const roomWrite = existingEmptyRoom
      ? admin.from("rooms").update({
        status: "lobby",
        target_cames: d.targetCames,
        target_cama: targetCama,
        turn_timeout_sec: turnTimeoutSec,
        initial_mano: d.initialMano,
        seat_kinds: d.seatKinds,
        host_device: d.hostDevice,
        match_state: null,
        bot_intents: {},
        pending_proposal: null,
        paused_at: null,
        turn_started_at: null,
        updated_at: new Date().toISOString(),
      }).eq("id", existingEmptyRoom.id)
      : admin.from("rooms").insert({
        code,
        status: "lobby",
        target_cames: d.targetCames,
        target_cama: targetCama,
        turn_timeout_sec: turnTimeoutSec,
        initial_mano: d.initialMano,
        seat_kinds: d.seatKinds,
        host_device: d.hostDevice,
      });
    const { data: room, error } = await roomWrite.select("*").single();
    if (error || !room) throw new Error(error?.message ?? "Error creant sala");

    const { error: pErr } = await admin.from("room_players").insert({
      room_id: room.id,
      seat: d.hostSeat,
      device_id: d.hostDevice,
      name: d.hostName,
      is_online: true,
    });
    if (pErr) throw new Error(pErr.message);
    return { code: room.code, roomId: room.id };
  },

  async joinRoom(d) {
    const code = String(d.code).toUpperCase();
    const { data: room, error } = await admin.from("rooms").select("*").eq("code", code).maybeSingle();
    if (error) throw new Error(error.message);
    if (!room) throw new Error("Sala no trobada");
    if (room.status === "finished" || room.status === "abandoned") throw new Error("La partida ja ha acabat");

    const { data: existingPlayers } = await admin.from("room_players").select("*").eq("room_id", room.id);
    const players = existingPlayers ?? [];
    const mine = players.find((p: any) => p.device_id === d.deviceId);
    // Si la sala és "sense amfitrió" (creada automàticament pel lobby), el primer humà en seure en serà l'amfitrió.
    const HOSTLESS = "__lobby__";
    if (!mine && room.host_device === HOSTLESS) {
      await admin.from("rooms").update({ host_device: d.deviceId, updated_at: new Date().toISOString() }).eq("id", room.id);
      room.host_device = d.deviceId;
    }
    if (mine) {
      await admin.from("room_players")
        .update({ name: d.name, is_online: true, last_seen: new Date().toISOString() })
        .eq("id", mine.id);
      return { roomId: room.id, code: room.code, seat: mine.seat as PlayerId };
    }
    if (room.status !== "lobby") throw new Error("La partida ja ha començat i no permet noves entrades");

    const seatKinds = room.seat_kinds as SeatKind[];
    const usedSeats = new Set(players.map((p: any) => p.seat));
    let chosenSeat: PlayerId | null = null;
    if (d.preferredSeat != null) {
      if (seatKinds[d.preferredSeat] === "human" && !usedSeats.has(d.preferredSeat)) {
        chosenSeat = d.preferredSeat;
      } else throw new Error("Eixe seient no està disponible");
    } else {
      for (let s = 0; s < 4; s++) {
        if (seatKinds[s] === "human" && !usedSeats.has(s)) { chosenSeat = s as PlayerId; break; }
      }
    }
    if (chosenSeat == null) throw new Error("La sala està plena");

    const { error: insErr } = await admin.from("room_players").insert({
      room_id: room.id, seat: chosenSeat, device_id: d.deviceId, name: d.name, is_online: true,
    });
    if (insErr) throw new Error(insErr.message);
    return { roomId: room.id, code: room.code, seat: chosenSeat };
  },

  async getRoom(d) {
    const code = String(d.code).toUpperCase();
    const { data: room, error } = await admin.from("rooms").select("*").eq("code", code).maybeSingle();
    if (error) throw new Error(error.message);
    if (!room) throw new Error("Sala no trobada");
    const { data: players } = await admin.from("room_players").select("*").eq("room_id", room.id).order("seat");
    // NOTE: presence (is_online / last_seen) is updated only via the
    // `heartbeat` RPC. Updating it here would trigger a Realtime UPDATE on
    // `room_players` for every fetch, which the client listens to and reacts
    // to by calling `getRoom` again — causing an infinite loop that blocks
    // the UI and overwhelms the edge function.
    return buildFullDTO(room as RoomRow, (players ?? []) as PlayerRow[], d.deviceId ?? null);
  },

  async startMatch(d) {
    const { data: room, error } = await admin.from("rooms").select("*").eq("id", d.roomId).maybeSingle();
    if (error || !room) throw new Error("Sala no trobada");
    if (room.host_device !== d.deviceId) throw new Error("Només l'amfitrió pot començar");
    if (room.status !== "lobby") throw new Error("La partida ja ha començat");

    const { data: players } = await admin.from("room_players").select("seat").eq("room_id", room.id);
    const seatKinds = room.seat_kinds as SeatKind[];
    const expectedHumans = seatKinds.filter((k) => k === "human").length;
    if ((players?.length ?? 0) < expectedHumans) {
      throw new Error(`Falten humans per unir-se (${players?.length ?? 0}/${expectedHumans})`);
    }
    const initialMano = room.initial_mano as PlayerId;
    const firstDealer = (((initialMano + 3) % 4) as PlayerId);
    const matchState = createMatch({ targetCama: room.target_cama ?? 12, targetCames: room.target_cames, firstDealer });
    const initialTurnStartedAt = computeTurnStartedAt(null, matchState, null);
    const { error: upErr } = await admin.from("rooms")
      .update({
        status: "playing",
        match_state: matchState,
        turn_started_at: initialTurnStartedAt,
        updated_at: new Date().toISOString(),
      }).eq("id", room.id);
    if (upErr) throw new Error(upErr.message);
    return { ok: true };
  },

  async submitAction(d) {
    const { data: room } = await admin.from("rooms").select("*").eq("id", d.roomId).maybeSingle();
    if (!room) throw new Error("Sala no trobada");
    if (room.status !== "playing") throw new Error("La partida no està en curs");
    if ((room as any).paused_at) throw new Error("La partida està pausada");

    const { data: player } = await admin.from("room_players").select("seat")
      .eq("room_id", room.id).eq("device_id", d.deviceId).maybeSingle();
    if (!player) throw new Error("No estàs en aquesta sala");
    const seat = player.seat as PlayerId;
    const state = room.match_state as MatchState | null;
    if (!state) throw new Error("Estat de partida buit");

    const legal = legalActions(state, seat);
    if (!legal.some((a) => actionsEqual(a, d.action))) {
      // Instead of throwing, return a recoverable signal so the client can
      // refresh its state without showing a scary error toast. This happens
      // frequently due to race conditions with bot advance ticks.
      return { ok: false, stale: true };
    }

    // Submitting an action counts as activity — refresh presence so the seat
    // immediately stops being treated as inactive (bot takeover).
    await admin.from("room_players")
      .update({ is_online: true, last_seen: new Date().toISOString() })
      .eq("room_id", room.id).eq("device_id", d.deviceId);

    // Track human shouts in their adaptive profile (best-effort, non-blocking failures).
    if (d.action.type === "shout") {
      try {
        const what = (d.action as any).what as string;
        const hand = state.round.hands[seat] ?? [];
        const events: any[] = [];
        if (what === "envit" || what === "renvit" || what === "falta-envit") {
          // crude envit estimate by suit-count
          const counts: Record<string, number[]> = {};
          for (const c of hand) (counts[c.suit] ||= []).push(c.rank === 1 ? 1 : c.rank >= 10 ? 0 : c.rank);
          let best = 0;
          for (const arr of Object.values(counts)) {
            const sorted = arr.sort((a, b) => b - a);
            const v = sorted.length >= 2 ? 20 + sorted[0] + sorted[1] : sorted[0] ?? 0;
            if (v > best) best = v;
          }
          events.push({ type: "envit_called", strength: best, bluff: best < 25 });
        } else if (what === "truc" || what === "retruc" || what === "quatre" || what === "joc-fora") {
          let s = 0;
          for (const c of hand) {
            s += c.rank === 1 && (c.suit === "espases" || c.suit === "bastos") ? 0.5
              : c.rank === 7 && (c.suit === "oros" || c.suit === "espases") ? 0.5
              : c.rank === 3 ? 0.3 : 0.05;
          }
          const strength = Math.min(1, s);
          events.push({ type: "truc_called", strength, bluff: strength < 0.25 });
        } else if (what === "vull" || what === "no-vull") {
          const accepted = what === "vull";
          if (state.round.envitState.kind === "pending") events.push({ type: "envit_response", accepted });
          else if (state.round.trucState.kind === "pending") events.push({ type: "truc_response", accepted });
        }
        if (events.length > 0) {
          // Fire-and-forget call to player-profile edge function.
          admin.functions.invoke("player-profile", { body: { fn: "track", data: { deviceId: d.deviceId, events } } }).catch(() => {});
        }
      } catch { /* ignore */ }
    }

    const next = applyAction(state, seat, d.action);
    // NOTE: Don't auto-advance to the next round here. We must broadcast the
    // `round-end` state so all clients can play the end-of-round visual
    // sequence (last trick reveal, scoreboard update). The host's tab
    // schedules an `advanceBots` call after the visual delay (see
    // `OnlinePartida`), which transitions to the next round. Calling
    // `startNextRound` synchronously here would skip that delay entirely
    // and the just-played cards would appear to repeat as the new deal
    // arrives before the played-card animation finishes.
    const newStatus = next.round.phase === "game-end" ? "finished" : "playing";
    const prevTurnStartedAt = (room as any).turn_started_at as string | null | undefined ?? null;
    const expectedUpdatedAt = (room as any).updated_at as string | null | undefined ?? null;
    // When transitioning into round-end, anchor `turn_started_at` to "now" so
    // that the visual-delay gate inside `advanceBots` (which compares against
    // this timestamp) can elapse correctly. Otherwise `computeTurnStartedAt`
    // would return null (no actor in round-end) and the next round would
    // never start because elapsed time would always be 0.
    const nextTurnStartedAt = newStatus !== "playing"
      ? null
      : next.round.phase === "round-end"
        ? new Date().toISOString()
        : computeTurnStartedAt(state, next, prevTurnStartedAt);
    // Optimistic concurrency control. If a concurrent advanceBots already
    // mutated the row between our read and write, abort with a friendly
    // error so the client can refresh and retry against the new state.
    let cas = admin.from("rooms").update({
      match_state: next,
      status: newStatus,
      turn_started_at: nextTurnStartedAt,
      updated_at: new Date().toISOString(),
    }).eq("id", room.id);
    if (expectedUpdatedAt) cas = cas.eq("updated_at", expectedUpdatedAt);
    const { data: updatedRows, error: casErr } = await cas.select("id");
    if (casErr) throw new Error(casErr.message);
    if (!updatedRows || updatedRows.length === 0) {
      return { ok: false, stale: true };
    }
    await admin.from("room_actions").insert({ room_id: room.id, seat, action: d.action });
    return { ok: true };
  },

  async updatePlayerName(d) {
    const { error } = await admin.from("room_players").update({ name: d.name })
      .eq("room_id", d.roomId).eq("device_id", d.deviceId);
    if (error) throw new Error(error.message);
    return { ok: true };
  },

  async heartbeat(d) {
    await admin.from("room_players")
      .update({ is_online: true, last_seen: new Date().toISOString() })
      .eq("room_id", d.roomId).eq("device_id", d.deviceId);
    // En lobby toquem updated_at perquè el lobby sàpiga que l'amfitrió està viu.
    const { data: room } = await admin
      .from("rooms")
      .select("id, host_device, status, match_state, seat_kinds, bot_intents, turn_started_at, updated_at, paused_at")
      .eq("id", d.roomId).maybeSingle();
    if (!room) return { ok: true };
    if ((room as any).host_device === d.deviceId && (room as any).status === "lobby") {
      await admin.from("rooms").update({ updated_at: new Date().toISOString() }).eq("id", d.roomId);
    }
    // While playing, every heartbeat from any participant is a chance to
    // advance the bot replacement for inactive seats. This is what unblocks
    // the match when a human disconnects mid-turn: their teammates' regular
    // heartbeats (every 15s) will trigger the bot to act for them.
    if ((room as any).status === "playing" && (room as any).match_state && !(room as any).paused_at) {
      const state = (room as any).match_state as MatchState;
      const effective = await effectiveSeatKinds(d.roomId, (room as any).seat_kinds as SeatKind[]);
      const intents: BotIntents = (room as any).bot_intents ?? {};
      const prevTurnStartedAt = (room as any).turn_started_at as string | null | undefined ?? null;
      const expectedUpdatedAt = (room as any).updated_at as string | null | undefined ?? null;
      await advanceBots(d.roomId, state, effective, intents, prevTurnStartedAt, MAX_BOT_ACTIONS_PER_TICK, expectedUpdatedAt);
    }
    return { ok: true };
  },

  async advanceBots(d) {
    const { data: room } = await admin
      .from("rooms")
      .select("id, status, match_state, seat_kinds, bot_intents, turn_started_at, paused_at, updated_at")
      .eq("id", d.roomId)
      .maybeSingle();
    if (!room || (room as any).status !== "playing" || !(room as any).match_state || (room as any).paused_at) {
      return { ok: true };
    }
    const { data: player } = await admin
      .from("room_players")
      .select("seat")
      .eq("room_id", d.roomId)
      .eq("device_id", d.deviceId)
      .maybeSingle();
    if (!player) throw new Error("No estàs en aquesta sala");
    const effective = await effectiveSeatKinds(d.roomId, (room as any).seat_kinds as SeatKind[]);
    await advanceBots(
      d.roomId,
      (room as any).match_state as MatchState,
      effective,
      (room as any).bot_intents ?? {},
      (room as any).turn_started_at as string | null | undefined ?? null,
      MAX_BOT_ACTIONS_PER_TICK,
      (room as any).updated_at as string | null | undefined ?? null,
    );
    return { ok: true };
  },

  async setSeatKind(d) {
    const { data: room } = await admin.from("rooms").select("*").eq("id", d.roomId).maybeSingle();
    if (!room) throw new Error("Sala no trobada");
    if (room.host_device !== d.deviceId) throw new Error("Només l'amfitrió pot canviar els seients");
    if (room.status !== "lobby") throw new Error("La partida ja ha començat");
    const seat = d.seat as PlayerId;
    const kind = d.kind as SeatKind;
    if (kind !== "human" && kind !== "bot") throw new Error("Tipus de seient invàlid");
    const seatKinds = [...(room.seat_kinds as SeatKind[])];
    // No permetre canviar un seient ja ocupat per un humà
    const { data: occ } = await admin.from("room_players").select("device_id").eq("room_id", room.id).eq("seat", seat).maybeSingle();
    if (occ) throw new Error("Eixe seient ja està ocupat per un humà");
    seatKinds[seat] = kind;
    const { error } = await admin.from("rooms").update({ seat_kinds: seatKinds, updated_at: new Date().toISOString() }).eq("id", room.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  },

  async leaveRoom(d) {
    const { data: room } = await admin.from("rooms").select("*").eq("id", d.roomId).maybeSingle();
    if (!room) return { ok: true };
    const HOSTLESS = "__lobby__";
    const isHost = room.host_device === d.deviceId;
    // Treure el jugador si estem en lobby
    if (room.status === "lobby") {
      await admin.from("room_players").delete().eq("room_id", room.id).eq("device_id", d.deviceId);
    } else {
      await admin.from("room_players").update({ is_online: false }).eq("room_id", room.id).eq("device_id", d.deviceId);
    }
    // Si en lobby ja no queda cap humà a la sala, abandonem-la perquè quede totalment lliure.
    if (room.status === "lobby") {
      const { data: remainingHumans } = await admin
        .from("room_players")
        .select("device_id")
        .eq("room_id", room.id);
      if (!remainingHumans || remainingHumans.length === 0) {
        await admin
          .from("rooms")
          .update({ status: "abandoned", updated_at: new Date().toISOString() })
          .eq("id", room.id);
        return { ok: true, abandoned: true };
      }
    }
    if (isHost) {
      // Si encara queden altres humans al lobby, reassignem l'amfitrió; si no, la sala queda "sense amfitrió" (hostless) per al lobby automàtic o s'abandona si està jugant.
      if (room.status === "lobby") {
        const { data: remaining } = await admin.from("room_players").select("device_id").eq("room_id", room.id).limit(1);
        const nextHost = (remaining ?? [])[0]?.device_id ?? HOSTLESS;
        await admin.from("rooms").update({ host_device: nextHost, updated_at: new Date().toISOString() }).eq("id", room.id);
        return { ok: true, abandoned: false };
      }
      await admin.from("rooms").update({ status: "abandoned", updated_at: new Date().toISOString() }).eq("id", room.id);
      return { ok: true, abandoned: true };
    }
    // Si la partida està en marxa i ja no queda cap humà online, tanquem la sala
    // perquè quede lliure per a una nova partida.
    if (room.status === "playing") {
      const { data: humansOnline } = await admin
        .from("room_players")
        .select("device_id")
        .eq("room_id", room.id)
        .eq("is_online", true);
      if (!humansOnline || humansOnline.length === 0) {
        await admin
          .from("rooms")
          .update({ status: "abandoned", updated_at: new Date().toISOString() })
          .eq("id", room.id);
        return { ok: true, abandoned: true };
      }
    }
    return { ok: true };
  },

  async setRoomSettings(d) {
    const { data: room } = await admin.from("rooms").select("*").eq("id", d.roomId).maybeSingle();
    if (!room) throw new Error("Sala no trobada");
    if (room.host_device !== d.deviceId) throw new Error("Només l'amfitrió pot canviar la configuració");
    if (room.status !== "lobby") throw new Error("La partida ja ha començat");
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (d.targetCames != null) {
      if (![1, 2, 3].includes(d.targetCames)) throw new Error("Cames a guanyar invàlid");
      update.target_cames = d.targetCames;
    }
    if (d.targetCama != null) {
      if (![9, 12].includes(d.targetCama)) throw new Error("Punts per cama invàlid");
      update.target_cama = d.targetCama;
    }
    if (d.turnTimeoutSec != null) {
      if (![15, 30, 45, 60].includes(d.turnTimeoutSec)) throw new Error("Temps d'espera invàlid");
      update.turn_timeout_sec = d.turnTimeoutSec;
    }
    const { error } = await admin.from("rooms").update(update).eq("id", room.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  },

  async listLobbyRooms(_d) {
    const HOSTLESS = "__lobby__";

    // 1) Neteja de taules penjades: només si l'amfitrió real (no hostless) ha desaparegut >3min,
    //    o si porta >3min "playing" amb marcador 0-0.
    const stale = new Date(Date.now() - 180_000).toISOString();
    const { data: staleRooms } = await admin
      .from("rooms")
      .select("id, host_device, status, updated_at, match_state")
      .in("status", ["lobby", "playing"])
      .lt("updated_at", stale);
    for (const r of (staleRooms ?? []) as { id: string; host_device: string; status: "lobby" | "playing"; updated_at: string; match_state: MatchState | null }[]) {
      if (r.host_device === HOSTLESS) continue; // Les taules automàtiques del lobby no caduquen.
      const { data: host } = await admin.from("room_players")
        .select("last_seen, is_online")
        .eq("room_id", r.id).eq("device_id", r.host_device).maybeSingle();
      const lastSeen = host?.last_seen ? new Date(host.last_seen).getTime() : 0;
      const hostMissing = !host || !host.is_online || Date.now() - lastSeen > 180_000;
      const state = r.match_state as MatchState | null;
      const stillZeroZero = !!state
        && state.cames === 0
        && state.scores.nos.males === 0
        && state.scores.nos.bones === 0
        && state.scores.nos.males === 0
        && state.scores.ells.males === 0
        && state.scores.ells.bones === 0;
      if (hostMissing || (r.status === "playing" && stillZeroZero)) {
        await admin.from("rooms").update({ status: "abandoned", updated_at: new Date().toISOString() }).eq("id", r.id);
      }
    }

    // 1.b) Tancar partides "playing" sense cap humà online (tots han abandonat o
    //      han perdut la connexió). Així la mesa queda lliure per a una nova partida.
    const { data: playingRooms } = await admin
      .from("rooms")
      .select("id")
      .eq("status", "playing");
    for (const pr of (playingRooms ?? []) as { id: string }[]) {
      const { data: humansOnline } = await admin
        .from("room_players")
        .select("device_id")
        .eq("room_id", pr.id)
        .eq("is_online", true);
      if (!humansOnline || humansOnline.length === 0) {
        await admin
          .from("rooms")
          .update({ status: "abandoned", updated_at: new Date().toISOString() })
          .eq("id", pr.id);
      }
    }

    const { data: rooms, error } = await admin
      .from("rooms")
      .select("id, code, status, target_cames, target_cama, turn_timeout_sec, seat_kinds, host_device, created_at")
      .in("status", ["lobby", "playing"])
      .order("created_at", { ascending: true })
      .limit(20);
    if (error) throw new Error(error.message);
    const list = rooms ?? [];
    if (list.length === 0) return { rooms: [] };
    const ids = list.map((r: any) => r.id);
    const { data: players } = await admin
      .from("room_players")
      .select("room_id, seat, name, is_online")
      .in("room_id", ids);
    const byRoom = new Map<string, any[]>();
    for (const p of (players ?? [])) {
      const arr = byRoom.get(p.room_id) ?? [];
      arr.push(p);
      byRoom.set(p.room_id, arr);
    }
    const visibleList = list.filter((r: any) => !(r.host_device === HOSTLESS && (byRoom.get(r.id) ?? []).length === 0));
    return {
      rooms: visibleList.map((r: any) => ({
        id: r.id,
        code: r.code,
        status: r.status,
        targetCames: r.target_cames,
        targetCama: r.target_cama ?? 12,
        turnTimeoutSec: r.turn_timeout_sec ?? 30,
        seatKinds: r.seat_kinds,
        hostDevice: r.host_device,
        players: (byRoom.get(r.id) ?? []).map((p) => ({
          seat: p.seat as PlayerId,
          name: p.name,
          isOnline: p.is_online,
        })),
      })),
    };
  },

  async sendChatPhrase(d) {
    const { data: room } = await admin.from("rooms").select("*").eq("id", d.roomId).maybeSingle();
    if (!room) throw new Error("Sala no trobada");
    const { data: player } = await admin.from("room_players").select("seat")
      .eq("room_id", room.id).eq("device_id", d.deviceId).maybeSingle();
    if (!player) throw new Error("No estàs en aquesta sala");
    const seat = player.seat as PlayerId;

    await admin.from("room_chat").insert({ room_id: room.id, seat, phrase_id: d.phraseId });
    if (room.status !== "playing") return { ok: true };
    if ((room as any).paused_at) return { ok: true };

    const seatKinds = room.seat_kinds as SeatKind[];
    let state = room.match_state as MatchState | null;
    if (!state) return { ok: true };
    const intents: BotIntents = (room as any).bot_intents ?? {};
    intents.cardHint ??= {};
    intents.playStrength ??= {};
    intents.silentTruc ??= {};
    intents.foldTruc ??= {};
    intents.forceTruc ??= {};
    intents.forceEnvit ??= {};
    intents.chatSignals ??= {};
    intents.chatSignals[seat] ??= [];
    intents.chatSignals[seat].push(d.phraseId as ChatPhraseId);

    const partner = partnerOf(seat);
    const partnerIsBot = seatKinds[partner] === "bot";

    const legal = legalActions(state, seat);
    const tryDispatch = async (what: string) => {
      const a = legal.find((x: any) => x.type === "shout" && x.what === what);
      if (!a) return false;
      // Same reasoning as in `submitAction`: don't auto-advance the round
      // here. The host's `advanceBots` scheduler will transition out of
      // `round-end` after the visual delay, so the just-played cards have
      // time to animate before the new deal arrives.
      const next = applyAction(state!, seat, a);
      await admin.from("room_actions").insert({ room_id: room.id, seat, action: a });
      state = next;
      return true;
    };

    let stateChanged = false;
    if (d.phraseId === "envida") {
      // L'humà demana al company que envide. Marquem la intenció perquè
      // el bot company canti envit en el seu pròxim torn legal.
      if (partnerIsBot) intents.forceEnvit[partner] = true;
    } else if (d.phraseId === "tira-falta") {
      stateChanged = (await tryDispatch("falta-envit")) || stateChanged;
    } else if (d.phraseId === "vamonos") {
      const r = state.round;
      const canFold = r.trucState.kind === "pending" &&
        r.trucState.awaitingTeam === teamOf(seat) &&
        legal.some((a: any) => a.type === "shout" && a.what === "no-vull");
      if (canFold) stateChanged = (await tryDispatch("no-vull")) || stateChanged;
      if (partnerIsBot) intents.foldTruc[partner] = true;
    } else if (d.phraseId === "pon-fort" && partnerIsBot) {
      intents.cardHint[partner] = "fort";
    } else if (d.phraseId === "pon-molesto" && partnerIsBot) {
      intents.cardHint[partner] = "molesto";
    } else if (d.phraseId === "vine-al-teu-tres" && partnerIsBot) {
      intents.cardHint[partner] = "tres";
    } else if (d.phraseId === "juega-callado" && partnerIsBot) {
      intents.silentTruc[partner] = true;
    } else if (d.phraseId === "truca" && partnerIsBot) {
      intents.forceTruc[partner] = true;
    } else if (
      (d.phraseId === "vine-a-mi" ||
        d.phraseId === "vine-al-meu-tres" ||
        d.phraseId === "vine-a-vore") &&
      partnerIsBot
    ) {
      intents.playStrength[partner] = "low";
    } else if ((d.phraseId === "tinc-bona" || d.phraseId === "tinc-un-tres") && partnerIsBot) {
      intents.playStrength[partner] = "free";
    } else if ((d.phraseId === "a-tu" || d.phraseId === "no-tinc-res") && partnerIsBot) {
      intents.playStrength[partner] = "high";
    }
    const botFlow = intents.botFlow;
    if (botFlow?.payload?.awaitingHuman && seat === Number(botFlow.payload.partner)) {
      if (botFlow.kind === "consult-decide" && botInfoPhrases().includes(d.phraseId as ChatPhraseId)) {
        intents.botFlow = {
          ...botFlow,
          dueAt: dueIso(CONSULT_DECIDE_DELAY_MS),
          payload: {
            ...botFlow.payload,
            awaitingHuman: false,
            advice: adviceFromAnswer(d.phraseId as ChatPhraseId, botFlow.payload.question as ChatPhraseId | undefined),
          },
        };
      } else if (botFlow.kind === "second-wait" && envitInstructionPhrases().includes(d.phraseId as ChatPhraseId)) {
        intents.botFlow = {
          ...botFlow,
          dueAt: dueIso(CONSULT_DECIDE_DELAY_MS),
          payload: {
            ...botFlow.payload,
            awaitingHuman: false,
            stage: "finalize",
            instruction: d.phraseId as ChatPhraseId,
          },
        };
      }
    }

    const botAnswer = partnerIsBot
      ? botReplyToHumanQuestion(state, partner, d.phraseId as ChatPhraseId, intents, 0)
      : null;
    if (botAnswer) {
      await waitMs(CONSULT_ANSWER_DELAY_MS);
      await insertBotChat(room.id, partner, botAnswer);
      recordBotChat(intents, partner, botAnswer);
    }
    // Compromís personal: el qui ha emés la frase ha declarat tindre
    // 7 d'oros o un 3 ("vine-a-vore"), o un 3 amb context favorable
    // ("vine-al-meu-tres"), o un 3 sense top cards ("tinc-un-tres").
    // Si és un seient controlat per bot (bot remot), apliquem el
    // playStrength específic al propi speaker perquè la lògica del bot
    // honre el compromís quan li toque jugar.
    if (
      (d.phraseId === "vine-a-vore" ||
        d.phraseId === "vine-al-meu-tres" ||
        d.phraseId === "tinc-un-tres") &&
      seatKinds[seat] === "bot"
    ) {
      intents.playStrength[seat] = d.phraseId;
    }

    const prevTurnStartedAt = (room as any).turn_started_at as string | null | undefined ?? null;
    if (stateChanged) {
      const newStatus = state.round.phase === "game-end" ? "finished" : "playing";
      const initialState = room.match_state as MatchState;
      const nextTurnStartedAt = newStatus !== "playing"
        ? null
        : state.round.phase === "round-end"
          ? (initialState.round.phase === "round-end" ? prevTurnStartedAt : new Date().toISOString())
          : computeTurnStartedAt(initialState, state, prevTurnStartedAt);
      await admin.from("rooms")
        .update({
          match_state: state,
          status: newStatus,
          bot_intents: intents,
          turn_started_at: nextTurnStartedAt,
        }).eq("id", room.id);
    } else {
      await admin.from("rooms").update({ bot_intents: intents }).eq("id", room.id);
    }
    return { ok: true };
  },

  async listMyActiveRooms(d) {
    if (!d?.deviceId || typeof d.deviceId !== "string") {
      return { rooms: [] };
    }
    // Reentry source-of-truth.
    //
    // INVARIANT: una mesa només es retorna si TOTES les condicions són certes:
    //   (a) hi ha una fila a `room_players` amb aquest device_id i `seat`
    //       no nul (defensa contra files orfes / corruptes),
    //   (b) la mesa existeix i està actualment en `status = 'playing'`
    //       (mai 'lobby', 'finished' o 'abandoned'),
    //   (c) el `seat` indicat existeix dins del rang de `seat_kinds` de la
    //       mesa (defensa final contra desincronitzacions d'esquema).
    //
    // Si una mesa té múltiples files per al mateix device (mai hauria de
    // passar, però defensem-nos), ens quedem amb la més recent (`joined_at`).
    const { data: mySeats } = await admin
      .from("room_players")
      .select("room_id, seat, joined_at")
      .eq("device_id", d.deviceId)
      .order("joined_at", { ascending: false });

    // Dedup per room_id, conservant la fila més recent.
    const seatByRoom = new Map<string, number>();
    for (const r of (mySeats ?? []) as Array<{ room_id: string; seat: number | null }>) {
      if (r.seat == null) continue;
      if (!seatByRoom.has(r.room_id)) seatByRoom.set(r.room_id, r.seat);
    }
    const roomIds = Array.from(seatByRoom.keys());
    if (roomIds.length === 0) return { rooms: [] };

    const { data: rooms } = await admin
      .from("rooms")
      .select("id, code, status, target_cames, seat_kinds, updated_at")
      .in("id", roomIds)
      .eq("status", "playing")
      .order("updated_at", { ascending: false });

    return {
      rooms: (rooms ?? [])
        .map((r: any) => {
          const seat = seatByRoom.get(r.id);
          if (seat == null) return null;
          // Validació de rang: el seat ha de ser un índex vàlid del seat_kinds.
          const seatKinds = Array.isArray(r.seat_kinds) ? r.seat_kinds : [];
          if (seat < 0 || seat >= seatKinds.length) return null;
          return {
            id: r.id,
            code: r.code,
            status: r.status,
            targetCames: r.target_cames,
            updatedAt: r.updated_at,
            mySeat: seat,
          };
        })
        .filter((r: any) => r !== null),
    };
  },

  async sendTextMessage(d) {
    const text = typeof d?.text === "string" ? d.text.trim() : "";
    if (!text) throw new Error("Missatge buit");
    if (text.length > 200) throw new Error("Missatge massa llarg (màx 200)");
    if (typeof d?.roomId !== "string" || !d.roomId) throw new Error("roomId requerit");
    if (typeof d?.deviceId !== "string" || !d.deviceId) throw new Error("deviceId requerit");

    const { data: player } = await admin
      .from("room_players")
      .select("seat")
      .eq("room_id", d.roomId)
      .eq("device_id", d.deviceId)
      .maybeSingle();
    if (!player) throw new Error("No estàs en aquesta sala");

    // Check if this device is currently flagged (silenciat) in this room.
    // Dismissed flags don't mute (the moderator overruled them).
    const nowIso = new Date().toISOString();
    const { data: activeFlag } = await admin
      .from("room_chat_flags")
      .select("expires_at")
      .eq("room_id", d.roomId)
      .eq("target_device_id", d.deviceId)
      .neq("status", "dismissed")
      .gt("expires_at", nowIso)
      .order("expires_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (activeFlag) {
      const remainingMs = Math.max(0, new Date(activeFlag.expires_at).getTime() - Date.now());
      const remainingSec = Math.ceil(remainingMs / 1000);
      throw new Error(`Estàs silenciat al xat (${remainingSec}s restants)`);
    }

    const { error } = await admin.from("room_text_chat").insert({
      room_id: d.roomId,
      seat: player.seat,
      device_id: d.deviceId,
      text,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  },

  async flagPlayerInChat(d) {
    if (typeof d?.roomId !== "string" || !d.roomId) throw new Error("roomId requerit");
    if (typeof d?.deviceId !== "string" || !d.deviceId) throw new Error("deviceId requerit");
    if (typeof d?.targetSeat !== "number") throw new Error("targetSeat requerit");
    const reason = typeof d?.reason === "string" ? d.reason.slice(0, 200) : null;
    const messageId = typeof d?.messageId === "number" ? d.messageId : null;
    const messageText = typeof d?.messageText === "string" ? d.messageText.slice(0, 500) : null;

    // Reporter must be a player in this room.
    const { data: reporter } = await admin
      .from("room_players")
      .select("seat")
      .eq("room_id", d.roomId)
      .eq("device_id", d.deviceId)
      .maybeSingle();
    if (!reporter) throw new Error("No estàs en aquesta sala");
    if (reporter.seat === d.targetSeat) throw new Error("No pots reportar-te a tu mateix");

    // Find the target's most recent device_id at that seat.
    const { data: target } = await admin
      .from("room_players")
      .select("device_id")
      .eq("room_id", d.roomId)
      .eq("seat", d.targetSeat)
      .order("joined_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!target) throw new Error("Jugador reportat no trobat");
    if (target.device_id === d.deviceId) throw new Error("No pots reportar-te a tu mateix");

    // Count distinct active, non-dismissed reporters against this target.
    const nowIso = new Date().toISOString();
    const { data: existing } = await admin
      .from("room_chat_flags")
      .select("reporter_device_id, status")
      .eq("room_id", d.roomId)
      .eq("target_device_id", target.device_id)
      .neq("status", "dismissed")
      .gt("expires_at", nowIso);

    const reporters = new Set<string>((existing ?? []).map((r) => r.reporter_device_id));
    reporters.add(d.deviceId);
    // Escalation: 5 min for 1 reporter, 15 min for 2, 60 min for 3+.
    const reporterCount = reporters.size;
    const muteMinutes = reporterCount >= 3 ? 60 : reporterCount === 2 ? 15 : 5;
    const expiresAt = new Date(Date.now() + muteMinutes * 60 * 1000).toISOString();

    // Upsert this reporter's flag (extends/replaces their previous one).
    // Always reset to 'pending' so a re-flag re-opens moderator review.
    const { error } = await admin
      .from("room_chat_flags")
      .upsert(
        {
          room_id: d.roomId,
          target_seat: d.targetSeat,
          target_device_id: target.device_id,
          reporter_device_id: d.deviceId,
          reason,
          expires_at: expiresAt,
          message_id: messageId,
          message_text: messageText,
          status: "pending",
          decided_at: null,
          decided_by: null,
        },
        { onConflict: "room_id,target_device_id,reporter_device_id" },
      );
    if (error) throw new Error(error.message);

    return { ok: true, expiresAt, muteMinutes, reporterCount };
  },

  async adminListChatFlags(d) {
    const expected = Deno.env.get("ADMIN_PASSWORD") ?? "";
    if (!expected) throw new Error("Admin no configurat al servidor");
    if (typeof d?.password !== "string" || d.password !== expected) {
      throw new Error("Contrasenya d'administrador incorrecta");
    }
    const status = typeof d?.status === "string" ? d.status : "all";
    let q = admin
      .from("room_chat_flags")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200);
    if (status === "pending" || status === "approved" || status === "dismissed") {
      q = q.eq("status", status);
    }
    const { data: flags, error } = await q;
    if (error) throw new Error(error.message);
    if (!flags || flags.length === 0) return { ok: true, flags: [] };

    // Hydrate room codes and player names for the UI.
    const roomIds = Array.from(new Set(flags.map((f: any) => f.room_id)));
    const { data: rooms } = await admin.from("rooms").select("id, code").in("id", roomIds);
    const roomCodeById = new Map<string, string>(
      (rooms ?? []).map((r: any) => [r.id as string, r.code as string]),
    );
    const { data: rps } = await admin
      .from("room_players")
      .select("room_id, seat, name, device_id")
      .in("room_id", roomIds);
    const nameByRoomSeat = new Map<string, string>();
    const nameByDevice = new Map<string, string>();
    for (const p of rps ?? []) {
      nameByRoomSeat.set(`${(p as any).room_id}:${(p as any).seat}`, (p as any).name);
      nameByDevice.set((p as any).device_id, (p as any).name);
    }

    return {
      ok: true,
      flags: flags.map((f: any) => ({
        id: f.id,
        roomId: f.room_id,
        roomCode: roomCodeById.get(f.room_id) ?? "?",
        targetSeat: f.target_seat,
        targetName: nameByRoomSeat.get(`${f.room_id}:${f.target_seat}`) ?? `Seient ${f.target_seat + 1}`,
        targetDeviceId: f.target_device_id,
        reporterDeviceId: f.reporter_device_id,
        reporterName: nameByDevice.get(f.reporter_device_id) ?? "(desconegut)",
        reason: f.reason,
        messageId: f.message_id,
        messageText: f.message_text,
        status: f.status,
        createdAt: f.created_at,
        expiresAt: f.expires_at,
        decidedAt: f.decided_at,
        decidedBy: f.decided_by,
      })),
    };
  },

  async adminDecideChatFlag(d) {
    const expected = Deno.env.get("ADMIN_PASSWORD") ?? "";
    if (!expected) throw new Error("Admin no configurat al servidor");
    if (typeof d?.password !== "string" || d.password !== expected) {
      throw new Error("Contrasenya d'administrador incorrecta");
    }
    if (typeof d?.flagId !== "number") throw new Error("flagId requerit");
    const decision = d?.decision;
    if (decision !== "approved" && decision !== "dismissed" && decision !== "pending") {
      throw new Error("Decision invàlida");
    }
    const moderatorTag = typeof d?.moderatorTag === "string" ? d.moderatorTag.slice(0, 60) : "admin";

    const { data: updated, error } = await admin
      .from("room_chat_flags")
      .update({
        status: decision,
        decided_at: decision === "pending" ? null : new Date().toISOString(),
        decided_by: decision === "pending" ? null : moderatorTag,
      })
      .eq("id", d.flagId)
      .select("*")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!updated) throw new Error("Flag no trobat");

    // Append an audit entry. We never throw on audit failures (moderation must
    // not be blocked by audit), but we surface the error in the response so it
    // can be inspected from the admin UI.
    let auditError: string | null = null;
    const note = typeof d?.note === "string" ? d.note.slice(0, 500) : null;
    try {
      const { error: auditErr } = await admin.from("chat_flag_audit").insert({
        flag_id: (updated as any).id,
        room_id: (updated as any).room_id,
        target_seat: (updated as any).target_seat,
        target_device_id: (updated as any).target_device_id,
        reporter_device_id: (updated as any).reporter_device_id,
        message_id: (updated as any).message_id,
        message_text: (updated as any).message_text,
        reason: note ?? (updated as any).reason,
        decision,
        moderator_tag: moderatorTag,
        flag_created_at: (updated as any).created_at,
        flag_expires_at: (updated as any).expires_at,
      });
      if (auditErr) auditError = auditErr.message;
    } catch (e) {
      auditError = e instanceof Error ? e.message : String(e);
    }
    return { ok: true, flag: updated, auditError };
  },

  async adminListChatFlagAudit(d) {
    const expected = Deno.env.get("ADMIN_PASSWORD") ?? "";
    if (!expected) throw new Error("Admin no configurat al servidor");
    if (typeof d?.password !== "string" || d.password !== expected) {
      throw new Error("Contrasenya d'administrador incorrecta");
    }
    const limit = typeof d?.limit === "number" && d.limit > 0 && d.limit <= 500 ? d.limit : 100;
    let q = admin
      .from("chat_flag_audit")
      .select("*")
      .order("decided_at", { ascending: false })
      .limit(limit);
    if (typeof d?.flagId === "number") q = q.eq("flag_id", d.flagId);
    if (typeof d?.roomId === "string" && d.roomId) q = q.eq("room_id", d.roomId);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return {
      ok: true,
      entries: (data ?? []).map((r: any) => ({
        id: r.id,
        flagId: r.flag_id,
        roomId: r.room_id,
        targetSeat: r.target_seat,
        targetDeviceId: r.target_device_id,
        reporterDeviceId: r.reporter_device_id,
        messageId: r.message_id,
        messageText: r.message_text,
        reason: r.reason,
        decision: r.decision,
        moderatorTag: r.moderator_tag,
        flagCreatedAt: r.flag_created_at,
        flagExpiresAt: r.flag_expires_at,
        decidedAt: r.decided_at,
      })),
    };
  },

  async ping(_d) {
    return { ok: true, t: Date.now() };
  },

  async setPaused(d) {
    if (typeof d?.roomId !== "string" || !d.roomId) throw new Error("roomId requerit");
    if (typeof d?.deviceId !== "string" || !d.deviceId) throw new Error("deviceId requerit");
    const paused = !!d?.paused;
    const { data: room } = await admin.from("rooms").select("*").eq("id", d.roomId).maybeSingle();
    if (!room) throw new Error("Sala no trobada");
    if (room.status !== "playing") throw new Error("La partida no està en curs");
    const { data: player } = await admin.from("room_players").select("seat")
      .eq("room_id", room.id).eq("device_id", d.deviceId).maybeSingle();
    if (!player) throw new Error("No estàs en aquesta sala");

    const wasPaused = !!(room as any).paused_at;
    const nowIso = new Date().toISOString();
    // When resuming, also reset `turn_started_at` to "now" so that human
    // turn timers don't immediately fire because the deadline lapsed
    // during the pause. When pausing, freeze the timer by clearing
    // `turn_started_at` (clients gate the countdown on `paused_at`).
    const update: Record<string, unknown> = {
      paused_at: paused ? nowIso : null,
      updated_at: nowIso,
    };
    if (wasPaused && !paused && (room as any).match_state) {
      update.turn_started_at = nowIso;
    }
    await admin.from("rooms").update(update).eq("id", room.id);

    // When resuming, kick bots so the round can continue immediately.
    if (wasPaused && !paused && (room as any).match_state) {
      const state = (room as any).match_state as MatchState;
      const eff = await effectiveSeatKinds(room.id, room.seat_kinds as SeatKind[]);
      const intents: BotIntents = (room as any).bot_intents ?? {};
      await advanceBots(room.id, state, eff, intents, nowIso, MAX_BOT_ACTIONS_PER_TICK, nowIso);
    }
    return { ok: true, paused };
  },

  // ────────────────────────────────────────────────────────────
  // Propostes col·lectives (pausa / reiniciar partida)
  // Una proposta requereix l'acceptació de TOTS els humans
  // diferents al proposant. Si algun humà la rebutja o expira,
  // es cancel·la. Quan tots accepten, s'executa l'acció.
  // ────────────────────────────────────────────────────────────
  async proposeAction(d) {
    if (typeof d?.roomId !== "string" || !d.roomId) throw new Error("roomId requerit");
    if (typeof d?.deviceId !== "string" || !d.deviceId) throw new Error("deviceId requerit");
    const kind = d?.kind;
    if (kind !== "pause" && kind !== "restart" && kind !== "resume") throw new Error("Tipus de proposta no vàlid");

    const { data: room } = await admin.from("rooms").select("*").eq("id", d.roomId).maybeSingle();
    if (!room) throw new Error("Sala no trobada");
    if (room.status !== "playing") throw new Error("La partida no està en curs");

    const seatKinds = room.seat_kinds as SeatKind[];
    const { data: players } = await admin.from("room_players").select("seat,name,device_id")
      .eq("room_id", room.id);
    const proposer = players?.find((p: any) => p.device_id === d.deviceId);
    if (!proposer) throw new Error("No estàs en aquesta sala");

    // Seients humans REALMENT ocupats (un humà sense connectar no compta).
    const humanSeats = (players ?? [])
      .filter((p: any) => seatKinds[p.seat as number] === "human")
      .map((p: any) => p.seat as PlayerId);

    // Si nomes hi ha un humà (la resta bots), no cal votació: executem directament.
    if (humanSeats.length <= 1) {
      return await executeProposal(room, kind);
    }

    // Si ja hi ha una proposta vigent, no acceptem una de nova.
    const existing = (room as any).pending_proposal as any;
    if (existing && new Date(existing.expiresAt).getTime() > Date.now()) {
      throw new Error("Ja hi ha una proposta en curs");
    }

    const nowIso = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 15_000).toISOString();
    const votes: Record<string, "accepted" | "rejected" | "pending"> = {};
    for (const s of humanSeats) {
      votes[String(s)] = s === proposer.seat ? "accepted" : "pending";
    }
    const proposal = {
      kind,
      proposerSeat: proposer.seat,
      proposerName: proposer.name,
      createdAt: nowIso,
      expiresAt,
      votes,
    };
    const { error: upErr } = await admin.from("rooms")
      .update({ pending_proposal: proposal, updated_at: nowIso })
      .eq("id", room.id);
    if (upErr) throw new Error(upErr.message);
    return { ok: true, proposal };
  },

  async respondProposal(d) {
    if (typeof d?.roomId !== "string" || !d.roomId) throw new Error("roomId requerit");
    if (typeof d?.deviceId !== "string" || !d.deviceId) throw new Error("deviceId requerit");
    const accept = !!d?.accept;

    const { data: room } = await admin.from("rooms").select("*").eq("id", d.roomId).maybeSingle();
    if (!room) throw new Error("Sala no trobada");
    const proposal = (room as any).pending_proposal as any;
    if (!proposal) throw new Error("No hi ha cap proposta en curs");
    if (new Date(proposal.expiresAt).getTime() < Date.now()) {
      await admin.from("rooms").update({ pending_proposal: null, updated_at: new Date().toISOString() })
        .eq("id", room.id);
      throw new Error("La proposta ha expirat");
    }

    const { data: player } = await admin.from("room_players").select("seat")
      .eq("room_id", room.id).eq("device_id", d.deviceId).maybeSingle();
    if (!player) throw new Error("No estàs en aquesta sala");
    const seatKey = String(player.seat);
    if (!(seatKey in proposal.votes)) throw new Error("No has de votar aquesta proposta");

    proposal.votes[seatKey] = accept ? "accepted" : "rejected";
    const nowIso = new Date().toISOString();

    // Si algú rebutja → cancel·lar
    if (!accept) {
      await admin.from("rooms").update({ pending_proposal: null, updated_at: nowIso })
        .eq("id", room.id);
      // Guardem el motiu en bot_intents temporal? No, simplement retornem perquè el client mostre un toast
      return { ok: true, status: "rejected", proposal: { ...proposal, status: "rejected" } };
    }

    // Si tots han acceptat → executar
    const allAccepted = Object.values(proposal.votes).every((v) => v === "accepted");
    if (allAccepted) {
      await admin.from("rooms").update({ pending_proposal: null, updated_at: nowIso })
        .eq("id", room.id);
      await executeProposal(room, proposal.kind);
      return { ok: true, status: "executed" };
    }

    // En cas contrari, actualitzem els vots
    await admin.from("rooms").update({ pending_proposal: proposal, updated_at: nowIso })
      .eq("id", room.id);
    return { ok: true, status: "pending", proposal };
  },

  async cancelProposal(d) {
    if (typeof d?.roomId !== "string" || !d.roomId) throw new Error("roomId requerit");
    const { data: room } = await admin.from("rooms").select("pending_proposal").eq("id", d.roomId).maybeSingle();
    if (!room) throw new Error("Sala no trobada");
    if (!(room as any).pending_proposal) return { ok: true };
    await admin.from("rooms").update({ pending_proposal: null, updated_at: new Date().toISOString() })
      .eq("id", d.roomId);
    return { ok: true };
  },

  async adminCloseRoom(d) {
    const expected = Deno.env.get("ADMIN_PASSWORD") ?? "";
    if (!expected) throw new Error("Admin no configurat al servidor");
    if (typeof d?.password !== "string" || d.password !== expected) {
      throw new Error("Contrasenya d'administrador incorrecta");
    }
    if (typeof d?.roomId !== "string" || !d.roomId) throw new Error("roomId requerit");
    const { error } = await admin
      .from("rooms")
      .update({ status: "abandoned", updated_at: new Date().toISOString() })
      .eq("id", d.roomId);
    if (error) throw new Error(error.message);
    return { ok: true };
  },
};

// ──────────────────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse(405, { error: "Method not allowed" });

  try {
    const body = await req.json();
    const { fn, data } = body;
    const handler = handlers[fn];
    if (!handler) return jsonResponse(400, { error: `Unknown fn: ${fn}` });
    const result = await handler(data ?? {});
    return jsonResponse(200, result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error ? e.stack : undefined;
    console.error("[rooms-rpc] ERROR:", msg, "\nSTACK:", stack);
    return jsonResponse(400, { error: msg, stack });
  }
});
