import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, encodeAwardClaim, hexToBytes } from "../../flaunch/src/claims";
import type { AwardClaim, SignedAwardClaim } from "../../shared/src/protocol";

// Development only. Production must set a unique 32-byte hex seed in GAME_AWARD_PRIVATE_KEY.
const DEV_SEED = "91b04bf7d5f228f33a4ff4aa8ebaf9d36d7a59cb04ba18bd8f89ad1777d5ae32";

export class AwardSigner {
  private readonly secretKey: Uint8Array;
  readonly publicKey: string;

  constructor(secretHex?: string, production = process.env.NODE_ENV === "production") {
    const configured = secretHex ?? process.env.GAME_AWARD_PRIVATE_KEY;
    if (!configured && production) {
      throw new Error("GAME_AWARD_PRIVATE_KEY is required in production; refusing to use the public development key");
    }
    secretHex = configured ?? DEV_SEED;
    const secret = hexToBytes(secretHex);
    if (!secret || secret.length !== 32) throw new Error("GAME_AWARD_PRIVATE_KEY must be a 32-byte hex seed");
    this.secretKey = secret;
    this.publicKey = bytesToHex(ed25519.getPublicKey(secret));
  }

  sign(claim: AwardClaim): SignedAwardClaim {
    return { claim, signature: bytesToHex(ed25519.sign(encodeAwardClaim(claim), this.secretKey)) };
  }
}
