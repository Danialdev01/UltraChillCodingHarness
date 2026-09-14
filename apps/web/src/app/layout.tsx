import type { Metadata } from "next";
import { cookies } from "next/headers";
import { JetBrains_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ViewTransitionsProvider } from "@/lib/view-transitions";
import {
  deriveTheme,
  parseThemeCookie,
  THEME_COOKIE,
  themeToStyle,
} from "@/lib/theme";
import "./globals.css";

/**
 * One typeface for the whole harness.
 *
 * A monospace everywhere is a deliberate choice rather than a code-only one:
 * this is a tool for reading diffs, paths and tool output, and a proportional
 * UI around monospace content makes the two read as different documents.
 * `next/font` self-hosts it -- the files are fetched at build time and served
 * from this origin, so no page waits on Google at runtime and nothing leaks a
 * request to them.
 *
 * Exposed as a variable rather than a class so `--font-sans` and `--font-mono`
 * can both point at it in `globals.css`; every `font-sans` and `font-mono`
 * utility in the app then resolves here without touching a component.
 */
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  // The whole weight range in one variable file: the UI leans on 400 and 500,
  // and headings on 600.
  weight: ["100", "200", "300", "400", "500", "600", "700", "800"],
  display: "swap",
  variable: "--font-jetbrains-mono",
  // The rest of the stack is left to `next/font`, which appends a
  // metric-matched local fallback of its own so the page does not reflow when
  // the real face arrives. Repeating the generic families here only
  // duplicated them in the computed value.
});

export const metadata: Metadata = {
  title: "UCCH",
  description: "Ultra Chill Coding Harness",
};

/**
 * The chrome every page renders into, and the palette it renders in.
 *
 * The theme is read from a cookie here and painted straight onto <html> as
 * inline custom properties. Three things follow from doing it server-side that
 * did not hold when a blocking script did it in the browser:
 *
 * The first paint is already correct -- there is no moment, however short, when
 * a dark theme shows the stylesheet's white, and it holds with JavaScript
 * disabled or still downloading.
 *
 * `<body>` has exactly one child. That reads like a detail and is not: `useId`
 * is derived from the tree path, which encodes how many children each ancestor
 * has, so anything that makes the server and the client disagree about the
 * number of children *here* shifts every id on the page at once. React reports
 * that as a whole-page hydration mismatch -- ids in the sidebar, in the
 * composer, everywhere -- with nothing in the message pointing back at this
 * file. A `<script>` element as body's first child was exactly such a thing:
 * React may treat scripts as hoistable, and in development a client still
 * holding an older copy of this module is enough on its own. One child cannot
 * disagree with one child. Keep it that way.
 *
 * And <head> stays unauthored, which was the other version of the same bug: the
 * App Router owns that element -- metadata, preloads, and the style tags Fast
 * Refresh injects all land there -- so writing one puts a host element at the
 * very root whose children React and Next manage between them.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const jar = await cookies();
  // User-controlled input: `parseThemeCookie` returns null for anything that is
  // not three valid hex colours, and the shipped palette stands.
  const theme = parseThemeCookie(jar.get(THEME_COOKIE)?.value);

  return (
    <html
      lang="en"
      // `dark` travels with the variables so Tailwind's `dark:` variants agree
      // with the ink the palette resolved to.
      className={[jetbrainsMono.variable, theme && deriveTheme(theme).dark ? "dark" : ""]
        .filter(Boolean)
        .join(" ")}
      style={theme ? themeToStyle(theme) : undefined}
      suppressHydrationWarning
    >
      <body>
        {/* TooltipProvider is optional in this Base UI version -- Tooltip
            works without it -- but it centralises the open/close delays so
            every tooltip in the app behaves the same. */}
        <ThemeProvider initial={theme}>
          <TooltipProvider>
            {/* Every in-app navigation runs as a view transition; see
                lib/view-transitions.tsx. Above the (app) group so the login
                page's redirect into the app gets one too. */}
            <ViewTransitionsProvider>{children}</ViewTransitionsProvider>
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
