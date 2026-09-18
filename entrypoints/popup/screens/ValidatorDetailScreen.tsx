import {
  Button,
  ScreenScaffold,
  ValidatorDetail,
} from "@zunialab/ui";
import type { ValidatorInfo } from "../../../lib/chain-queries";
import { findCatalogEntry } from "../../../lib/chain-catalog";
import type { PopupRoute } from "../routes";

export function ValidatorDetailScreen({
  validator,
  onBack,
  onNavigate,
}: {
  validator: ValidatorInfo;
  onBack: () => void;
  onNavigate: (route: PopupRoute, chainId?: string) => void;
}) {
  const chain = findCatalogEntry(validator.chainId);
  return (
    <ScreenScaffold title={validator.moniker} onBack={onBack}>
      <div className="flex flex-col gap-4 pt-1">
        <ValidatorDetail
          name={validator.moniker}
          moniker={validator.operatorAddress}
          commission={`${(validator.commission * 100).toFixed(2)}%`}
          votingPower={`${(validator.votingPower * 100).toFixed(2)}%`}
          status={validator.jailed ? "jailed" : "bonded"}
          actions={
            <div className="flex gap-2">
              <Button
                className="flex-1"
                disabled={validator.jailed}
                onClick={() => onNavigate("earn", validator.chainId)}
              >
                Stake
              </Button>
              <Button
                variant="secondary"
                className="flex-1"
                onClick={() => onNavigate("chain", validator.chainId)}
              >
                {chain?.chainName ?? "Chain"}
              </Button>
            </div>
          }
        />
      </div>
    </ScreenScaffold>
  );
}
