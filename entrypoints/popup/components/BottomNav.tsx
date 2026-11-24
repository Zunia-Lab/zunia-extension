import { TabBar } from "@zunialab/ui";
import { withoutSwap } from "../../../lib/features";
import type { PopupRoute } from "../routes";
import { IconActivity, IconGrid, IconStake, IconSwap } from "../screens/icons";

// No Swap tab in a build without swaps (lib/features.ts).
const ITEMS = withoutSwap([
  { id: "home", label: "Home", icon: <IconGrid width={18} height={18} /> },
  { id: "earn", label: "Earn", icon: <IconStake width={18} height={18} /> },
  { id: "swap", label: "Swap", icon: <IconSwap width={18} height={18} /> },
  {
    id: "activity",
    label: "Activity",
    icon: <IconActivity width={18} height={18} />,
  },
]);

export function BottomNav({
  value,
  onChange,
}: {
  value: PopupRoute;
  onChange: (route: PopupRoute) => void;
}) {
  return (
    <TabBar
      items={ITEMS}
      value={value}
      onChange={(id) => onChange(id as PopupRoute)}
    />
  );
}
