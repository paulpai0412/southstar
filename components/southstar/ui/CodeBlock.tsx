export function CodeBlock(props: { value: unknown }) {
  return <pre className="ss-code-block">{typeof props.value === "string" ? props.value : JSON.stringify(props.value, null, 2)}</pre>;
}
