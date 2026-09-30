import {
  Button,
  ScreenScaffold,
  ValidatorDetail,
  ValidatorLogo,
  truncateAddress,
} from "@zunialab/ui";
import {
  validatorBondState,
  validatorWebsite,
  type ValidatorInfo,
} from "../../../lib/chain-queries";
import { catalogLogoSlugs, chainTicker, findCatalogEntry } from "../../../lib/chain-catalog";
import { formatUnits } from "../../../lib/format";
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
  const website = validatorWebsite(validator.website);
  const bond = validatorBondState(validator);

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
          avatar={
            <ValidatorLogo
              chainId={validator.chainId}
              chainName={chain?.chainName}
              logoSlugs={chain?.logoSlugs ?? catalogLogoSlugs(validator.chainId)}
              operatorAddress={validator.operatorAddress}
              identity={validator.identity}
              logoUrl={validator.logoUrl}
              moniker={validator.moniker}
              size={48}
            />
          }
          commission={`${(validator.commission * 100).toFixed(2)}%`}
          votingPower={`${(validator.votingPower * 100).toFixed(2)}%`}
          bonded={
            chain
              ? `${formatUnits(validator.tokens, chain.coinDecimals, 2)} ${chainTicker(chain)}`
              : undefined
          }
          website={
            website ? (
              <a href={website} target="_blank" rel="noreferrer" className="text-accent">
                {new URL(website).hostname.replace(/^www\./, "")}
              </a>
            ) : undefined
          }
          details={validator.details || undefined}
          status={bond}
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
