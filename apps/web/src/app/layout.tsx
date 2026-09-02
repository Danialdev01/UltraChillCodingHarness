import type { Metadata } from "next";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

export const metadata: Metadata = {
  title: "UCCH",
  description: "Ultra Chill Coding Harness",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        {/* Optional in this Base UI version -- Tooltip works without it --
            but it centralises the open/close delays so every tooltip in the
            app behaves the same. */}
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
