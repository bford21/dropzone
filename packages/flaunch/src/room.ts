import { connectEmbeddedGame, createMockRoom, joinRoom } from "@flayerlabs/gamemode-client";
import type { Room } from "@flayerlabs/gamemode-client";
import type { SignedAwardClaim } from "../../shared/src/protocol";
import { dropzoneRules, type ClaimAction, type DropzonePlayerView, type DropzonePublicView } from "./rules";

export type DropzoneRoom = Room<DropzonePublicView, DropzonePlayerView, ClaimAction>;
export interface DropzoneAdmissionProof { signature?: string; evidence?: unknown }
export interface DropzoneRoomSession {
  room: DropzoneRoom;
  playerId: string;
  createAdmissionProof(challenge: string): Promise<DropzoneAdmissionProof>;
  dispose(): void;
}

export async function createDropzoneRoom(options: { playerId: string; serverPublicKey: string; parentOrigin?: string }): Promise<DropzoneRoomSession> {
  const config = { serverPublicKey: options.serverPublicKey, maxPointsPerPlayer: 50_000 };
  if (options.parentOrigin && typeof window !== "undefined" && window.parent !== window) {
    const embedded = await connectEmbeddedGame({ parentOrigin: options.parentOrigin });
    try {
      const playerId = await embedded.host.address();
      if (!playerId) throw new Error("A connected Flaunch wallet is required");
      const room = await joinRoom<DropzonePublicView, DropzonePlayerView, ClaimAction>({
        gateUrl: embedded.context.gateUrl,
        roundId: embedded.context.roundId,
        host: embedded.host,
        launch: embedded.context.launch,
        platform: embedded.platform,
      });
      return {
        room,
        playerId: playerId.toLowerCase(),
        async createAdmissionProof(challenge) {
          const signature = await embedded.host.signIn(challenge);
          const evidence = await embedded.host.sessionEvidence?.();
          return { signature, ...(evidence === undefined ? {} : { evidence }) };
        },
        dispose() { room.dispose(); embedded.dispose(); },
      };
    } catch (error) {
      embedded.dispose();
      throw error;
    }
  }
  const room = createMockRoom(dropzoneRules, { config, player: options.playerId, seed: 47, lobbyMs: 0, roundMs: 60 * 60_000, weiPerPoint: BigInt("1000000000000") });
  return { room, playerId: options.playerId, async createAdmissionProof() { return {}; }, dispose() { room.dispose(); } };
}

export async function claimVerifiedAward(room: DropzoneRoom, award: SignedAwardClaim) {
  return room.send({ type: "claim", award });
}
