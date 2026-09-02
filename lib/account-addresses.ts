import { chainJsonFor } from "./chains";
import { loadKernel } from "./kernel";
import { getAccounts, getSessionMnemonic } from "./session";

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
  return accounts.map((account) => ({
    index: account.index,
    name: account.name,
    address: kernel.deriveAddress(phrase, "", chainJson, account.index)
      .bech32Address,
  }));
}
