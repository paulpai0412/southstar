export function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "default" | "danger" }) {
  const { className, tone = "default", ...rest } = props;
  return <button {...rest} className={`ss-button ss-button-${tone} ${className ?? ""}`} />;
}
