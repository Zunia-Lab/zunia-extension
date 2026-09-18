import {
  AssetDetail,
  Button,
  ScreenScaffold,
} from "@zunialab/ui";
import type { ChainBalance } from "../../../lib/balances";
import type { SpotPrice } from "../../../lib/prices";
import { formatFiat, formatUnits, NO_VALUE } from "../../../lib/format";
import type { ChainAccountView } from "../hooks/useChainAccounts";
import { usePrefs } from "../state/Prefs";
import type { PopupRoute } from "../routes";

export function AssetDetailScreen({
  chain,
  balance,
  price,
  onBack,
  onNavigate,
}: {
  chain: ChainAccountView;
  balance?: ChainBalance;
  price?: SpotPrice;
  onBack: () => void;
  onNavigate: (route: PopupRoute, chainId?: string) => void;
}) {
  const { hidden, settings } = usePrefs();
  const currency = settings.currency ?? "USD";
  const available = balance?.available ?? "0";
  const amount = hidden
    ? "••••"
    : formatUnits(available, chain.entry.coinDecimals);
  const whole = Number(formatUnits(available, chain.entry.coinDecimals)) || 0;
  const fiat =
    price && !hidden
      ? formatFiat(whole * price.price, currency)
      : hidden
        ? "••••"
        : NO_VALUE;

  return (
    <ScreenScaffold title={chain.entry.coinDenom} onBack={onBack}>
      <div className="flex flex-col gap-4 pt-1">
        <AssetDetail
          name={chain.entry.chainName}
          symbol={chain.entry.coinDenom}
          amount={amount}
          fiat={fiat === NO_VALUE ? undefined : fiat}
          chainLabel={chain.entry.chainName}
          actions={
            <div className="flex gap-2">
              <Button
                className="flex-1"
                onClick={() => onNavigate("send", chain.chainId)}
              >
                Send
              </Button>
              <Button
                variant="secondary"
                className="flex-1"
                onClick={() => onNavigate("receive", chain.chainId)}
              >
                Receive
              </Button>
            </div>
          }
        />
      </div>
    </ScreenScaffold>
  );
}
