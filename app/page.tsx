import { Suspense } from "react";
import { SouthstarPiWebShell, SouthstarProductShell } from "@/components/southstar/app/SouthstarPiWebShell";

export default function Home() {
  return (
    <Suspense>
      <SouthstarProductShell initialView="workflow" />
    </Suspense>
  );
}
