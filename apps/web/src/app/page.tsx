import { redirect } from "next/navigation";

/**
 * The app lives at /dashboard. This exists so the root URL, and anything
 * still pointing at it, lands somewhere real.
 */
export default function Index() {
  redirect("/dashboard");
}
