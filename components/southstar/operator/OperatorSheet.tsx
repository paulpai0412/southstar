import { AttentionQueue } from "./AttentionQueue";

export function OperatorSheet(props: { model: any; onClose: () => void }) {
  return (
    <aside className="ss-operator-sheet">
      <header><h2>Attention Queue</h2><button type="button" onClick={props.onClose}>Close</button></header>
      <AttentionQueue items={props.model?.items ?? props.model?.attentionItems ?? []} selectedItemId={null} onSelectItem={() => undefined} />
    </aside>
  );
}
