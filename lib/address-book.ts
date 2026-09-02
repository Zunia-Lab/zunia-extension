import { STORAGE_KEYS } from "./storage-keys";

export interface AddressBookEntry {
  id: string;
  label: string;
  address: string;
  chainId?: string;
  createdAt: number;
}

export async function listAddressBook(): Promise<AddressBookEntry[]> {
  const result = await browser.storage.local.get(STORAGE_KEYS.addressBook);
  const rows =
    (result[STORAGE_KEYS.addressBook] as AddressBookEntry[] | undefined) ?? [];
  return [...rows].sort((a, b) => a.label.localeCompare(b.label));
}

export async function saveAddressBookEntry(input: {
  label: string;
  address: string;
  chainId?: string;
}): Promise<AddressBookEntry[]> {
  const label = input.label.trim().slice(0, 40);
  const address = input.address.trim();
  if (!label) throw new Error("Give this address a label");
  if (!/^[a-z0-9]+1[02-9ac-hj-np-z]{20,}$/.test(address)) {
    throw new Error("That does not look like a bech32 address");
  }
  const rows = await listAddressBook();
  if (rows.some((r) => r.address === address)) {
    throw new Error("That address is already saved");
  }
  const next: AddressBookEntry[] = [
    ...rows,
    {
      id: crypto.randomUUID(),
      label,
      address,
      chainId: input.chainId,
      createdAt: Date.now(),
    },
  ];
  await browser.storage.local.set({ [STORAGE_KEYS.addressBook]: next });
  return next;
}

export async function removeAddressBookEntry(
  id: string,
): Promise<AddressBookEntry[]> {
  const next = (await listAddressBook()).filter((r) => r.id !== id);
  await browser.storage.local.set({ [STORAGE_KEYS.addressBook]: next });
  return next;
}
