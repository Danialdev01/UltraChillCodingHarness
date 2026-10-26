import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyTheme,
  coerceSettings,
  contrast,
  customReport,
  DEFAULT_SETTINGS,
  isTheme,
  isValidHex,
  luminance,
  normalizeHex,
  parseThemeCookie,
  readStoredTheme,
  resolveMode,
  resolveTokens,
  serialiseThemeCookie,
  storeTheme,
  THEME_SCRIPT,
  themeToStyle,
  themeVars,
  THEME_STORAGE_KEY,
  type Theme,
  type ThemeSettings,
} from "./theme.js";

const LEGACY_DARK: Theme = { dominant: "#111214", secondary: "#2a2d33", accent: "#7aa2f7" };
const SEEDED: ThemeSettings = { mode: "dark", source: { kind: "seed", seed: 42 }, highContrast: false, locked: true };

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
  const attrs = new Map<string, string>();
  return {
    props,
    classes,
    attrs,
    element: {
      setAttribute: (k: string, v: string) => void attrs.set(k, v),
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
    expect(isValidHex("#fff")).toBe(true);
    expect(isValidHex("3b5bdb")).toBe(true);
    expect(normalizeHex("#ABC", "#000000")).toBe("#aabbcc");
  });

  it("falls back rather than throwing on a half-typed value", () => {
    expect(isValidHex("#3b5")).toBe(true);
    expect(isValidHex("#3b5b")).toBe(false);
    expect(normalizeHex("#3b5b", "#123456")).toBe("#123456");
  });

  it("measures black on white at the maximum WCAG ratio", () => {
    expect(luminance("#ffffff")).toBeCloseTo(1);
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21);
  });
});

describe("the mode", () => {
  it("resolves System against the OS and leaves a forced mode alone", () => {
    expect(resolveMode("system", true)).toBe("dark");
    expect(resolveMode("system", false)).toBe("light");
    expect(resolveMode("light", true)).toBe("light");
    expect(resolveMode("dark", false)).toBe("dark");
  });
});

describe("tokens from a choice", () => {
  it("gives a seed the same palette every time", () => {
    expect(resolveTokens(SEEDED, "light").tokens).toEqual(resolveTokens({ ...SEEDED }, "light").tokens);
  });

  it("writes every variable as a light/dark pair from the same seed", () => {
    const vars = themeVars(SEEDED);
    expect(vars.background).toMatch(/^light-dark\(#[0-9a-f]{6}, #[0-9a-f]{6}\)$/);
    expect(vars.background).toContain(resolveTokens(SEEDED, "light").tokens.background);
    expect(vars.background).toContain(resolveTokens(SEEDED, "dark").tokens.background);
  });

  it("paints custom colours exactly in their own mode, and generates the other", () => {
    const settings = coerceSettings(LEGACY_DARK)!;
    expect(resolveTokens(settings, "dark").tokens.background).toBe("#111214");
    expect(resolveTokens(settings, "light").tokens.background).not.toBe("#111214");
  });

  it("repairs a custom accent picked too close to its page, and says so", () => {
    const theme: Theme = { dominant: "#ffffff", secondary: "#f1f1f3", accent: "#f0f0ff" };
    const { rows, fellBack } = customReport(theme);
    const button = rows.find((r) => r.label === "Accent button on page")!;
    expect(fellBack).toBe(false);
    expect(button.picked).toBeLessThan(3);
    expect(button.shown).toBeGreaterThanOrEqual(3);
  });

  it("falls back to the default for a page no text can read on", () => {
    // Mid-grey: neither white nor black text reaches 7:1 on it.
    const settings = coerceSettings({ mode: "light", source: { kind: "custom", dominant: "#777777", secondary: "#777777", accent: "#777777" }, highContrast: true, locked: false })!;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const built = resolveTokens(settings, "light");
    expect(built.fellBack).toBe(true);
    expect(built.tokens).toEqual(resolveTokens({ ...DEFAULT_SETTINGS, highContrast: true }, "light").tokens);
    warn.mockRestore();
  });
});

describe("carrying old themes over", () => {
  it("reads three bare hex colours as custom colours in their own mode", () => {
    expect(coerceSettings(LEGACY_DARK)).toEqual({
      mode: "dark",
      source: { kind: "custom", ...LEGACY_DARK },
      highContrast: false,
      locked: false,
    });
  });

  it("reads the old storage payload", () => {
    const data = store();
    data.set(THEME_STORAGE_KEY, JSON.stringify({ theme: LEGACY_DARK, css: "--x:1", dark: true }));
    expect(readStoredTheme()?.source).toEqual({ kind: "custom", ...LEGACY_DARK });
  });

  it("keeps isTheme for the three-colour shape", () => {
    expect(isTheme(LEGACY_DARK)).toBe(true);
    expect(isTheme({ dominant: "#fff" })).toBe(false);
  });
});

describe("remembering a theme", () => {
  it("comes back as it was saved", () => {
    store();
    storeTheme(SEEDED);
    expect(readStoredTheme()).toEqual(SEEDED);
  });

  it("stores the seed, not the colours", () => {
    const data = store();
    storeTheme(SEEDED);
    expect(data.get(THEME_STORAGE_KEY)).not.toMatch(/#[0-9a-f]{6}/);
  });

  it("forgets it when cleared or reset to the default", () => {
    store();
    storeTheme(SEEDED);
    storeTheme(null);
    expect(readStoredTheme()).toBeNull();
    storeTheme(SEEDED);
    storeTheme(DEFAULT_SETTINGS);
    expect(readStoredTheme()).toBeNull();
  });

  it("ignores stored junk rather than painting it", () => {
    const data = store();
    data.set(THEME_STORAGE_KEY, "{ not json");
    expect(readStoredTheme()).toBeNull();
    data.set(THEME_STORAGE_KEY, JSON.stringify({ mode: "purple", source: { kind: "default" } }));
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
    expect(() => storeTheme(SEEDED)).not.toThrow();
    expect(readStoredTheme()).toBeNull();
  });
});

describe("painting a theme onto the document", () => {
  it("writes every variable, the mode, and the dark class for a forced Dark", () => {
    const { props, classes, attrs, element } = root();
    applyTheme(SEEDED, element);
    expect(props.get("--background")).toMatch(/^light-dark\(/);
    expect(attrs.get("data-theme-mode")).toBe("dark");
    expect(classes.has("dark")).toBe(true);
  });

  it("leaves the dark class off on System, where a media query handles it", () => {
    const { classes, attrs, element } = root();
    applyTheme(SEEDED, element);
    applyTheme({ ...SEEDED, mode: "system" }, element);
    expect(classes.has("dark")).toBe(false);
    expect(attrs.get("data-theme-mode")).toBe("system");
  });

  it("strips back to the stylesheet's own colours on reset", () => {
    const { props, classes, element } = root();
    applyTheme(SEEDED, element);
    applyTheme(null, element);
    expect(props.size).toBe(0);
    expect(classes.has("dark")).toBe(false);
  });
});

describe("the theme cookie", () => {
  it("round-trips a choice", () => {
    expect(parseThemeCookie(serialiseThemeCookie(SEEDED))).toEqual(SEEDED);
  });

  it("survives being URL-encoded, which is what a cookie does to it", () => {
    const custom = coerceSettings(LEGACY_DARK)!;
    const raw = serialiseThemeCookie(custom);
    expect(raw).not.toContain("#");
    expect(parseThemeCookie(raw)).toEqual(custom);
  });

  it("stays small enough to send on every request", () => {
    expect(serialiseThemeCookie(coerceSettings(LEGACY_DARK)!).length).toBeLessThan(300);
  });

  it("reads an old three-colour cookie", () => {
    expect(parseThemeCookie(encodeURIComponent(JSON.stringify(LEGACY_DARK)))?.mode).toBe("dark");
  });

  it("refuses anything that is not a theme", () => {
    for (const raw of [
      undefined,
      "",
      "not json",
      encodeURIComponent("{"),
      encodeURIComponent(JSON.stringify({ dominant: "#fff" })),
      encodeURIComponent(JSON.stringify({ mode: "dark", source: { kind: "seed", seed: "x" } })),
      encodeURIComponent(JSON.stringify({ mode: "dark", source: { kind: "custom", dominant: "red", secondary: "#fff", accent: "#000" } })),
      encodeURIComponent(JSON.stringify([1, 2, 3])),
      encodeURIComponent(JSON.stringify(null)),
    ]) {
      expect(parseThemeCookie(raw)).toBeNull();
    }
  });
});

describe("themeToStyle", () => {
  it("names every variable the way CSS expects it, matching the live paint", () => {
    const style = themeToStyle(SEEDED);
    const { props, element } = root();
    applyTheme(SEEDED, element);
    expect(Object.keys(style).every((name) => name.startsWith("--"))).toBe(true);
    expect(Object.fromEntries(props)).toEqual(style);
  });
});

describe("the pre-paint script", () => {
  /** Runs `THEME_SCRIPT` the way the parser would, against stand-ins. */
  function run(cookie = "") {
    const html = root();
    vi.stubGlobal("document", { documentElement: html.element, cookie });
    new Function(THEME_SCRIPT)();
    return html;
  }

  afterEach(() => vi.unstubAllGlobals());

  it("paints exactly what applyTheme would, from the saved choice", () => {
    store();
    storeTheme(SEEDED);
    const painted = run();
    const applied = root();
    applyTheme(SEEDED, applied.element);
    expect(painted.attrs.get("data-theme-mode")).toBe("dark");
    expect(painted.classes.has("dark")).toBe(true);
    expect(Object.fromEntries(painted.props)).toEqual(Object.fromEntries(applied.props));
  });

  it("takes the mode from the cookie when storage is empty", () => {
    store();
    const painted = run(`other=1; ucch_theme=${serialiseThemeCookie(SEEDED)}`);
    expect(painted.attrs.get("data-theme-mode")).toBe("dark");
    expect(painted.props.size).toBe(0);
  });

  it("leaves the page alone with nothing saved, or anything broken", () => {
    store();
    expect(run().attrs.size).toBe(0);
    store().set("ucch:theme-paint", "{not json");
    expect(run("ucch_theme=%7B").attrs.size).toBe(0);
    store().set("ucch:theme-paint", JSON.stringify({ mode: "dark;x", vars: {} }));
    expect(run().attrs.size).toBe(0);
    store().set("ucch:theme-paint", JSON.stringify({ mode: "light", vars: { "a;b": "red", ok: 1 } }));
    expect(run().props.size).toBe(0);
  });

  it("forgets the paint when the choice goes back to the default", () => {
    const data = store();
    storeTheme(SEEDED);
    storeTheme(DEFAULT_SETTINGS);
    expect(data.size).toBe(0);
  });
});
