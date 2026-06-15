const nav = [
  ["/planner", "Planner Chat"],
  ["/workflow", "Workflow Canvas"],
  ["/runtime", "Runtime Monitor"],
  ["/task", "Task Detail"],
  ["/sessions", "Sessions / Memory"],
  ["/worktree", "Worktree Console"],
  ["/executor", "Executor Ops"],
  ["/domain-packs", "Domain Packs"],
  ["/governance", "Vault / MCP"],
] as const;

export function SideRail() {
  return (
    <aside className="ss-shell-rail">
      <div className="ss-shell-brand">Southstar v2</div>
      <nav>{nav.map(([href, label]) => <a key={href} href={href}>{label}</a>)}</nav>
      <div className="ss-shell-status">Southstar DB<br /><strong>Connected</strong></div>
    </aside>
  );
}
