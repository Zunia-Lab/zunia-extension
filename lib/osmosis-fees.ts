/**
 * Paying Osmosis gas in something other than OSMO.
 *
 * ## Why this exists
 *
 * Zunia's cross-chain swap already avoids the problem it is most often
 * associated with. A swap is one `MsgTransfer` signed on the *source* chain
 * carrying an ibc-hooks memo; the Osmosis half runs inside `OnRecvPacket`,
 * which is the relayer's transaction, not the user's. Nobody needs OSMO for
 * that, and nobody ever needed an Osmosis account for it. Keplr's IBC Swap
 * reaches the same outcome by a different route - it routes through Skip Go,
 * whose Smart Relay pays the intermediate gas and takes its cut out of the
 * amount being moved - but the user-visible property is the same: gas on the
 * chain in the middle is not the user's problem.
 *
 * What is left over is the case where the user *is* on Osmosis: a token that
 * already lives there, a recovery call on the crosschain-swaps contract after
 * a failed delivery, or an ordinary send. Those are the user's own Osmosis
 * transactions and they do need Osmosis gas. Holding a bag of USDC on Osmosis
 * and being unable to move it because there is no OSMO for the fee is the
 * actual dead end, and it is the one this module removes.
 *
 * ## How Osmosis allows it
 *
 * Osmosis's `x/txfees` module keeps an allow-list of denoms accepted as gas,
 * each paired with a pool that prices it against OSMO. At the time of writing
 * the list is 161 denoms. Three endpoints are all a wallet needs:
 *
 * - `/osmosis/txfees/v1beta1/fee_tokens` - the allow-list.
 * - `/osmosis/txfees/v1beta1/spot_price_by_denom?denom=X` - `uosmo` per unit of
 *   `X`, the same conversion the chain's own fee decorator applies.
 * - `/osmosis/txfees/v1beta1/cur_eip_base_fee` - the current base fee per unit
 *   of gas, which Osmosis moves EIP-1559 style rather than holding fixed.
 *
 * The chain converts a fee paid in `X` back to OSMO by multiplying by the spot
 * price, so a wallet going the other way divides. Everything here is that one
 * piece of arithmetic plus the honesty around it: a token is only offered when
 * the chain accepts it, it is priced from the chain's own numbers, and a
 * balance too small to cover the fee is shown as such rather than offered and
 * then rejected on broadcast.
 */

import type { TokenBalance } from "./balances";

/** The chain this applies to. Nothing here is attempted anywhere else. */
export const OSMOSIS_CHAIN_ID = "osmosis-1";

/** `uosmo`. Also what the endpoints return as the base denom. */
export const OSMOSIS_BASE_DENOM = "uosmo";

/**
 * Headroom over the quoted base fee.
 *
 * Osmosis recomputes the base fee every block, so the number read while the
 * user is looking at a confirm screen is not the number in force when the
 * transaction is included. 25% covers ordinary movement; without it a fee
 * priced exactly at the current base fee fails on the next busy block, which
 * to the user looks like the wallet mispricing rather than the chain moving.
 */
export const BASE_FEE_HEADROOM = 1.25;

/** One denom the chain will accept as gas. */
export interface FeeTokenRow {
  readonly denom: string;
  readonly poolId: string;
}

/** A fee denom, priced, with what the user holds of it. */
export interface FeeTokenOption {
  readonly denom: string;
  readonly symbol: string;
  readonly decimals: number;
  /** Base units of `denom` this transaction's gas costs. */
  readonly amount: string;
  /** Base units held. */
  readonly held: string;
  /** False when `held` will not cover `amount`. Offered anyway, and labelled. */
  readonly affordable: boolean;
  /** `uosmo` per base unit of `denom`, as the chain prices it. */
  readonly spotPrice: string;
}

/* -------------------------------------------------------------------------- *
 * The arithmetic
 * -------------------------------------------------------------------------- */

/** Decimal places kept when turning the chain's decimal strings into integers. */
const SCALE = 18;
const UNIT = 10n ** BigInt(SCALE);

/**
 * A fixed-point decimal string as an integer scaled by 10^18.
 *
 * The chain returns `spot_price` and `base_fee` as decimal strings with
 * eighteen places. Reading them through `Number` loses precision on the large
 * ones and, worse, does it silently; every value here stays a BigInt from the
 * string to the final rounded amount.
 */
export function parseDecimal(value: string): bigint | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [whole = "0", fraction = ""] = trimmed.split(".");
  return BigInt(whole + fraction.slice(0, SCALE).padEnd(SCALE, "0"));
}

/**
 * Base units of the fee token needed to cover `gas`.
 *
 * `gas × baseFee` is the cost in `uosmo`; dividing by the spot price converts
 * it into the fee denom, because the chain multiplies by the same number to
 * convert back. Rounded up, always: a fee one base unit short is refused
 * outright, and one base unit of any of these denoms is worth nothing.
 *
 * Returns null for a spot price of zero, which is what the endpoint reports for
 * a denom whose pool has been drained - dividing by it would produce an
 * enormous fee rather than an error.
 */
export function feeTokenAmount(input: {
  gas: bigint;
  /** `uosmo` per unit of gas, scaled by 10^18. */
  baseFee: bigint;
  /** `uosmo` per base unit of the fee denom, scaled by 10^18. */
  spotPrice: bigint;
  headroom?: number;
}): string | null {
  if (input.spotPrice <= 0n || input.baseFee <= 0n || input.gas <= 0n) return null;
  const headroom = BigInt(Math.round((input.headroom ?? BASE_FEE_HEADROOM) * 1000));
  // gas × baseFee × headroom / (1000 × spotPrice), rounded up.
  const numerator = input.gas * input.baseFee * headroom;
  const denominator = 1000n * input.spotPrice;
  return ((numerator + denominator - 1n) / denominator).toString();
}

/* -------------------------------------------------------------------------- *
 * Reading the chain
 * -------------------------------------------------------------------------- */

/** A JSON GET against the venue chain's LCD. Supplied by the caller. */
export type LcdGet = (path: string) => Promise<unknown>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/** The chain's allow-list of gas denoms. */
export async function fetchFeeTokens(get: LcdGet): Promise<FeeTokenRow[]> {
  const body = asRecord(await get("/osmosis/txfees/v1beta1/fee_tokens"));
  const rows = body?.fee_tokens;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((raw): FeeTokenRow[] => {
    const row = asRecord(raw);
    const denom = row?.denom;
    if (typeof denom !== "string" || denom.length === 0) return [];
    // The field is `poolID` in the REST response, not `pool_id`.
    const poolId = row?.poolID ?? row?.pool_id;
    return [{ denom, poolId: typeof poolId === "string" ? poolId : "" }];
  });
}

/** Current base fee per unit of gas, in `uosmo`, scaled by 10^18. */
export async function fetchBaseFee(get: LcdGet): Promise<bigint | null> {
  const body = asRecord(await get("/osmosis/txfees/v1beta1/cur_eip_base_fee"));
  const raw = body?.base_fee;
  return typeof raw === "string" ? parseDecimal(raw) : null;
}

/** `uosmo` per base unit of `denom`, scaled by 10^18. */
export async function fetchSpotPrice(
  get: LcdGet,
  denom: string,
): Promise<bigint | null> {
  const body = asRecord(
    await get(
      `/osmosis/txfees/v1beta1/spot_price_by_denom?denom=${encodeURIComponent(denom)}`,
    ),
  );
  const raw = body?.spot_price;
  return typeof raw === "string" ? parseDecimal(raw) : null;
}

/* -------------------------------------------------------------------------- *
 * What to offer the user
 * -------------------------------------------------------------------------- */

/**
 * Every denom this account holds that Osmosis will also take as gas, priced.
 *
 * Intersected with the user's own balances on purpose. The allow-list is 161
 * denoms and a picker with 161 rows, 159 of which the user holds none of, is
 * not a feature. What the user needs to know is narrow: *of the things I have
 * here, which can pay for this, and how much would it cost.*
 *
 * OSMO itself is included and sorted first when held - it is the default and
 * the cheapest to verify - and each alternative is priced with one spot-price
 * read. Reads run in parallel and a denom whose price cannot be read is
 * dropped rather than shown unpriced.
 */
export async function osmosisFeeOptions(input: {
  get: LcdGet;
  gas: string;
  tokens: readonly TokenBalance[];
}): Promise<FeeTokenOption[]> {
  let gas: bigint;
  try {
    gas = BigInt(input.gas);
  } catch {
    return [];
  }
  if (gas <= 0n) return [];

  const [feeTokens, baseFee] = await Promise.all([
    fetchFeeTokens(input.get).catch(() => [] as FeeTokenRow[]),
    fetchBaseFee(input.get).catch(() => null),
  ]);
  if (baseFee === null) return [];

  const accepted = new Set(feeTokens.map((row) => row.denom));
  const held = input.tokens.filter(
    (token) => token.denom === OSMOSIS_BASE_DENOM || accepted.has(token.denom),
  );
  if (held.length === 0) return [];

  const priced = await Promise.all(
    held.map(async (token): Promise<FeeTokenOption | null> => {
      // OSMO is the base denom; the chain does not price it against itself.
      const spotPrice =
        token.denom === OSMOSIS_BASE_DENOM
          ? UNIT
          : await fetchSpotPrice(input.get, token.denom).catch(() => null);
      if (spotPrice === null) return null;
      const amount = feeTokenAmount({ gas, baseFee, spotPrice });
      if (amount === null) return null;
      let heldUnits: bigint;
      try {
        heldUnits = BigInt(token.amount);
      } catch {
        heldUnits = 0n;
      }
      return {
        denom: token.denom,
        symbol: token.symbol,
        decimals: token.decimals,
        amount,
        held: token.amount,
        affordable: heldUnits >= BigInt(amount),
        spotPrice: spotPrice.toString(),
      };
    }),
  );

  return priced
    .filter((row): row is FeeTokenOption => row !== null)
    .sort((a, b) => {
      // OSMO first, then what the user can actually afford, then by ticker so
      // the order does not shuffle between renders as prices move.
      if (a.denom === OSMOSIS_BASE_DENOM) return -1;
      if (b.denom === OSMOSIS_BASE_DENOM) return 1;
      if (a.affordable !== b.affordable) return a.affordable ? -1 : 1;
      return a.symbol.localeCompare(b.symbol);
    });
}

/**
 * The option a transaction should default to.
 *
 * OSMO when the user holds enough of it, because it is what every Osmosis tool
 * assumes and it needs no pool lookup to verify. Otherwise the cheapest
 * affordable alternative measured in what it costs, which is the choice a user
 * with no OSMO would make anyway. Null when nothing on the list can pay, which
 * the caller must surface rather than silently signing a fee that will bounce.
 */
export function preferredFeeToken(
  options: readonly FeeTokenOption[],
): FeeTokenOption | null {
  const osmo = options.find(
    (row) => row.denom === OSMOSIS_BASE_DENOM && row.affordable,
  );
  if (osmo) return osmo;
  const affordable = options.filter((row) => row.affordable);
  if (affordable.length === 0) return null;
  // "Cheapest" across different denoms is a comparison of value, and the one
  // common yardstick already in hand is the spot price: amount × spotPrice is
  // each option's cost expressed in uosmo.
  return affordable.reduce((best, row) => {
    const cost = BigInt(row.amount) * BigInt(row.spotPrice);
    const bestCost = BigInt(best.amount) * BigInt(best.spotPrice);
    return cost < bestCost ? row : best;
  });
}
