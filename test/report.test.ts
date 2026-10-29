import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { manifestCode } from "../src/manifest";
import { reportPdf } from "../src/report-pdf";
import { contentsText, defaultEmail, inventoryCsv, messageHtml } from "../src/visit-agent";
import { productRow, visitRow } from "./helpers";

describe("EPA manifest container codes (Item 10)", () => {
  it.each([
    ["drum", "metal", "DM"], ["drum", "plastic", "DF"], ["drum", "fiber", "DF"], ["drum", "wood", "DW"],
    ["pail", "metal", "DM"], ["box", "fiber", "CF"], ["box", "metal", "CM"], ["box", "wood", "CW"],
    ["bag", "unknown", "BA"], ["cylinder", "metal", "CY"], ["tote", "plastic", "TP"],
  ])("%s made of %s is %s", (type, material, code) => {
    expect(manifestCode(type, material).code).toBe(code);
  });

  it("small containers have no code of their own (lab pack)", () => {
    for (const type of ["bottle", "jug", "can", "aerosol", "tube", "other"]) {
      const m = manifestCode(type, "plastic");
      expect(m.code).toBeNull();
      expect(m.hint).toMatch(/lab pack/i);
    }
  });

  it("a drum of unknown material gives a hint instead of guessing", () => {
    const m = manifestCode("drum", "unknown");
    expect(m.code).toBeNull();
    expect(m.hint).toMatch(/DM|DF/);
  });
});

describe("contents of a packed box", () => {
  it("describes what's inside", () => {
    expect(contentsText({ inner_type: "bottle", inner_count: 24, inner_size: "650 mL" })).toBe("contains ~24 bottle, 650 mL each");
  });
  it("works when only the count is known", () => {
    expect(contentsText({ inner_type: null, inner_count: 12, inner_size: null })).toBe("contains ~12 items");
  });
  it("is empty for a loose container", () => {
    expect(contentsText({ inner_type: null, inner_count: null, inner_size: null })).toBe("");
  });
});

describe("inventory spreadsheet (CSV)", () => {
  it("has a header row and one row per product", () => {
    const csv = inventoryCsv([productRow(), productRow({ product_name: "Clorox Bleach", room: "Lab 2" })]);
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('"Room","Manufacturer","Product"');
    expect(csv).toContain('"Clorox Bleach"');
  });

  it("keeps commas and quotes inside a cell", () => {
    const csv = inventoryCsv([productRow({ product_name: 'Wipes, Coconut & "Waterlily"' })]);
    expect(csv).toContain('"Wipes, Coconut & ""Waterlily"""');
  });

  it("includes the EPA code, or lab pack for small containers", () => {
    expect(inventoryCsv([productRow({ container_type: "drum", container_material: "metal", quantity: 2 })])).toContain('"2 DM"');
    expect(inventoryCsv([productRow()])).toMatch(/lab pack/i);
  });
});

describe("default email", () => {
  it("names the site and counts products and rooms", () => {
    const e = defaultEmail(visitRow(), [productRow(), productRow({ room: "Lab 2" })]);
    expect(e.subject).toBe("Chemical inventory – Riverside Clinic (2 products)");
    expect(e.message).toContain("2 products in 2 rooms");
  });

  it("is signed with the technician's name and company", () => {
    expect(defaultEmail(visitRow(), [productRow()]).message).toMatch(/Best regards,\nTamara\nAcme Environmental$/);
  });

  it("falls back to the email when no name was given", () => {
    expect(defaultEmail(visitRow({ prepared_by: null, company: null }), []).message).toMatch(/Best regards,\ntech@example.com$/);
  });

  it("turns the message into safe HTML paragraphs", () => {
    const html = messageHtml("Hi <Sam>,\n\nLine one\nline two");
    expect(html).toContain("<p>Hi &lt;Sam&gt;,</p>");
    expect(html).toContain("<p>Line one<br>line two</p>");
  });
});

describe("report PDF", () => {
  const pdfText = (bytes: Uint8Array) => new TextDecoder("latin1").decode(bytes);

  it("is a valid PDF", async () => {
    const bytes = await reportPdf(visitRow(), [productRow()]);
    expect(pdfText(bytes.slice(0, 5))).toBe("%PDF-");
  });

  it("does not break on characters the PDF fonts can't draw", async () => {
    const odd = productRow({ product_name: "Produit 清洁剂 → Ünïcödé 🧪", manufacturer: "Société “Test” – Ltd" });
    await expect(reportPdf(visitRow({ site_name: "Zürich – Lab ✓" }), [odd])).resolves.toBeInstanceOf(Uint8Array);
  });

  it("works with no products", async () => {
    await expect(reportPdf(visitRow(), [])).resolves.toBeInstanceOf(Uint8Array);
  });

  it("adds pages for a long inventory", async () => {
    const many = Array.from({ length: 60 }, (_, i) => productRow({ product_name: `Product ${i + 1}`, room: `Room ${i % 4}` }));
    const doc = await PDFDocument.load(await reportPdf(visitRow(), many));
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });
});
