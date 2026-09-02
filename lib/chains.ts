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

function toChainInfo(entry: CatalogEntry): ChainInfo {
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

export function chainJsonFor(chainId: string): string {
  const found = findCatalogEntry(chainId);
  return JSON.stringify({
    chainId,
    bech32Prefix: found?.bech32Prefix ?? "cosmos",
    coinType: found?.coinType ?? 118,
  });
}

/** Onboarding list: Safrochain, Cosmos Hub, Osmosis, then mainnets, then testnets. */
export function chainsForOnboarding(): ChainInfo[] {
  return BUILTIN_CHAINS;
}
