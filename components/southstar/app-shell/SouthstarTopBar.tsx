import type { SouthstarProductTab } from "./SouthstarTabRail";

export function SouthstarTopBar(props: { activeTab: SouthstarProductTab }) {
  return (
    <header className="ss-product-topbar">
      <div className="ss-product-brand"><span aria-hidden /> <strong>Southstar</strong><small>Workflow OS</small></div>
      <div className="ss-product-status"><span className="ss-status-dot" /> runtime healthy · {props.activeTab}</div>
    </header>
  );
}
