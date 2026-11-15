/* eslint-disable @typescript-eslint/no-explicit-any -- LCD JSON of unknown shape */
/**
 * Live check, off by default: `ZUNIA_LIVE=1 pnpm exec vitest run lib/__tests__/live-claims.test.ts`.
 *
 * For a real delegator with rewards on several validators it builds the claim
 * the way the wallet does (msgWithdrawReward, claimTargets, the amino TxRaw
 * encoder, the chain's pubkey type) and POSTs `/cosmos/tx/v1beta1/simulate`
 * with a zero signature at the account's real sequence. Simulation skips the
 * signature check, so the node still runs the messages and reports gas. Then:
 * the simulation succeeds, the wallet's gas limit covers gas used, and the
 * fee meets the node's minimum gas price.
 */
import { describe, expect, it } from "vitest";

import { msgWithdrawReward } from "../amino-tx";
import { parseAccountBody } from "../broadcast";
import { chainUsesEthKeySign, ethPubKeyTypeUrlFor, findCatalogEntry } from "../chain-catalog";
import { claimFallbackGas, claimTargets } from "../claim-plan";
import { fromBase64 } from "../kernel";
import { DEFAULT_SETTINGS } from "../settings";
import { resolveTxMemo } from "../tx-memo";
import {
  buildSimulateBytes,
  feeAmountFor,
  fetchMinGasPrice,
  planFee,
  simulateGas,
  toRatio,
} from "../tx-fee";

const LIVE = process.env.ZUNIA_LIVE === "1";

const LCDS: Record<string, string[]> = {
  "safrochain-1": ["https://api.safrochain.network"],
  "cosmoshub-4": ["https://cosmos-rest.publicnode.com"],
  "osmosis-1": ["https://osmosis-rest.publicnode.com"],
  "injective-1": ["https://lcd-injective.keplr.app", "https://sentry.lcd.injective.network"],
};

async function getJson(base: string, path: string): Promise<any> {
  const res = await fetch(`${base}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

async function firstWorking(chainId: string): Promise<string> {
  for (const base of LCDS[chainId]!) {
    try {
      await getJson(base, "/cosmos/base/node/v1beta1/config");
      return base;
    } catch {
      /* try the next */
    }
  }
  throw new Error(`no LCD answered for ${chainId}`);
}

/** A delegator with unclaimed rewards on at least `want` validators. */
async function findDelegator(base: string, want: number) {
  const vals = await getJson(base, "/cosmos/staking/v1beta1/validators?status=BOND_STATUS_BONDED&pagination.limit=30");
  for (const v of vals.validators as Array<{ operator_address: string }>) {
    let delegations: any;
    try {
      delegations = await getJson(base, `/cosmos/staking/v1beta1/validators/${v.operator_address}/delegations?pagination.limit=40`);
    } catch {
      continue;
    }
    for (const row of delegations.delegation_responses ?? []) {
      const address: string = row.delegation.delegator_address;
      try {
        const rewards = await getJson(base, `/cosmos/distribution/v1beta1/delegators/${address}/rewards`);
        const rows = (rewards.rewards ?? []).filter((r: any) => (r.reward ?? []).some((c: any) => Number(c.amount) >= 1));
        if (rows.length >= want) return { address, rewards: rows as any[] };
      } catch {
        /* next delegator */
      }
    }
  }
  throw new Error("no delegator with rewards on several validators found");
}

describe.skipIf(!LIVE)("live claim simulation", () => {
  for (const chainId of Object.keys(LCDS)) {
    it(`${chainId}: a multi-validator claim simulates, its gas and fee are enough`, { timeout: 120_000 }, async () => {
      const entry = findCatalogEntry(chainId)!;
      const base = await firstWorking(chainId);
      const { address, rewards } = await findDelegator(base, 2);

      const rows = rewards.map((r) => ({
        validatorAddress: r.validator_address as string,
        rewards: String((r.reward as any[]).find((c) => c.denom === entry.coinMinimalDenom)?.amount ?? "0").split(".")[0]!,
        otherRewards: [],
      }));
      const { targets } = claimTargets(rows);
      expect(targets.length).toBeGreaterThan(0);
      const msgs = targets.map((t) => msgWithdrawReward({ delegatorAddress: address, validatorAddress: t.validatorAddress }));

      const accountBody = await getJson(base, `/cosmos/auth/v1beta1/accounts/${address}`);
      const account = parseAccountBody(accountBody);
      // The account's own key when it has signed before; any compressed key otherwise.
      let pubKey: Uint8Array = new Uint8Array(33).fill(2);
      const onChain = JSON.stringify(accountBody).match(/"key":"([A-Za-z0-9+/=]{44})"/)?.[1];
      if (onChain && fromBase64(onChain).length === 33) pubKey = fromBase64(onChain);
      else pubKey[0] = 2;

      const memo = resolveTxMemo("", msgs, chainId);
      const fallbackGas = BigInt(claimFallbackGas(msgs.length));
      const bytes = buildSimulateBytes({
        chainId,
        accountNumber: account.accountNumber,
        sequence: account.sequence,
        msgs,
        memo,
        gasLimit: fallbackGas,
        pubKey,
        ethKeyType: chainUsesEthKeySign(chainId),
        ethPubKeyTypeUrl: ethPubKeyTypeUrlFor(chainId),
      });
      const gasUsed = await simulateGas(async (path, body) => {
        const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
        return { status: res.status, body: await res.json().catch(() => null) };
      }, bytes);
      expect(gasUsed, "simulation must succeed").not.toBeNull();

      const feeDenom = entry.feeMinimalDenom;
      const nodeMin = await fetchMinGasPrice((p) => getJson(base, p), feeDenom);
      const step = entry.gasPriceStep?.[DEFAULT_SETTINGS.feeSpeed] ?? 0.025;
      const plan = planFee({
        callerGas: fallbackGas,
        callerFee: [],
        feeDenom,
        walletPrice: toRatio(step),
        nodeMinPrice: nodeMin,
        simulatedGas: gasUsed,
        gasAdjustment: DEFAULT_SETTINGS.gasAdjustment,
      });
      const feeAmount = BigInt(plan.fee.amount[0]?.amount ?? "0");
      const minFee = nodeMin ? feeAmountFor(plan.gas, nodeMin) : 0n;

      expect(plan.gas).toBeGreaterThanOrEqual(gasUsed!);
      // The fixed fallback is only for nodes that cannot simulate; it must still cover the work.
      expect(fallbackGas, `fixed fallback ${fallbackGas} vs gas used ${gasUsed} for ${msgs.length} msgs`).toBeGreaterThanOrEqual(gasUsed!);
      expect(feeAmount).toBeGreaterThanOrEqual(minFee);

      console.log(
        `LIVE ${chainId} ${base} delegator=${address.slice(0, 10)}… msgs=${msgs.length} seq=${account.sequence} acct#=${account.accountNumber}` +
          ` gasUsed=${gasUsed} gasLimit=${plan.gas} fallbackLimit=${fallbackGas}` +
          ` fee=${feeAmount}${feeDenom} nodeMinPrice=${nodeMin ? `${Number(nodeMin.num) / Number(nodeMin.den)}` : "none"} minFee=${minFee}`,
      );
    });
  }
});
