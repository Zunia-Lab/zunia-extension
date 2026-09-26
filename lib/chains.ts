import {
  CHAIN_CATALOG,
  catalogIconFor,
  findCatalogEntry,
  sortCatalog,
  type CatalogEntry,
  type ChainNetwork,
} from "./chain-catalog";

export interface ChainInfo {
  chainId: string;
  chainName: string;
  bech32Prefix: string;
  bip44: { coinType: number };
  network?: ChainNetwork;
  /** Bundled asset path or registry URL. */
  iconPath?: string;
  currencies: Array<{
    coinDenom: string;
    coinMinimalDenom: string;
    coinDecimals: number;
  }>;
  feeCurrencies: Array<{
    coinDenom: string;
    coinMinimalDenom: string;
    coinDecimals: number;
    gasPriceStep?: { low: number; average: number; high: number };
  }>;
  rpc?: string;
  rest?: string;
}

export function toChainInfo(entry: CatalogEntry): ChainInfo {
  return {
    chainId: entry.chainId,
    chainName: entry.chainName,
    bech32Prefix: entry.bech32Prefix,
    bip44: { coinType: entry.coinType },
    network: entry.network,
    iconPath: catalogIconFor(entry),
    currencies: [
      {
        coinDenom: entry.coinDenom,
        coinMinimalDenom: entry.coinMinimalDenom,
        coinDecimals: entry.coinDecimals,
      },
    ],
    feeCurrencies: [
      {
        coinDenom: entry.feeDenom,
        coinMinimalDenom: entry.feeMinimalDenom,
        coinDecimals: entry.feeDecimals,
        gasPriceStep:
          entry.gasPriceStep ?? { low: 0.01, average: 0.025, high: 0.04 },
      },
    ],
    rpc: entry.rpc,
    rest: entry.rest,
  };
}

/** Every chain shipped with the extension, mainnets and testnets. */
export const BUILTIN_CHAINS: ChainInfo[] = sortCatalog(CHAIN_CATALOG).map(
  toChainInfo,
);

export function getBuiltinChain(chainId: string): ChainInfo | undefined {
  const entry = findCatalogEntry(chainId);
  return entry ? toChainInfo(entry) : undefined;
}

/**
 * Kernel-facing chain document.
 *
 * Address derivation on the JS fallback still reads `bech32Prefix` / `coinType`.
 * WASM `signTx` parses the same string as Keplr `ChainInfo` and rejects anything
 * missing `chainName`, `rpc`, `rest`, `bip44`, `bech32Config`, or `feeCurrencies`
 * as "chain descriptor is malformed". Both shapes live in one object so every
 * signing path can pass this string unchanged.
 */
export function chainJsonFor(chainId: string): string {
  const found = findCatalogEntry(chainId);
  const prefix = found?.bech32Prefix ?? "cosmos";
  const coinType = found?.coinType ?? 118;
  const feeDenom = found?.feeDenom ?? found?.coinDenom ?? "ATOM";
  const feeMinimalDenom = found?.feeMinimalDenom ?? found?.coinMinimalDenom ?? "uatom";
  const feeDecimals = found?.feeDecimals ?? found?.coinDecimals ?? 6;
  const currency = found
    ? {
        coinDenom: found.coinDenom,
        coinMinimalDenom: found.coinMinimalDenom,
        coinDecimals: found.coinDecimals,
      }
    : {
        coinDenom: feeDenom,
        coinMinimalDenom: feeMinimalDenom,
        coinDecimals: feeDecimals,
      };
  const feeCurrency = {
    coinDenom: feeDenom,
    coinMinimalDenom: feeMinimalDenom,
    coinDecimals: feeDecimals,
    gasPriceStep: found?.gasPriceStep ?? { low: 0.01, average: 0.025, high: 0.04 },
  };
  return JSON.stringify({
    chainId,
    chainName: found?.chainName ?? chainId,
    rpc: kernelEndpoint(found?.rpc),
    rest: kernelEndpoint(found?.rest),
    bip44: { coinType },
    bech32Config: { bech32PrefixAccAddr: prefix },
    currencies: [currency],
    feeCurrencies: [feeCurrency],
    features: found?.features ?? [],
    bech32Prefix: prefix,
    coinType,
  });
}

/** `ChainInfo::validate` accepts https or loopback; LCD traffic uses catalog URLs. */
function kernelEndpoint(url: string | undefined): string {
  if (
    url &&
    (url.startsWith("https://") ||
      url.startsWith("http://localhost") ||
      url.startsWith("http://127.0.0.1") ||
      url.startsWith("http://0.0.0.0"))
  ) {
    return url;
  }
  return "https://rpc.invalid";
}

/** Onboarding list: Safrochain, Cosmos Hub, Osmosis, then mainnets, then testnets. */
export function chainsForOnboarding(): ChainInfo[] {
  return BUILTIN_CHAINS;
}
