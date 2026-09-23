import {
  Button,
  ScreenScaffold,
  ValidatorDetail,
  truncateAddress,
} from "@zunialab/ui";
import type { ValidatorInfo } from "../../../lib/chain-queries";
import { findCatalogEntry } from "../../../lib/chain-catalog";
import { useToast } from "../state/Toasts";
import { IconCopy } from "./icons";

export function ValidatorDetailScreen({
  validator,
  onBack,
  onStake,
  onOpenChain,
}: {
  validator: ValidatorInfo;
  onBack: () => void;
  /** Back to Earn with this validator picked for the Delegate button. */
  onStake: (validator: ValidatorInfo) => void;
  onOpenChain: (chainId: string) => void;
}) {
  const toast = useToast();
  const chain = findCatalogEntry(validator.chainId);

  async function copyOperator() {
    try {
      await navigator.clipboard.writeText(validator.operatorAddress);
      toast("Operator address copied", {
        meta: truncateAddress(validator.operatorAddress, 10, 6),
      });
    } catch {
      toast("Could not copy the address", { tone: "danger" });
    }
  }

  return (
    <ScreenScaffold
      title={validator.moniker}
      onBack={onBack}
      footer={
        <div className="flex gap-2">
          <Button
            variant="secondary"
            className="min-w-0 flex-1"
            onClick={() => onOpenChain(validator.chainId)}
          >
            <span className="min-w-0 truncate">
              {chain?.chainName ?? "Network"}
            </span>
          </Button>
          <Button
            className="flex-1"
            disabled={validator.jailed}
            onClick={() => onStake(validator)}
          >
            {validator.jailed ? "Jailed" : "Stake"}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4 pt-1">
        <ValidatorDetail
          name={validator.moniker}
          moniker={truncateAddress(validator.operatorAddress, 14, 8)}
          commission={`${(validator.commission * 100).toFixed(2)}%`}
          votingPower={`${(validator.votingPower * 100).toFixed(2)}%`}
          status={validator.jailed ? "jailed" : "bonded"}
          actions={
            <Button
              variant="ghost"
              size="sm"
              className="self-start"
              onClick={() => void copyOperator()}
            >
              <IconCopy width={14} height={14} aria-hidden />
              Copy operator address
            </Button>
          }
        />
      </div>
    </ScreenScaffold>
  );
}
