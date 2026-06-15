import { redirect } from "next/navigation";
import { SouthstarOperationsApp } from "@/components/southstar/AppShell";

void SouthstarOperationsApp;

export default function Home() {
  redirect("/planner");
}
