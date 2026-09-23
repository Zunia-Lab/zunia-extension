/**
 * Warnings about the site asking to connect or sign, computed from its origin alone.
 *
 * There is no remote blocklist behind this: it catches the lookalike patterns a
 * phishing page relies on (a well-known dApp's name inside a different domain,
 * a one-letter typo, punycode, a bare IP) and says so in the prompt. It never
 * blocks on its own; the user decides with the warning in front of them.
 */

/** Registrable domains of dApps people are commonly tricked into "reconnecting" to. */
const KNOWN_DOMAINS = [
  "osmosis.zone",
  "keplr.app",
  "leapwallet.io",
  "cosmostation.io",
  "mintscan.io",
  "astroport.fi",
  "stargaze.zone",
  "daodao.zone",
  "stride.zone",
  "neutron.org",
  "celestia.org",
  "injective.com",
  "injective.network",
  "kujira.network",
  "levana.finance",
  "dydx.exchange",
  "skip.build",
  "restake.app",
  "zunialab.com",
] as const;

/** Brand tokens long enough that finding one inside another domain means something. */
const BRAND_TOKENS = KNOWN_DOMAINS.map((d) => d.split(".")[0]).filter((t) => t.length >= 5);

export interface OriginRisk {
  warnings: string[];
}

function registrableDomain(host: string): string {
  const labels = host.split(".");
  return labels.length <= 2 ? host : labels.slice(-2).join(".");
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = temp;
    }
  }
  return row[b.length];
}

function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
}

function isIpAddress(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.startsWith("[");
}

export function assessOrigin(origin: string): OriginRisk {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return { warnings: ["Zunia could not read this site's address."] };
  }
  const host = url.hostname.toLowerCase();
  const warnings: string[] = [];

  if (isLocalHost(host)) {
    return { warnings: ["This is a site running on your own computer."] };
  }
  if (url.protocol !== "https:") {
    warnings.push("The connection to this site is not encrypted.");
  }
  if (isIpAddress(host)) {
    warnings.push("This site is reached by a raw IP address instead of a name.");
  }
  if (host.split(".").some((label) => label.startsWith("xn--"))) {
    warnings.push(
      "The address uses international characters, which can imitate another site's name.",
    );
  }

  const domain = registrableDomain(host);
  if (!(KNOWN_DOMAINS as readonly string[]).includes(domain)) {
    const typo = KNOWN_DOMAINS.find(
      (known) => known.length >= 6 && editDistance(domain, known) <= 2,
    );
    const embedded = BRAND_TOKENS.find((token) => host.includes(token));
    const imitated = typo ?? (embedded ? KNOWN_DOMAINS.find((d) => d.startsWith(embedded)) : undefined);
    if (imitated) {
      warnings.push(
        `The address resembles ${imitated} but is a different site (${domain}). Check it carefully.`,
      );
    }
  }

  return { warnings };
}
