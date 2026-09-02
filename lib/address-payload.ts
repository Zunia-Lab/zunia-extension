import { isBech32 } from "./format";

/**
 * Pull a bech32 address out of a QR payload (plain address or cosmos: URI).
 */
export function extractBech32Address(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (isBech32(value)) return value;

  // cosmos:safro1… or cosmos:osmosis-1/ibc/… style URIs
  try {
    if (value.includes(":")) {
      const afterScheme = value.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:/, "");
      const candidate = afterScheme.split(/[/?#\s]/)[0] ?? "";
      if (isBech32(candidate)) return candidate;
      // Some wallets encode cosmos:{address}
      const nested = afterScheme.split("/").find((part) => isBech32(part));
      if (nested) return nested;
    }
  } catch {
    /* ignore */
  }

  const match = value.match(/\b([a-z]{2,16}1[0-9a-z]{20,})\b/i);
  if (match && isBech32(match[1]!)) return match[1]!;
  return null;
}
