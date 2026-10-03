import { redirect } from "next/navigation";

import { settingsPageHref } from "@/lib/sections";

/**
 * `/setting` is the rail's link and has no content of its own: every page of
 * Settings is a sidebar item at `/setting/{page}`, and Account is the first.
 */
export default function SettingPage() {
  redirect(settingsPageHref("account"));
}
