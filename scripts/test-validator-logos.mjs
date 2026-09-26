#!/usr/bin/env node
/**
 * Proves the two logo sources Earn uses: Keybase identity pictures and
 * Cosmostation moniker PNGs. Fails the process if either path is dead.
 */
const HUB = "https://lcd-cosmoshub.keplr.app";
const KEYBASE = "https://keybase.io/_/api/1.0/user/lookup.json";

function isHexIdentity(value) {
  const hex = (value ?? "").trim();
  return hex.length >= 8 && hex.length <= 64 && /^[0-9a-f]+$/i.test(hex);
}

async function main() {
  const staking = await fetch(
    `${HUB}/cosmos/staking/v1beta1/validators?status=BOND_STATUS_BONDED&pagination.limit=8`,
  );
  if (!staking.ok) throw new Error(`LCD ${staking.status}`);
  const body = await staking.json();
  const rows = (body.validators ?? []).map((v) => ({
    moniker: v.description?.moniker,
    operator: v.operator_address,
    identity: (v.description?.identity ?? "").trim(),
  }));

  const withId = rows.filter((r) => isHexIdentity(r.identity));
  if (withId.length === 0) throw new Error("no hex identities on the Hub sample");

  let keybaseHits = 0;
  for (const row of withId.slice(0, 5)) {
    const res = await fetch(
      `${KEYBASE}?key_suffix=${encodeURIComponent(row.identity)}&fields=pictures`,
      { headers: { Accept: "application/json" } },
    );
    const data = await res.json();
    const url = data?.them?.[0]?.pictures?.primary?.url;
    const img = url
      ? await fetch(url, { method: "HEAD", redirect: "follow" })
      : null;
    const ok = Boolean(url) && Boolean(img?.ok);
    if (ok) keybaseHits += 1;
    console.log(
      `keybase  ${ok ? "ok" : "miss"}  ${row.moniker}  ${row.identity}  ${url ?? "-"}`,
    );
  }
  if (keybaseHits === 0) throw new Error("Keybase returned no pictures");

  let monoHits = 0;
  const hosts = [
    (op) =>
      `https://cdn.jsdelivr.net/gh/cosmostation/chainlist@master/chain/cosmos/moniker/${op}.png`,
    (op) =>
      `https://raw.githubusercontent.com/cosmostation/chainlist/master/chain/cosmos/moniker/${op}.png`,
  ];
  for (const row of rows.slice(0, 5)) {
    let hit = false;
    for (const host of hosts) {
      const url = host(row.operator);
      const res = await fetch(url, { method: "HEAD", redirect: "follow" });
      if (res.ok) {
        monoHits += 1;
        hit = true;
        console.log(`moniker  ok  ${row.moniker}  ${url}`);
        break;
      }
    }
    if (!hit) {
      console.log(`moniker  miss  ${row.moniker}  ${row.operator}`);
    }
  }
  if (monoHits === 0) {
    throw new Error("Cosmostation has no cosmos moniker PNGs for the Hub sample");
  }

  console.log(
    `validator logos: ${keybaseHits} Keybase pictures, ${monoHits} Cosmostation monikers`,
  );
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
