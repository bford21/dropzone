import { defineGame } from "@flayerlabs/gamemode-spec";
import type { RoundWindow } from "@flayerlabs/gamemode-spec";
import type { SignedAwardClaim } from "../../shared/src/protocol";
import { verifyAwardClaim } from "./claims";

export interface DropzoneGameConfig { serverPublicKey: string; maxPointsPerPlayer: number }
interface DropzoneState { window: RoundWindow; config: DropzoneGameConfig; closed: boolean; points: Record<string, number>; claimedMatches: Record<string, string[]> }
export interface ClaimAction { type: "claim"; award: SignedAwardClaim }
type DropzoneEvent = { type: "award-accepted"; player: string; matchId: string; points: number } | { type: "round-closed" };
export interface DropzonePublicView { phase: "open" | "closed"; totalClaims: number }
export interface DropzonePlayerView { points: number; claimedMatches: string[] }

const encoder = new TextEncoder();
const exactKeys = (value: Record<string, unknown>, keys: string[]) => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};
const canonicalPlayer = (player: string) => player.toLowerCase();

function parseAward(value: unknown): SignedAwardClaim | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  const claim = data.claim as Record<string, unknown> | undefined;
  if (!exactKeys(data, ["claim", "signature"])) return null;
  if (!claim || typeof data.signature !== "string" || data.signature.length > 132) return null;
  if (!exactKeys(claim, ["matchId", "playerId", "points", "kills", "headshots", "issuedAt", "nonce", "eventHash"])) return null;
  if (typeof claim.matchId !== "string" || claim.matchId.length > 80 || typeof claim.playerId !== "string" || claim.playerId.length > 80) return null;
  if (!Number.isSafeInteger(claim.points) || !Number.isSafeInteger(claim.kills) || !Number.isSafeInteger(claim.headshots) || !Number.isSafeInteger(claim.issuedAt)) return null;
  if (typeof claim.nonce !== "string" || claim.nonce.length > 80) return null;
  if (typeof claim.eventHash !== "string" || !/^[0-9a-f]{64}$/i.test(claim.eventHash)) return null;
  return { claim: { matchId: claim.matchId, playerId: canonicalPlayer(claim.playerId), points: claim.points as number, kills: claim.kills as number, headshots: claim.headshots as number, issuedAt: claim.issuedAt as number, nonce: claim.nonce, eventHash: claim.eventHash }, signature: data.signature };
}

export const dropzoneRules = defineGame<DropzoneGameConfig, DropzoneState, DropzoneEvent, ClaimAction, DropzonePublicView, DropzonePlayerView>({
  id: "dropzone-fps-v2",
  parseAction(input) {
    if (!input || typeof input !== "object") return null;
    let serialized: string;
    try { serialized = JSON.stringify(input); } catch { return null; }
    if (encoder.encode(serialized).length > 2_048) return null;
    const action = input as Record<string, unknown>;
    if (!exactKeys(action, ["type", "award"]) || action.type !== "claim") return null;
    const award = parseAward(action.award);
    return award ? { type: "claim", award } : null;
  },
  initRound(config, _seed, window) { return { window, config: Object.freeze({ ...config }), closed: false, points: {}, claimedMatches: {} }; },
  decide(state, command) {
    if (command.kind === "wake") return command.at >= state.window.closesAt ? { events: [{ type: "round-closed" }] } : { events: [] };
    if (command.kind !== "action") return { events: [] };
    const { award } = command.action;
    const player = canonicalPlayer(command.player);
    if (command.at < state.window.opensAt || command.at > state.window.closesAt) return { refuse: "round-closed" };
    if (award.claim.playerId !== player) return { refuse: "wrong-player" };
    if (award.claim.points < 0 || award.claim.points > 50_000 || award.claim.kills < 0 || award.claim.kills > 500 || award.claim.headshots < 0 || award.claim.headshots > award.claim.kills) return { refuse: "invalid-award" };
    if (award.claim.points !== award.claim.kills * 100 + award.claim.headshots * 50) return { refuse: "invalid-score" };
    if (Math.abs(command.at - award.claim.issuedAt) > 10 * 60_000) return { refuse: "stale-award" };
    if ((state.claimedMatches[player] ?? []).includes(award.claim.matchId)) return { refuse: "already-claimed" };
    // The public key is injected into the reviewed gate config. The browser never possesses the signing key.
    if (award.claim.points > state.config.maxPointsPerPlayer || !verifyAwardClaim(award, state.config.serverPublicKey)) return { refuse: "invalid-signature" };
    return { events: [{ type: "award-accepted", player, matchId: award.claim.matchId, points: award.claim.points }], awards: [{ player, points: award.claim.points }] };
  },
  evolve(state, event) {
    if (event.type === "round-closed") return { ...state, closed: true };
    return {
      ...state,
      points: { ...state.points, [event.player]: (state.points[event.player] ?? 0) + event.points },
      claimedMatches: { ...state.claimedMatches, [event.player]: [...(state.claimedMatches[event.player] ?? []), event.matchId] },
    };
  },
  publicView(state) { return { phase: state.closed ? "closed" : "open", totalClaims: Object.values(state.claimedMatches).reduce((sum, matches) => sum + matches.length, 0) }; },
  playerView(state, player) { const key = canonicalPlayer(player); return { points: state.points[key] ?? 0, claimedMatches: state.claimedMatches[key] ?? [] }; },
  nextWakeAt(state) { return state.closed ? null : state.window.closesAt; },
  rewardBounds(config) { return { maxPointsPerPlayer: config.maxPointsPerPlayer }; },
});
