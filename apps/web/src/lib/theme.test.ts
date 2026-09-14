import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseThemeCookie,
  serialiseThemeCookie,
  themeToStyle,
  applyTheme,
  contrast,
  DEFAULT_THEME,
  deriveTheme,
  hslToHex,
  isTheme,
  isValidHex,
  luminance,
  mix,
  normalizeHex,
  randomTheme,
  readableOn,
  readStoredTheme,
  storeTheme,
  THEME_STORAGE_KEY,
  themeToCss,
  type Theme,
} from "./theme.js";

const LIGHT: Theme = { dominant: "#ffffff", secondary: "#eceef2", accent: "#3b5bdb" };
const DARK: Theme = { dominant: "#111214", secondary: "#2a2d33", accent: "#7aa2f7" };

function store(impl?: Partial<Storage>) {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    ...impl,
  });
  return data;
}

/** The smallest stand-in for <html> that `applyTheme` actually touches. */
function root() {
  const props = new Map<string, string>();
  const classes = new Set<string>();
  return {
    props,
    classes,
    element: {
      style: {
        setProperty: (k: string, v: string) => void props.set(k, v),
        removeProperty: (k: string) => void props.delete(k),
      },
      classList: {
        add: (c: string) => void classes.add(c),
        remove: (c: string) => void classes.delete(c),
        toggle: (c: string, on: boolean) => void (on ? classes.add(c) : classes.delete(c)),
      },
    } as unknown as HTMLElement,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("reading a colour", () => {
  it("takes three- and six-digit hex, with or without the hash", () => {
    expect(normalizeHex("#3b5bdb", "#000000")).toBe("#3b5bdb");
    expect(normalizeHex("3B5BDB", "#000000")).toBe("#3b5bdb");
    expect(normalizeHex("#f0a", "#000000")).toBe("#ff00aa");
  });

  it("falls back rather than throwing on a half-typed value", () => {
    expect(isValidHex("#3b5")).toBe(true);
    expect(isValidHex("#3b5b")).toBe(false);
    expect(isValidHex("rebeccapurple")).toBe(false);
    expect(normalizeHex("#3b5b", "#123456")).toBe("#123456");
  });
});

describe("measuring a colour", () => {
  it("puts white at the top of the luminance range and black at the bottom", () => {
    expect(luminance("#ffffff")).toBeCloseTo(1, 5);
    expect(luminance("#000000")).toBeCloseTo(0, 5);
  });

  it("gives black on white the maximum WCAG ratio", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 2);
    expect(contrast("#777777", "#777777")).toBeCloseTo(1, 5);
  });

  it("blends between two colours in proportion", () => {
    expect(mix("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mix("#000000", "#ffffff", 1)).toBe("#ffffff");
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
  });
});

describe("the ink a surface gets", () => {
  it("goes white on dark grounds and near-black on light ones", () => {
    expect(readableOn("#ffffff")).toMatch(/0b0b0c/);
    expect(readableOn("#111214")).toMatch(/fafafa/);
    // Mid-greys are the interesting case: the flip follows measured contrast
    // against the two inks, so it lands just under #777777 rather than at
    // whatever a lightness channel would call halfway.
    expect(readableOn("#8a8a8a")).toMatch(/0b0b0c/);
    expect(readableOn("#666666")).toMatch(/fafafa/);
  });
});

describe("deriving the palette from three colours", () => {
  it("maps each role onto the variables that carry that share", () => {
    const { vars } = deriveTheme(LIGHT);
    expect(vars.background).toBe(LIGHT.dominant);
    expect(vars.secondary).toBe(LIGHT.secondary);
    // The accent is nudged for contrast, so it is a family match rather than
    // an identity: what matters is that it is not the ground or the support.
    expect(vars.primary).not.toBe(vars.background);
    expect(vars["ucch-active"]).not.toBe(vars.secondary);
  });

  it("fills in every variable globals.css consumes", () => {
    const { vars } = deriveTheme(DARK);
    for (const name of [
      "background",
      "foreground",
      "card",
      "card-foreground",
      "popover",
      "popover-foreground",
      "primary",
      "primary-foreground",
      "secondary",
      "secondary-foreground",
      "muted",
      "muted-foreground",
      "accent",
      "accent-foreground",
      "destructive",
      "border",
      "input",
      "ring",
      "chart-1",
      "chart-5",
      "sidebar",
      "sidebar-foreground",
      "sidebar-primary",
      "sidebar-primary-foreground",
      "sidebar-accent",
      "sidebar-accent-foreground",
      "sidebar-border",
      "sidebar-ring",
      "ucch-active",
      "ucch-active-bg",
    ]) {
      expect(vars[name], name).toBeTruthy();
    }
  });

  it("flips text and icons with the dominant colour, and says so", () => {
    const light = deriveTheme(LIGHT);
    const dark = deriveTheme(DARK);

    expect(light.dark).toBe(false);
    expect(light.vars.foreground).toMatch(/0b0b0c/);
    expect(dark.dark).toBe(true);
    expect(dark.vars.foreground).toMatch(/fafafa/);
  });

  it("keeps foregrounds readable on the surface they actually sit on", () => {
    for (const theme of [LIGHT, DARK, DEFAULT_THEME]) {
      const { vars } = deriveTheme(theme);
      const pairs: [string, string][] = [
        ["foreground", "background"],
        ["card-foreground", "card"],
        ["primary-foreground", "primary"],
        ["secondary-foreground", "secondary"],
        ["accent-foreground", "accent"],
        ["sidebar-foreground", "sidebar"],
        ["sidebar-accent-foreground", "sidebar-accent"],
      ];
      for (const [ink, surface] of pairs) {
        expect(contrast(vars[ink]!, vars[surface]!), `${ink} on ${surface}`).toBeGreaterThan(
          4.5,
        );
      }
      // Muted text is deliberately quieter, but still has to be text.
      expect(contrast(vars["muted-foreground"]!, vars.muted!)).toBeGreaterThan(3);
    }
  });

  it("rescues an accent the user picked too close to their background", () => {
    const invisible: Theme = { dominant: "#ffffff", secondary: "#f4f4f5", accent: "#fbfbfc" };
    const { vars } = deriveTheme(invisible);
    expect(contrast(vars["ucch-active"]!, vars.background!)).toBeGreaterThan(4);
    expect(contrast(vars["ucch-active"]!, vars.sidebar!)).toBeGreaterThan(4);
  });

  it("falls back to the default for a colour it cannot read", () => {
    const { vars } = deriveTheme({ dominant: "nonsense", secondary: "", accent: "#3b5bdb" });
    expect(vars.background).toBe(DEFAULT_THEME.dominant);
    expect(vars.secondary).toBe(DEFAULT_THEME.secondary);
  });
});

describe("randomizing", () => {
  it("builds a light palette when asked, and a dark one when asked", () => {
    expect(deriveTheme(randomTheme(Math.random, "light")).dark).toBe(false);
    expect(deriveTheme(randomTheme(Math.random, "dark")).dark).toBe(true);
  });

  it("produces a legible palette on every roll, not most of them", () => {
    // Sweeps the rng across its whole range rather than trusting a handful of
    // random draws: the constraint being tested is the lightness bands, and a
    // flaky palette generator is one that only fails at the edges.
    for (let i = 0; i <= 40; i++) {
      const at = i / 40;
      const theme = randomTheme(() => Math.min(at, 0.999));
      const { vars } = deriveTheme(theme);
      expect(contrast(vars.foreground!, vars.background!), `roll ${at}`).toBeGreaterThan(10);
      expect(contrast(vars["ucch-active"]!, vars.background!), `roll ${at}`).toBeGreaterThan(4);
    }
  });

  it("draws all three colours from one hue family, not three unrelated ones", () => {
    const theme = randomTheme(() => 0.3);
    expect(isTheme(theme)).toBe(true);
    // Ground and support are near-neutral tints; only the accent is loud.
    const spread = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      return Math.max(r!, g!, b!) - Math.min(r!, g!, b!);
    };
    expect(spread(theme.dominant)).toBeLessThan(spread(theme.accent));
    expect(spread(theme.secondary)).toBeLessThan(spread(theme.accent));
  });

  it("converts hue, saturation and lightness to the expected corners", () => {
    expect(hslToHex(0, 100, 50)).toBe("#ff0000");
    expect(hslToHex(120, 100, 50)).toBe("#00ff00");
    expect(hslToHex(240, 100, 50)).toBe("#0000ff");
    expect(hslToHex(0, 0, 100)).toBe("#ffffff");
    // Hue wraps rather than clamping, so `hue + 220` never needs guarding.
    expect(hslToHex(480, 100, 50)).toBe(hslToHex(120, 100, 50));
  });
});

describe("remembering a theme", () => {
  it("comes back as it was saved", () => {
    store();
    storeTheme(DARK);
    expect(readStoredTheme()).toEqual(DARK);
  });

  it("caches the derived css beside it for the pre-paint script", () => {
    const data = store();
    storeTheme(DARK);
    const saved = JSON.parse(data.get(THEME_STORAGE_KEY)!);
    expect(saved.dark).toBe(true);
    expect(saved.css).toContain("--background:#111214");
    expect(saved.css).toBe(themeToCss(deriveTheme(DARK).vars));
  });

  it("forgets it when cleared", () => {
    store();
    storeTheme(DARK);
    storeTheme(null);
    expect(readStoredTheme()).toBeNull();
  });

  it("ignores stored junk rather than painting it", () => {
    const data = store();
    data.set(THEME_STORAGE_KEY, "{ not json");
    expect(readStoredTheme()).toBeNull();
    data.set(THEME_STORAGE_KEY, JSON.stringify({ theme: { dominant: "purple" } }));
    expect(readStoredTheme()).toBeNull();
  });

  it("survives a browser that refuses storage outright", () => {
    store({
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(() => storeTheme(DARK)).not.toThrow();
    expect(readStoredTheme()).toBeNull();
  });
});

describe("painting a theme onto the document", () => {
  it("writes every variable and marks the document dark", () => {
    const { props, classes, element } = root();
    applyTheme(DARK, element);

    expect(props.get("--background")).toBe("#111214");
    expect(props.get("--foreground")).toMatch(/fafafa/);
    expect(classes.has("dark")).toBe(true);
  });

  it("drops the dark class for a light palette", () => {
    const { classes, element } = root();
    applyTheme(DARK, element);
    applyTheme(LIGHT, element);
    expect(classes.has("dark")).toBe(false);
  });

  it("strips back to the stylesheet's own colours on reset", () => {
    const { props, classes, element } = root();
    applyTheme(DARK, element);
    applyTheme(null, element);

    expect(props.size).toBe(0);
    expect(classes.has("dark")).toBe(false);
  });
});

describe("the theme cookie", () => {
  const THEME = { dominant: "#101014", secondary: "#26262e", accent: "#7c9cf0" };

  it("round-trips a palette", () => {
    expect(parseThemeCookie(serialiseThemeCookie(THEME))).toEqual(THEME);
  });

  it("survives being URL-encoded, which is what a cookie does to it", () => {
    // `#` has to be escaped: unencoded it is legal in a cookie value on some
    // servers and not others, and a half-read palette is worse than none.
    const raw = serialiseThemeCookie(THEME);
    expect(raw).not.toContain("#");
    expect(parseThemeCookie(raw)).toEqual(THEME);
  });

  it("stays small enough to send on every request", () => {
    expect(serialiseThemeCookie(THEME).length).toBeLessThan(200);
  });

  it("refuses anything that is not three hex colours", () => {
    // A cookie is user-controlled input, and this is what stands between it
    // and `deriveTheme`.
    for (const raw of [
      undefined,
      "",
      "not json",
      encodeURIComponent("{"),
      encodeURIComponent(JSON.stringify({ dominant: "#fff" })),
      encodeURIComponent(JSON.stringify({ dominant: "red", secondary: "#fff", accent: "#000" })),
      encodeURIComponent(JSON.stringify([1, 2, 3])),
      encodeURIComponent(JSON.stringify(null)),
    ]) {
      expect(parseThemeCookie(raw)).toBeNull();
    }
  });
});

describe("themeToStyle", () => {
  it("names every variable the way CSS expects it", () => {
    const style = themeToStyle(DEFAULT_THEME);
    expect(Object.keys(style).every((name) => name.startsWith("--"))).toBe(true);
    expect(style["--background"]).toBe(DEFAULT_THEME.dominant);
  });

  it("covers the same variables the live paint sets", () => {
    // The server renders these and `applyTheme` sets them on an edit; a
    // variable in one and not the other is a colour that changes on save.
    const style = themeToStyle(DEFAULT_THEME);
    const derived = deriveTheme(DEFAULT_THEME).vars;
    expect(Object.keys(style).sort()).toEqual(Object.keys(derived).map((n) => `--${n}`).sort());
  });
});
