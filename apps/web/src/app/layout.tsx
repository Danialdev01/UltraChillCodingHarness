import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Inter, JetBrains_Mono, Source_Serif_4 } from "next/font/google";
import localFont from "next/font/local";
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
 * The harness's typefaces.
 *
 * The UI is set in Inter, long-form prose in a serif and inline code, paths
 * and terminal output in iA Writer Mono; the code editors alone keep JetBrains
 * Mono. `next/font` self-hosts all of them -- the files are fetched at build
 * time (or, for iA Writer Mono, ship in `src/fonts`) and served from this
 * origin, so no page waits on Google at runtime and nothing leaks a request
 * to them.
 *
 * Each is exposed as a variable rather than a class; the stacks that read
 * them are assembled in `globals.css`, where every `font-sans`, `font-serif`
 * and `font-mono` utility in the app resolves without touching a component.
 */
const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

// The free stand-in for Lyon Text, which is commercial: the stack in
// `globals.css` still prefers Lyon when it is installed locally.
const sourceSerif = Source_Serif_4({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-source-serif",
});

// Not on Google Fonts; the webfonts and their licence (OFL) live in the repo.
// Regular and bold only -- 500 and 600 snap to the nearer of the two.
const iaWriterMono = localFont({
  src: [
    { path: "../fonts/ia-writer-mono/iAWriterMonoS-Regular.woff2", weight: "400", style: "normal" },
    { path: "../fonts/ia-writer-mono/iAWriterMonoS-Italic.woff2", weight: "400", style: "italic" },
    { path: "../fonts/ia-writer-mono/iAWriterMonoS-Bold.woff2", weight: "700", style: "normal" },
    { path: "../fonts/ia-writer-mono/iAWriterMonoS-BoldItalic.woff2", weight: "700", style: "italic" },
  ],
  display: "swap",
  variable: "--font-ia-writer-mono",
});

/**
 * The code editors' face. Kept apart from the rest of the UI on purpose:
 * the editors are tuned around its metrics, and it is what the files were
 * being read in before the UI moved to Inter.
 */
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  // The whole weight range in one variable file.
  weight: ["100", "200", "300", "400", "500", "600", "700", "800"],
  display: "swap",
  variable: "--font-jetbrains-mono",
  // The rest of the stack is left to `next/font`, which appends a
  // metric-matched local fallback of its own so the page does not reflow when
  // the real face arrives.
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
      className={[
        inter.variable,
        sourceSerif.variable,
        iaWriterMono.variable,
        jetbrainsMono.variable,
        theme && deriveTheme(theme).dark ? "dark" : "",
      ]
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
