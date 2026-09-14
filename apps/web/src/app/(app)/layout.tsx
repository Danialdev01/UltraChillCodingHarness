import { AppShell } from "@/components/app-shell";

/**
 * Every signed-in page shares the shell, and shares it as a *layout* so that
 * a page switch keeps it: the sidebar, header and their data stay mounted
 * while only the page inside changes. See `AppShell` for what follows from
 * that.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
