export function LibraryAlternativesSheet(props: { model: any | null; onClose: () => void }) {
  if (!props.model) return null;
  return (
    <aside className="ss-library-sheet" role="dialog" aria-modal>
      <header><h2>Library alternatives</h2><button type="button" onClick={props.onClose}>Close</button></header>
      <section><h3>Matched templates</h3><ul>{props.model.matchedTemplates?.map((item: any) => <li key={item.ref}>{item.ref} · {item.reason}</li>)}</ul></section>
      <section><h3>Alternative profiles</h3><ul>{props.model.agentProfiles?.map((item: any) => <li key={item.ref}>{item.ref} · {item.reason}</li>)}</ul></section>
      <section><h3>Skill requirements</h3><ul>{props.model.skills?.map((item: any) => <li key={item.ref}>{item.ref}</li>)}</ul></section>
      <section><h3>MCP / tool grants</h3><ul>{props.model.mcpGrants?.map((item: any) => <li key={item.ref}>{item.ref}</li>)}</ul></section>
      <section><h3>Rejected alternatives</h3><ul>{props.model.rejectedAlternatives?.map((item: any) => <li key={item.ref}>{item.ref} · {item.reason}</li>)}</ul></section>
    </aside>
  );
}
