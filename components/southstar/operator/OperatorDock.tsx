export function OperatorDock(props: { count: number; onOpen: () => void }) {
  return <button type="button" className="ss-operator-dock" onClick={props.onOpen}>Operator · {props.count}</button>;
}
