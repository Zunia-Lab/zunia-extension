import { chainJsonFor } from "./chains";
import { loadKernel } from "./kernel";
import {
  derivationIndexOf,
  getAccounts,
  getSessionMnemonic,
  getSessionMnemonicMap,
} from "./session";

export interface AccountAddress {
  index: number;
  name: string;
  address: string;
}

/**
 * Bech32 address of every account on one chain, so a picker can show the
 * prefix the dApp will actually receive (osmo1…, not the cosmos1… we store
 * against the account record).
 *
 * Requires an unlocked session: the phrase stays in the background worker and
 * only derived addresses cross the message boundary.
 */
export async function getAccountAddresses(
  chainId: string,
): Promise<AccountAddress[]> {
  const phrase = await getSessionMnemonic();
  if (!phrase) throw new Error("Wallet is locked");
  const kernel = await loadKernel();
  const chainJson = chainJsonFor(chainId);
  const accounts = await getAccounts();
  const map = await getSessionMnemonicMap();
  return accounts.map((account) => {
    const seed =
      (account.ownSeed ? map[String(account.index)] : map.primary) ??
      map.primary ??
      phrase;
    return {
      index: account.index,
      name: account.name,
      address: kernel.deriveAddress(
        seed,
        "",
        chainJson,
        derivationIndexOf(account),
      ).bech32Address,
    };
  });
}
