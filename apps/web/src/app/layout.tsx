import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono, Source_Serif_4 } from "next/font/google";
import localFont from "next/font/local";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { VitalsReporter } from "@/components/vitals-reporter";
import { ViewTransitionsProvider } from "@/lib/view-transitions";
import { DEFAULT_SETTINGS, THEME_SCRIPT } from "@/lib/theme";
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
  // Inline code and paths only -- nothing on the sign-in page or the first
  // paint of most pages -- so its four faces (~156 KB) are not preloaded on
  // every page; they arrive when text first uses them.
  preload: false,
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
  // Only the code editors use it, and they load after the page does; a
  // preload on every page would fetch it for visits that never open one.
  preload: false,
  // The rest of the stack is left to `next/font`, which appends a
  // metric-matched local fallback of its own so the page does not reflow when
  // the real face arrives.
});

export const metadata: Metadata = {
  title: "UCCH",
  description: "Ultra Chill Coding Harness",
};

/**
 * The browser's own chrome -- the tab strip on Android, an installed app's
 * title bar -- in the page's `--background`, light or dark with the OS.
 */
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafcff" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0d13" },
  ],
};

/**
 * The chrome every page renders into, and the palette it renders in.
 *
 * Nothing here reads the request: no cookies, no headers. That is what lets
 * a page with nothing per-user in it -- /login, /offline -- be built once as
 * static HTML instead of rendered for every visit. The theme reaches the
 * first paint anyway, from `THEME_SCRIPT`: an inline script ahead of the
 * content, which the parser runs before it reaches any content, painting the
 * saved mode and variables onto <html> (`light-dark()` pairs, with
 * `data-theme-mode` choosing the side through `color-scheme` in the
 * stylesheet). System needs nothing at all: the browser resolves
 * `light-dark()` against the OS itself. <html> is rendered with
 * `suppressHydrationWarning` because the script has changed its attributes
 * by the time React looks.
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
 * disagree with one child. Keep it that way -- the theme script sits inside
 * the provider, rendered by the same server tree on both sides, never as a
 * sibling of it.
 *
 * And <head> stays unauthored, which was the other version of the same bug: the
 * App Router owns that element -- metadata, preloads, and the style tags Fast
 * Refresh injects all land there -- so writing one puts a host element at the
 * very root whose children React and Next manage between them.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={[inter.variable, sourceSerif.variable, iaWriterMono.variable, jetbrainsMono.variable].join(" ")}
      data-theme-mode={DEFAULT_SETTINGS.mode}
      suppressHydrationWarning
    >
      <body>
        {/* TooltipProvider is optional in this Base UI version -- Tooltip
            works without it -- but it centralises the open/close delays so
            every tooltip in the app behaves the same. */}
        <ThemeProvider>
          {/* Before any content, so the parser has painted the theme by the
              time there is anything to show in it. */}
          <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
          <TooltipProvider>
            {/* Every in-app navigation runs as a view transition; see
                lib/view-transitions.tsx. Above the (app) group so the login
                page's redirect into the app gets one too. */}
            <ViewTransitionsProvider>{children}</ViewTransitionsProvider>
          </TooltipProvider>
        </ThemeProvider>
        {/* Real-user timings for /metrics; see lib/vitals.ts. */}
        <VitalsReporter />
      </body>
    </html>
  );
}
