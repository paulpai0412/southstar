import { SideRail } from "./SideRail";
import { TopRunBar } from "./TopRunBar";
import { StatusFooter } from "./StatusFooter";

export function SouthstarShell(props: { title: string; runId?: string | null; status?: string | null; children: React.ReactNode }) {
  return (
    <main className="ss-shell">
      <SideRail />
      <section className="ss-shell-main">
        <TopRunBar title={props.title} runId={props.runId} status={props.status} />
        <div className="ss-shell-content">{props.children}</div>
        <StatusFooter />
      </section>
    </main>
  );
}
