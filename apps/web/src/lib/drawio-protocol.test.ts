import { describe, expect, it } from "vitest";
import {
  DRAWIO_ORIGIN,
  drawioEmbedUrl,
  drawioExportMessage,
  drawioLoadMessage,
  parseDrawioMessage,
} from "./drawio-protocol";

describe("parseDrawioMessage", () => {
  it("reads the events the block acts on", () => {
    expect(parseDrawioMessage('{"event":"init"}', DRAWIO_ORIGIN)).toEqual({ event: "init" });
    expect(parseDrawioMessage('{"event":"save","xml":"<x/>","exit":true}', DRAWIO_ORIGIN)).toEqual({
      event: "save",
      xml: "<x/>",
      exit: true,
    });
    expect(
      parseDrawioMessage('{"event":"export","format":"xmlsvg","data":"data:image/svg+xml;base64,AA"}', DRAWIO_ORIGIN),
    ).toEqual({ event: "export", format: "xmlsvg", data: "data:image/svg+xml;base64,AA", xml: "" });
    expect(parseDrawioMessage('{"event":"exit"}', DRAWIO_ORIGIN)).toEqual({ event: "exit" });
  });

  it("refuses the wrong origin, non-strings, bad JSON, and unknown events", () => {
    expect(parseDrawioMessage('{"event":"init"}', "https://evil.example")).toBeNull();
    expect(parseDrawioMessage({ event: "init" }, DRAWIO_ORIGIN)).toBeNull();
    expect(parseDrawioMessage("{nope", DRAWIO_ORIGIN)).toBeNull();
    expect(parseDrawioMessage('{"event":"configure"}', DRAWIO_ORIGIN)).toBeNull();
    expect(parseDrawioMessage('{"event":"save"}', DRAWIO_ORIGIN)).toBeNull();
  });
});

describe("outgoing messages", () => {
  it("load carries the xml and asks for autosave", () => {
    expect(JSON.parse(drawioLoadMessage("<x/>"))).toMatchObject({ action: "load", xml: "<x/>", autosave: 1 });
  });

  it("export asks for svg with the source embedded", () => {
    expect(JSON.parse(drawioExportMessage("<x/>"))).toMatchObject({ action: "export", format: "xmlsvg" });
  });

  it("the embed url uses the json protocol and follows the theme", () => {
    expect(drawioEmbedUrl(true)).toContain("proto=json");
    expect(drawioEmbedUrl(true)).toContain("ui=dark");
    expect(drawioEmbedUrl(false)).toContain("ui=kennedy");
    expect(drawioEmbedUrl(false).startsWith(DRAWIO_ORIGIN)).toBe(true);
  });
});
