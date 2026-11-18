import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { chartText, estimateTokens, extractDocument, htmlToText, readZip, rtfToText } from "./extract.js";

/** A minimal ZIP writer: deflated entries, enough for the readers under test. */
function zip(files: Record<string, string | Buffer>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const data = deflateRawSync(raw);
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

describe("readZip", () => {
  it("reads deflated entries by name", () => {
    const entries = readZip(zip({ "a.txt": "hello", "dir/b.xml": "<x/>" }));
    expect(entries.names().sort()).toEqual(["a.txt", "dir/b.xml"]);
    expect(entries.text("a.txt")).toBe("hello");
    expect(entries.text("missing")).toBeNull();
  });

  it("refuses something that is not a ZIP", () => {
    expect(() => readZip(Buffer.from("plain text, not an archive"))).toThrow(/ZIP/);
  });
});

describe("extractDocument", () => {
  it("reads a Word document's headings, lists, tables and footnotes", async () => {
    const document = `<w:document ${W}><w:body>
      <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Quarterly plan</w:t></w:r></w:p>
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Goals</w:t></w:r></w:p>
      <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>Ship &amp; measure</w:t></w:r></w:p>
      <w:p><w:r><w:t xml:space="preserve">Split </w:t></w:r><w:r><w:t>runs</w:t></w:r><w:r><w:tab/><w:t>tabbed</w:t></w:r></w:p>
      <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Name</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Owner</w:t></w:r></w:p></w:tc></w:tr>
        <w:tr><w:tc><w:p><w:r><w:t>API | v2</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Ana</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    </w:body></w:document>`;
    const footnotes = `<w:footnotes ${W}><w:footnote><w:p><w:r><w:t>See appendix.</w:t></w:r></w:p></w:footnote></w:footnotes>`;
    const result = await extractDocument("plan.docx", "", zip({ "word/document.xml": document, "word/footnotes.xml": footnotes }));
    expect(result?.kind).toBe("document");
    expect(result?.text).toContain("# Quarterly plan");
    expect(result?.text).toContain("## Goals");
    expect(result?.text).toContain("- Ship & measure");
    expect(result?.text).toContain("Split runs\ttabbed");
    expect(result?.text).toContain("| Name | Owner |");
    expect(result?.text).toContain("| API \\| v2 | Ana |");
    expect(result?.text).toContain("## Footnotes\n\nSee appendix.");
    expect(result?.summary).toMatch(/^Word document, \d+ words$/);
  });

  it("reads a workbook's sheets with shared strings, dates and booleans", async () => {
    const files = {
      "xl/workbook.xml": `<workbook><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="x/worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>`,
      "xl/sharedStrings.xml": `<sst><si><t>Region</t></si><si><t>Date</t></si><si><r><t>No</t></r><r><t>rth</t></r></si></sst>`,
      "xl/styles.xml": `<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData>
        <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="inlineStr"><is><t>Paid</t></is></c></row>
        <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="1"><v>45292</v></c><c r="C2"><f>SUM(1,2)</f><v>3</v></c><c r="D2" t="b"><v>1</v></c></row>
        <row r="3"/>
      </sheetData></worksheet>`,
      "xl/worksheets/sheet2.xml": `<worksheet><sheetData/></worksheet>`,
    };
    const result = await extractDocument("sales.xlsx", "", zip(files));
    expect(result?.kind).toBe("spreadsheet");
    expect(result?.summary).toBe("Spreadsheet, 2 sheets");
    expect(result?.text).toContain("## Sheet: Sales — 2 rows × 4 columns");
    expect(result?.text).toContain("| Region | Date |  | Paid |");
    expect(result?.text).toContain("| North | 2024-01-01 | 3 | TRUE |");
    expect(result?.text).toContain("## Sheet: Notes (hidden)");
  });

  it("reads slides in deck order with their speaker notes", async () => {
    const slide = (title: string, bullet: string) =>
      `<p:sld><p:sp><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:sp><p:sp><a:p><a:r><a:t>${bullet}</a:t></a:r></a:p></p:sp></p:sld>`;
    const files = {
      "ppt/presentation.xml": `<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>`,
      "ppt/_rels/presentation.xml.rels": `<Relationships><Relationship Id="rId2" Target="slides/slide1.xml"/><Relationship Id="rId3" Target="slides/slide2.xml"/></Relationships>`,
      "ppt/slides/slide1.xml": slide("Second", "later point"),
      "ppt/slides/slide2.xml": slide("First", "opening point"),
      "ppt/slides/_rels/slide2.xml.rels": `<Relationships><Relationship Id="rId1" Type="http://x/relationships/notesSlide" Target="../notesSlides/notesSlide9.xml"/></Relationships>`,
      "ppt/notesSlides/notesSlide9.xml": `<p:notes><a:p><a:r><a:t>Say hello first</a:t></a:r></a:p><a:p><a:r><a:t>1</a:t></a:r></a:p></p:notes>`,
    };
    const result = await extractDocument("deck.pptx", "", zip(files));
    expect(result?.summary).toBe("Presentation, 2 slides");
    const text = result!.text;
    expect(text.indexOf("## Slide 1: First")).toBeLessThan(text.indexOf("## Slide 2: Second"));
    expect(text).toContain("- opening point");
    expect(text).toContain("Speaker notes: Say hello first");
  });

  it("reads OpenDocument text and spreadsheets", async () => {
    const odt = await extractDocument(
      "notes.odt",
      "",
      zip({ "content.xml": `<office:document-content><office:body><office:text><text:h text:outline-level="1">Intro</text:h><text:p>One<text:s text:c="2"/>two<text:tab/>three</text:p></office:text></office:body></office:document-content>` }),
    );
    expect(odt?.text).toContain("## Intro");
    expect(odt?.text).toContain("One  two\tthree");

    const ods = await extractDocument(
      "grid.ods",
      "",
      zip({ "content.xml": `<table:table table:name="Data"><table:table-row><table:table-cell><text:p>a</text:p></table:table-cell><table:table-cell table:number-columns-repeated="2"><text:p>b</text:p></table:table-cell></table:table-row></table:table>` }),
    );
    expect(ods?.text).toContain("## Sheet: Data");
    expect(ods?.text).toContain("| a | b | b |");
  });

  it("reads an EPUB's chapters in spine order", async () => {
    const result = await extractDocument(
      "book.epub",
      "application/epub+zip",
      zip({
        "META-INF/container.xml": `<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`,
        "OEBPS/content.opf": `<package><metadata><dc:title>Tale</dc:title></metadata><manifest><item id="c2" href="two.xhtml"/><item id="c1" href="one.xhtml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`,
        "OEBPS/one.xhtml": "<html><body><h1>Chapter one</h1><p>It began.</p></body></html>",
        "OEBPS/two.xhtml": "<html><body><h1>Chapter two</h1><p>It ended.</p></body></html>",
      }),
    );
    expect(result?.summary).toBe("E-book: Tale, 2 sections");
    expect(result!.text.indexOf("Chapter one")).toBeLessThan(result!.text.indexOf("Chapter two"));
  });

  it("reads plain text, CSV and notebooks, and leaves binaries alone", async () => {
    expect((await extractDocument("a.csv", "text/csv", Buffer.from("a,b\n1,2\n")))?.kind).toBe("spreadsheet");
    expect((await extractDocument("main.rs", "", Buffer.from("fn main() {}\n")))?.text).toBe("fn main() {}");
    expect(await extractDocument("photo.png", "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]))).toBeNull();
    expect(await extractDocument("blob.bin", "application/octet-stream", Buffer.from([1, 0, 2, 0]))).toBeNull();
    const nb = await extractDocument(
      "n.ipynb",
      "",
      Buffer.from(JSON.stringify({ cells: [{ cell_type: "markdown", source: ["# Title"] }, { cell_type: "code", source: "print(1)", outputs: [{ text: "1\n" }] }] })),
    );
    expect(nb?.text).toContain("# Title");
    expect(nb?.text).toContain("print(1)");
    expect(nb?.text).toContain("Output:\n1");
  });

  it("decodes UTF-16 text with a byte-order mark", async () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("héllo", "utf16le")]);
    expect((await extractDocument("u.txt", "text/plain", bytes))?.text).toBe("héllo");
  });

  it("cuts text at maxChars and says so", async () => {
    const result = await extractDocument("big.txt", "text/plain", Buffer.from("x".repeat(500)), { maxChars: 100 });
    expect(result?.text).toHaveLength(100);
    expect(result?.truncated).toBe(true);
  });

  it("reports a corrupt Office file instead of throwing", async () => {
    const result = await extractDocument("broken.docx", "", Buffer.from("not a zip"));
    expect(result?.warning).toMatch(/Could not read/);
  });

  const hasPdftotext = (() => {
    try {
      execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!hasPdftotext)("reads a PDF page by page", async () => {
    // A one-page PDF with a text layer, written by hand.
    const stream = "BT /F1 18 Tf 72 720 Td (Hello from a PDF) Tj ET";
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    let body = "%PDF-1.4\n";
    const offsets: number[] = [];
    objects.forEach((object, i) => {
      offsets.push(body.length);
      body += `${i + 1} 0 obj\n${object}\nendobj\n`;
    });
    const xref = body.length;
    body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
    body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const result = await extractDocument("hello.pdf", "application/pdf", Buffer.from(body, "latin1"), { maxPageImages: 0 });
    expect(result?.summary).toBe("PDF, 1 page");
    expect(result?.text).toContain("--- Page 1 ---");
    expect(result?.text).toContain("Hello from a PDF");
  });
});

describe("htmlToText", () => {
  it("keeps the article and drops scripts and navigation", () => {
    const filler = "Body text that matters. ".repeat(30);
    const page = htmlToText(
      `<html><head><title>My &amp; page</title><script>alert(1)</script></head><body><nav>Home | About</nav><article><h2>Section</h2><p>${filler}</p><ul><li>one</li><li>two</li></ul></article><footer>©</footer></body></html>`,
    );
    expect(page.title).toBe("My & page");
    expect(page.text).toContain("## Section");
    expect(page.text).toContain("- one");
    expect(page.text).not.toContain("alert");
    expect(page.text).not.toContain("Home | About");
  });
});

describe("rtfToText", () => {
  it("keeps the text and drops the font table", () => {
    expect(rtfToText("{\\rtf1{\\fonttbl{\\f0 Arial;}}\\f0 Hello\\par World \\'e9\\u8364?}")).toBe("Hello\nWorld é€");
  });
});

describe("estimateTokens", () => {
  it("counts about four characters a token", () => {
    expect(estimateTokens("x".repeat(400))).toBe(100);
  });
});

/** A hand-written PDF, one page per entry; a null page has no text at all. */
function pdfOf(pages: (string | null)[]): Buffer {
  const objects: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", ""];
  const kids: string[] = [];
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (const text of pages) {
    const stream = text === null ? "" : `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    const content = objects.length;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    kids.push(`${objects.length} 0 R`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

/** A tar of regular files, ustar headers. */
function tar(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, "utf8");
    const header = Buffer.alloc(512);
    header.write(name, 0, "utf8");
    header.write("0000644\0", 100);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("0", 156);
    header.write("ustar\0", 257);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

const CHART = `<c:chartSpace><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>Revenue</a:t></a:r></a:p></c:rich></c:tx></c:title>
<c:plotArea><c:barChart><c:ser><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>2024</c:v></c:pt></c:strCache></c:strRef></c:tx>
<c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt></c:strCache></c:strRef></c:cat>
<c:val><c:numRef><c:numCache><c:formatCode>General</c:formatCode><c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>12.5</c:v></c:pt></c:numCache></c:numRef></c:val>
</c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>`;

describe("charts, tables and pictures in Office files", () => {
  it("reads a chart's cached data as a table", () => {
    const text = chartText(CHART);
    expect(text).toContain("Chart (bar): Revenue");
    expect(text).toContain("|  | 2024 |");
    expect(text).toContain("| Q1 | 10 |");
    expect(text).toContain("| Q2 | 12.5 |");
  });

  it("reads a slide's table, chart and picture alt text", async () => {
    const files = {
      "ppt/presentation.xml": `<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`,
      "ppt/_rels/presentation.xml.rels": `<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>`,
      "ppt/slides/slide1.xml":
        `<p:sld><p:sp><a:p><a:r><a:t>Results</a:t></a:r></a:p></p:sp>` +
        `<a:tbl><a:tr><a:tc><a:p><a:r><a:t>Team</a:t></a:r></a:p></a:tc><a:tc><a:p><a:r><a:t>Score</a:t></a:r></a:p></a:tc></a:tr>` +
        `<a:tr><a:tc><a:p><a:r><a:t>Red</a:t></a:r></a:p></a:tc><a:tc><a:p><a:r><a:t>7</a:t></a:r></a:p></a:tc></a:tr></a:tbl>` +
        `<p:pic><p:nvPicPr><p:cNvPr id="4" name="Picture 3" descr="Org chart of the sales team"/></p:nvPicPr></p:pic></p:sld>`,
      "ppt/slides/_rels/slide1.xml.rels": `<Relationships><Relationship Id="rId2" Type="http://x/relationships/chart" Target="../charts/chart1.xml"/></Relationships>`,
      "ppt/charts/chart1.xml": CHART,
    };
    const text = (await extractDocument("deck.pptx", "", zip(files)))!.text;
    expect(text).toContain("## Slide 1: Results");
    expect(text).toContain("| Team | Score |");
    expect(text).toContain("| Red | 7 |");
    // The table's cells are in the table, not repeated as bullets.
    expect(text).not.toContain("- Red");
    expect(text).toContain("Chart (bar): Revenue");
    expect(text).toContain("[Picture: Org chart of the sales team]");
  });

  it("reads a Word document's charts and picture alt text, and counts its pictures", async () => {
    const files = {
      "word/document.xml": `<w:document ${W}><w:body><w:p><w:r><w:t>See below.</w:t></w:r><w:r><w:drawing><wp:inline><wp:docPr id="1" name="Picture 1" descr="A map of the site"/></wp:inline></w:drawing></w:r></w:p></w:body></w:document>`,
      "word/charts/chart1.xml": CHART,
      "word/media/image1.png": "png",
    };
    const text = (await extractDocument("report.docx", "", zip(files)))!.text;
    expect(text).toContain("[Picture: A map of the site]");
    expect(text).toContain("## Charts");
    expect(text).toContain("| Q2 | 12.5 |");
    expect(text).toContain("1 embedded picture");
  });
});

describe("XML from other writers", () => {
  it("reads a workbook whose sheets carry a namespace prefix (.NET SDK), and a formula with no cached value (openpyxl)", async () => {
    const X = 'xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
    const files = {
      "xl/workbook.xml": `<x:workbook ${X}><x:sheets><x:sheet name="Totals" r:id="rId1"/></x:sheets></x:workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
      "xl/worksheets/sheet1.xml":
        `<x:worksheet ${X}><x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>Amount</x:t></x:is></x:c></x:row>` +
        `<x:row r="2"><x:c r="A2"><x:v>5</x:v></x:c></x:row><x:row r="3"><x:c r="A3"><x:f>SUM(A2:A2)</x:f><x:v></x:v></x:c></x:row></x:sheetData></x:worksheet>`,
    };
    const text = (await extractDocument("totals.xlsx", "", zip(files)))!.text;
    expect(text).toContain("## Sheet: Totals — 3 rows × 1 columns");
    expect(text).toContain("| Amount |");
    expect(text).toContain("| 5 |");
    expect(text).toContain("| =SUM(A2:A2) |");
  });

  it("reads a chart written in the default namespace, with no cached numbers", () => {
    const chart =
      `<chartSpace xmlns="http://schemas.openxmlformats.org/drawingml/2006/chart"><chart><title><tx><rich>` +
      `<a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:r><a:t>Sales</a:t></a:r></a:p></rich></tx></title>` +
      `<plotArea><lineChart><ser><val><numRef><f>'Data'!$B$2:$B$6</f></numRef></val></ser></lineChart></plotArea></chart></chartSpace>`;
    expect(chartText(chart)).toBe("Chart (line): Sales — plots 'Data'!$B$2:$B$6");
  });
});

describe("archives", () => {
  it("lists a ZIP and reads the files in it, documents included", async () => {
    const docx = zip({ "word/document.xml": `<w:document ${W}><w:body><w:p><w:r><w:t>Inner contract text</w:t></w:r></w:p></w:body></w:document>` });
    const result = await extractDocument(
      "bundle.zip",
      "application/zip",
      zip({ "src/main.py": "print('hi')\n", "docs/contract.docx": docx, "__MACOSX/._main.py": "junk", "img/logo.png": "\u0000PNG" }),
    );
    expect(result?.kind).toBe("archive");
    expect(result?.summary).toBe("ZIP archive, 4 files");
    expect(result?.text).toContain("- src/main.py (12 B)");
    expect(result?.text).toContain("## src/main.py");
    expect(result?.text).toContain("print('hi')");
    expect(result?.text).toContain("## docs/contract.docx (Word document, 3 words)");
    expect(result?.text).toContain("Inner contract text");
    expect(result?.text).not.toContain("## __MACOSX");
    expect(result?.text).not.toContain("## img/logo.png");
  });

  it("lists an archive inside an archive without opening it", async () => {
    const inner = zip({ "deep.txt": "should not be read" });
    const result = await extractDocument("outer.zip", "", zip({ "inner.zip": inner }));
    expect(result?.text).toContain("- inner.zip");
    expect(result?.text).not.toContain("should not be read");
  });

  it("reads a tar.gz and a single gzipped file", async () => {
    const tgz = await extractDocument("release.tar.gz", "application/gzip", gzipSync(tar({ "README.md": "# Release notes\nFixed things." })));
    expect(tgz?.summary).toBe("Tar archive (gzip), 1 file");
    expect(tgz?.text).toContain("## README.md");
    expect(tgz?.text).toContain("Fixed things.");

    const log = await extractDocument("server.log.gz", "", gzipSync(Buffer.from("ERROR disk full\n")));
    expect(log?.text).toContain("ERROR disk full");
  });
});

describe("web pages", () => {
  it("keeps the page's description and warns when script draws the content", async () => {
    const shell = `<html><head><title>App</title><meta name="description" content="A dashboard for invoices"></head><body><div id="root"></div><script>${"x".repeat(6000)}</script></body></html>`;
    const result = await extractDocument("app.html", "text/html", Buffer.from(shell));
    expect(result?.text).toContain("> A dashboard for invoices");
    expect(result?.warning).toMatch(/JavaScript/);
  });
});

const hasPoppler = (() => {
  try {
    execFileSync("pdftoppm", ["-v"], { stdio: "ignore" });
    execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasPoppler)("PDF OCR", () => {
  /** A `tesseract` on PATH that answers with fixed text, so OCR is tested without the real engine. */
  function withFakeTesseract(output: string): () => void {
    const dir = mkdtempSync(join(tmpdir(), "fake-tesseract-"));
    const bin = join(dir, "tesseract");
    writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`);
    chmodSync(bin, 0o755);
    const before = process.env.PATH;
    process.env.PATH = `${dir}:${before}`;
    return () => {
      process.env.PATH = before;
      rmSync(dir, { recursive: true, force: true });
    };
  }

  it("reads only the pages with no text layer by OCR, and says so", async () => {
    const restore = withFakeTesseract("Scanned invoice total 42.00 EUR");
    try {
      const result = await extractDocument("mixed.pdf", "application/pdf", pdfOf(["A typed cover page with enough text on it", null]), { maxPageImages: 0 });
      expect(result?.text).toContain("--- Page 1 ---\nA typed cover page");
      expect(result?.text).toContain("--- Page 2 (OCR) ---\nScanned invoice total 42.00 EUR");
      expect(result?.warning).toMatch(/1 page was read by OCR/);
    } finally {
      restore();
    }
  });

  it("falls back to the page-images warning when OCR is not installed", async () => {
    const before = process.env.PATH;
    // poppler only: a PATH with no tesseract on it.
    const dir = mkdtempSync(join(tmpdir(), "no-tesseract-"));
    for (const tool of ["pdftotext", "pdftoppm"]) {
      const real = execFileSync("sh", ["-c", `command -v ${tool}`]).toString().trim();
      writeFileSync(join(dir, tool), `#!/bin/sh\nexec ${real} "$@"\n`);
      chmodSync(join(dir, tool), 0o755);
    }
    process.env.PATH = dir;
    try {
      const result = await extractDocument("scan.pdf", "application/pdf", pdfOf([null]), { maxPageImages: 0 });
      expect(result?.warning).toMatch(/probably scanned/);
      expect(result?.warning).not.toMatch(/OCR/);
    } finally {
      process.env.PATH = before;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
