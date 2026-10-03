import { DatabaseLanding } from "@/components/database/database-landing";

/**
 * The Database section's front door: nothing is open yet, so it points at
 * the Connections column, where every saved server unfolds into the
 * databases you can open.
 */
export default function DatabasePage() {
  return <DatabaseLanding />;
}
