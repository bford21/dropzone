const CALLSIGN_PREFIXES = ["ASH", "BLAZE", "COBALT", "DUSK", "FROST", "GHOST", "IRON", "NOVA", "ONYX", "RAPID", "SOLAR", "WILD"] as const;
const CALLSIGN_SUFFIXES = ["ACE", "HAWK", "JACKAL", "LYNX", "MAMBA", "RAVEN", "ROOK", "SCOUT", "VIPER", "WOLF"] as const;

export function randomCallsign(random: () => number = Math.random): string {
  const prefix = CALLSIGN_PREFIXES[Math.floor(random() * CALLSIGN_PREFIXES.length) % CALLSIGN_PREFIXES.length];
  const suffix = CALLSIGN_SUFFIXES[Math.floor(random() * CALLSIGN_SUFFIXES.length) % CALLSIGN_SUFFIXES.length];
  return `${prefix}_${suffix}`;
}
