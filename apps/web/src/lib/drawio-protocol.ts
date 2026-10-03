/**
 * The diagrams.net embed protocol, as much of it as a diagram block uses.
 *
 * The editor runs in an `<iframe>` on `embed.diagrams.net` and talks by
 * `postMessage` with JSON strings. This module names the few messages that
 * matter and checks their origin, so the component that hosts the frame is
 * left with a switch rather than a parser.
 */

export const DRAWIO_ORIGIN = "https://embed.diagrams.net";

/** The frame's URL: JSON protocol, minimal chrome, and the app's theme. */
export function drawioEmbedUrl(dark: boolean): string {
  const query = new URLSearchParams({
    embed: "1",
    proto: "json",
    spin: "1",
    ui: dark ? "dark" : "kennedy",
    libraries: "1",
    saveAndExit: "1",
    noSaveBtn: "0",
    noExitBtn: "0",
  });
  return `${DRAWIO_ORIGIN}/?${query}`;
}

export type DrawioEvent =
  /** The editor is ready for a `load`. */
  | { event: "init" }
  /** The person pressed save; the host answers with an export. */
  | { event: "save"; xml: string; exit: boolean }
  /**
   * The export the host asked for. `data` is a data URL. `format` names the
   * picture ("svg" even when "xmlsvg" was asked for), so the host reads the
   * data URL's own type rather than this.
   */
  | { event: "export"; format: string; data: string; xml: string }
  /** The person left without saving. */
  | { event: "exit" }
  /** Sent as the diagram changes, when loaded with `autosave`. */
  | { event: "autosave"; xml: string };

/**
 * One message from the frame, or null for anything that is not one.
 *
 * Null for a wrong origin above all: any page can `postMessage` anything at
 * a window, and only the diagram editor gets to say a diagram was saved.
 */
export function parseDrawioMessage(data: unknown, origin: string): DrawioEvent | null {
  if (origin !== DRAWIO_ORIGIN || typeof data !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const message = parsed as Record<string, unknown>;
  switch (message.event) {
    case "init":
    case "exit":
      return { event: message.event };
    case "save":
      return typeof message.xml === "string"
        ? { event: "save", xml: message.xml, exit: message.exit === true }
        : null;
    case "autosave":
      return typeof message.xml === "string" ? { event: "autosave", xml: message.xml } : null;
    case "export":
      return typeof message.data === "string" && typeof message.format === "string"
        ? {
            event: "export",
            format: message.format,
            data: message.data,
            xml: typeof message.xml === "string" ? message.xml : "",
          }
        : null;
    default:
      return null;
  }
}

/** Puts a diagram into the editor. Empty xml opens a blank one. */
export function drawioLoadMessage(xml: string): string {
  return JSON.stringify({ action: "load", xml, autosave: 1 });
}

/**
 * Asks for the diagram as an SVG with the source embedded, which is what the
 * block stores: the picture to show, and the xml to edit again.
 */
export function drawioExportMessage(xml: string): string {
  return JSON.stringify({ action: "export", format: "xmlsvg", xml, spin: "Saving" });
}
