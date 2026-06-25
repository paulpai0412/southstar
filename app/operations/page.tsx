import { Suspense } from "react";
import { SouthstarProductShell } from "@/components/southstar/app/SouthstarPiWebShell";

export default function Page() {
  return (
    <Suspense>
      <SouthstarProductShell initialView="operator" />
    </Suspense>
  );
}
