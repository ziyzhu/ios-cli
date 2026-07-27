export interface LocalLaunchUrl {
  key: string;
  endpoint: string;
}

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function isLoopbackHostname(hostname: string): boolean {
  const host = normalizedHostname(hostname);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "0.0.0.0" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true;

  const octets = host.split(".");
  if (octets.length !== 4 || octets.some((octet) => !/^\d+$/.test(octet) || Number(octet) > 255)) return false;
  return Number(octets[0]) === 127;
}

export function localLaunchUrls(env: Record<string, string>): LocalLaunchUrl[] {
  const matches: LocalLaunchUrl[] = [];
  for (const [key, value] of Object.entries(env)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      continue;
    }
    if (!url.hostname || !isLoopbackHostname(url.hostname)) continue;
    matches.push({ key, endpoint: `${url.protocol}//${url.host}` });
  }
  return matches;
}

export function physicalLaunchEnvError(env: Record<string, string>): string | undefined {
  const matches = localLaunchUrls(env);
  if (matches.length === 0) return undefined;
  const values = matches.map(({ key, endpoint }) => `${key}=${endpoint}`).join(", ");
  return `physical target cannot use loopback launch URLs: ${values}. Override them with device-reachable URLs using --env KEY=VAL`;
}
