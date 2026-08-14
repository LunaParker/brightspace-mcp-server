/**
 * Tests for validateFileType — magic-byte detection with a text fallback.
 *
 * Regression context: D2L HTML content topics (TopicType 1 pages authored
 * in Brightspace) are served as UTF-8 HTML files that begin with a BOM
 * (EF BB BF). `file-type` cannot detect text formats (they have no magic
 * bytes), and the original fallback only accepted pure printable ASCII in
 * the first 512 bytes — so the BOM (or any accented character / smart
 * quote) made every HTML page fail with "Could not determine file type",
 * breaking download_file for those topics in both inline and disk mode.
 */

import { describe, it, expect } from "vitest";
import { validateFileType } from "../../src/utils/file-validator.js";

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** Minimal replica of a Conestoga D2L content page: BOM + HTML. */
const D2L_HTML_PAGE = Buffer.concat([
  UTF8_BOM,
  Buffer.from(
    '<!DOCTYPE html>\r\n<html lang="en">\r\n  <head>\r\n    <meta\r\n' +
      '      charset="UTF-8"\r\n      name="viewport"\r\n' +
      '      content="width=device-width, initial-scale=1.0, shrink-to-fit=no"\r\n' +
      "    />\r\n    <title>Social Comparison Theory</title>\r\n  </head>\r\n" +
      "  <body><p>Festinger’s theory — how we evaluate ourselves.</p></body>\r\n</html>\r\n",
    "utf8"
  ),
]);

describe("validateFileType — magic-byte detection", () => {
  it("detects PDF via magic bytes", async () => {
    const pdf = Buffer.from("%PDF-1.7\n1 0 obj\n<< >>\nendobj\n%%EOF\n");
    const result = await validateFileType(pdf);
    expect(result.mime).toBe("application/pdf");
    expect(result.ext).toBe("pdf");
  });

  it("rejects disallowed binary types detected via magic bytes", async () => {
    // ELF executable header — detectable by file-type, not in the allowlist.
    const elf = Buffer.concat([
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]),
      Buffer.alloc(64),
    ]);
    await expect(validateFileType(elf)).rejects.toThrow(/not allowed/);
  });

  it("rejects undetectable binary data containing NUL bytes", async () => {
    const binary = Buffer.from([0x01, 0x00, 0xfe, 0x00, 0x9c, 0x00, 0x02, 0x00]);
    await expect(validateFileType(binary)).rejects.toThrow(
      /Could not determine file type/
    );
  });
});

describe("validateFileType — text fallback", () => {
  it("accepts plain ASCII text as text/plain", async () => {
    const txt = Buffer.from("Week 11 reading list:\n- Chapter 9\n- Chapter 10\n");
    const result = await validateFileType(txt);
    expect(result.mime).toBe("text/plain");
  });

  it("accepts a BOM-prefixed D2L HTML page as text/html (regression)", async () => {
    const result = await validateFileType(D2L_HTML_PAGE);
    expect(result.mime).toBe("text/html");
    expect(result.ext).toBe("html");
  });

  it("accepts HTML without a BOM as text/html", async () => {
    const html = Buffer.from(
      "<html>\n<head><title>Intro</title></head>\n<body>Hello</body>\n</html>\n"
    );
    const result = await validateFileType(html);
    expect(result.mime).toBe("text/html");
  });

  it("accepts UTF-8 text with non-ASCII characters as text/plain", async () => {
    const txt = Buffer.from(
      "Résumé café — “smart quotes” and naïve accents.\n",
      "utf8"
    );
    const result = await validateFileType(txt);
    expect(result.mime).toBe("text/plain");
  });

  it("still rejects text when the allowlist has no text/ types", async () => {
    const txt = Buffer.from("just some text\n");
    await expect(
      validateFileType(txt, ["application/pdf"])
    ).rejects.toThrow(/Could not determine file type/);
  });
});
