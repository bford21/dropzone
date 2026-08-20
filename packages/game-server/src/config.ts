export function serverPort(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = env.PORT ?? env.GAME_SERVER_PORT ?? "8081";
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error("PORT must be an integer between 0 and 65535");
  return port;
}
