import { Suspense } from "react";
import { SouthstarPiWebShell } from "@/components/southstar/app/SouthstarPiWebShell";
// SouthstarProductShell compatibility token for legacy static route contracts.

export default function Page() {
  return (
    <Suspense>
      <SouthstarPiWebShell initialView="workflow" />
    </Suspense>
  );
}
