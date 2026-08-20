import { normalizeWallet } from "./wallet-auth";

const MAX_EVIDENCE_BYTES = 8_192;

export interface AdmissionVerification {
  valid: boolean;
  playerId?: string;
}

export async function verifySessionEvidence(options: {
  evidence: unknown;
  playerId: string;
  matchId: string;
  sessionId: string;
  endpoint?: string;
  bearerToken?: string;
}): Promise<boolean> {
  if (!options.endpoint) return process.env.NODE_ENV !== "production";
  let serialized: string;
  try { serialized = JSON.stringify(options.evidence); } catch { return false; }
  if (!serialized || new TextEncoder().encode(serialized).length > MAX_EVIDENCE_BYTES) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetch(options.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.bearerToken ? { authorization: `Bearer ${options.bearerToken}` } : {}),
      },
      body: JSON.stringify({ evidence: options.evidence, playerId: options.playerId, matchId: options.matchId, sessionId: options.sessionId }),
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const result = await response.json() as AdmissionVerification;
    const expected = normalizeWallet(options.playerId);
    return result.valid === true && expected !== null && (!result.playerId || normalizeWallet(result.playerId) === expected);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
