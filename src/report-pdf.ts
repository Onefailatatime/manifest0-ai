// The inventory report as a PDF (US Letter), same content and look as the emailed report.
// Drawn with pdf-lib: plain JavaScript, so it runs inside the Worker.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { manifestCode } from "./manifest";
import { contentsText, type ProductRow, type VisitRow } from "./visit-agent";

const NAVY = rgb(4 / 255, 29 / 255, 62 / 255);
const YELLOW = rgb(243 / 255, 191 / 255, 43 / 255);
const INK = rgb(15 / 255, 21 / 255, 31 / 255);
const MUTED = rgb(90 / 255, 99 / 255, 114 / 255);
const LINE = rgb(227 / 255, 230 / 255, 234 / 255);
const TINT = rgb(245 / 255, 246 / 255, 248 / 255);
const RED = rgb(180 / 255, 35 / 255, 24 / 255);
const GREEN = rgb(25 / 255, 74 / 255, 37 / 255);

const W = 612, H = 792, M = 40;                       // page size and margin (points)
// Table columns: #, product, containers, EPA code, DOT hazard, SDS
const COLS = [{ x: M, w: 20 }, { x: M + 20, w: 196 }, { x: M + 216, w: 118 }, { x: M + 334, w: 62 }, { x: M + 396, w: 92 }, { x: M + 488, w: 44 }];

/** The built-in PDF fonts only cover Western characters; swap anything else so drawing never fails. */
const clean = (s: unknown) =>
  String(s ?? "").replace(/[‐-―]/g, "-").replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");

/** Splits text into lines that fit a width. */
function wrap(text: string, font: PDFFont, size: number, width: number) {
  const lines: string[] = [];
  for (const para of clean(text).split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width) { line = next; continue; }
      if (line) lines.push(line);
      line = word;
      while (font.widthOfTextAtSize(line, size) > width && line.length > 1) {   // one very long word: cut it
        let cut = line.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > width) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line);
  }
  return lines;
}

export async function reportPdf(visit: VisitRow, products: ProductRow[]) {
  const doc = await PDFDocument.create();
  doc.setTitle(clean(`Chemical inventory - ${visit.site_name ?? "site"}`));
  doc.setAuthor(clean(visit.user_email));
  doc.setCreator("Manifest0 AI");
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page: PDFPage = doc.addPage([W, H]);
  let y = H;
  const text = (s: string, x: number, yy: number, size: number, font = reg, color = INK) =>
    page.drawText(clean(s), { x, y: yy, size, font, color });

  // ---- header band with the logo, title and hazard tape
  page.drawRectangle({ x: 0, y: H - 96, width: W, height: 96, color: NAVY });
  const lx = M, ly = H - 70, ls = 34;                  // logo: yellow diamond with a navy 0
  page.drawSvgPath(`M ${ls / 2} 0 L ${ls} ${ls / 2} L ${ls / 2} ${ls} L 0 ${ls / 2} Z`, { x: lx, y: ly + ls, color: YELLOW });
  page.drawEllipse({ x: lx + ls / 2, y: ly + ls / 2, xScale: 4.3, yScale: 5.8, borderColor: NAVY, borderWidth: 2.6 });
  text("Manifest0", lx + 46, H - 40, 11, bold, rgb(1, 1, 1));
  text("AI", lx + 46 + bold.widthOfTextAtSize("Manifest0 ", 11), H - 40, 11, bold, YELLOW);
  text(`Chemical inventory - ${visit.site_name ?? "Site"}`, lx + 46, H - 62, 18, bold, rgb(1, 1, 1));
  text(`Prepared by ${visit.user_email} · ${visit.created_at.slice(0, 10)}`, lx + 46, H - 80, 9, reg, rgb(0.8, 0.84, 0.9));
  for (let x = -10; x < W; x += 16) {                   // yellow/navy stripes
    page.drawSvgPath(`M ${x} 0 L ${x + 8} 0 L ${x + 14} 6 L ${x + 6} 6 Z`, { x: 0, y: H - 96, color: YELLOW });
  }
  y = H - 120;

  // ---- summary boxes
  const rooms = [...new Set(products.map((p) => p.room))];
  const stats: [string, string][] = [
    [String(products.length), "products"], [String(rooms.length), rooms.length === 1 ? "room" : "rooms"],
    [String(products.reduce((a, p) => a + p.quantity, 0)), "containers"],
    [`${products.filter((p) => p.sds_key).length}/${products.length}`, "SDS found"],
  ];
  const bw = (W - 2 * M - 3 * 10) / 4;
  stats.forEach(([v, l], i) => {
    const x = M + i * (bw + 10);
    page.drawRectangle({ x, y: y - 44, width: bw, height: 44, color: TINT });
    text(v, x + 10, y - 22, 16, bold, NAVY);
    text(l, x + 10, y - 36, 8.5, reg, MUTED);
  });
  y -= 70;

  // ---- table
  const header = () => {
    ["#", "PRODUCT", "CONTAINERS", "EPA CODE", "DOT HAZARD", "SDS"].forEach((h, i) => text(h, COLS[i].x, y, 7.5, bold, MUTED));
    y -= 8;
  };
  const newPage = () => { page = doc.addPage([W, H]); y = H - M; header(); };
  header();

  let n = 0;
  for (const room of rooms) {
    if (y < 110) newPage();
    y -= 14;
    text(room.toUpperCase(), M, y, 8, bold, MUTED);
    y -= 5;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1.5, color: NAVY });

    for (const p of products.filter((pr) => pr.room === room)) {
      n++;
      const m = manifestCode(p.container_type, p.container_material);
      const size = [p.container_size?.split(/[(\n]/)[0].trim(), contentsText(p)].filter(Boolean).join(" · ");
      // each cell: lines of [text, font, size, color]
      const cells: [string, PDFFont, number, typeof INK][][] = [
        [[String(n), reg, 8.5, MUTED]],
        [
          ...wrap(p.product_name, bold, 9, COLS[1].w - 8).map((l) => [l, bold, 9, INK] as [string, PDFFont, number, typeof INK]),
          ...(p.manufacturer ? wrap(p.manufacturer, reg, 8, COLS[1].w - 8).map((l) => [l, reg, 8, MUTED] as [string, PDFFont, number, typeof INK]) : []),
          ...(p.product_code ? [[clean(p.product_code), reg, 8, MUTED] as [string, PDFFont, number, typeof INK]] : []),
        ],
        [
          [`${p.quantity} x ${p.container_type === "other" ? "container" : p.container_type}`, reg, 9, INK],
          ...(size ? wrap(size, reg, 8, COLS[2].w - 8).map((l) => [l, reg, 8, MUTED] as [string, PDFFont, number, typeof INK]) : []),
          ...(p.count_note ? wrap(p.count_note, reg, 7.5, COLS[2].w - 8).map((l) => [l, reg, 7.5, MUTED] as [string, PDFFont, number, typeof INK]) : []),
        ],
        [m.code ? [`${p.quantity} ${m.code}`, bold, 9, INK] : ["Lab pack", reg, 8.5, MUTED]],
        [
          ...(p.hazard_class ? wrap(p.hazard_class, reg, 8.5, COLS[4].w - 6).map((l) => [l, reg, 8.5, INK] as [string, PDFFont, number, typeof INK]) : [["-", reg, 8.5, MUTED] as [string, PDFFont, number, typeof INK]]),
          ...(p.un_number ? [[clean(p.un_number), reg, 8, MUTED] as [string, PDFFont, number, typeof INK]] : []),
          ...(p.signal_word && p.signal_word !== "none" ? [[p.signal_word, bold, 7.5, p.signal_word === "DANGER" ? RED : rgb(138 / 255, 75 / 255, 0)] as [string, PDFFont, number, typeof INK]] : []),
        ],
        [p.sds_key ? ["Attached", bold, 8.5, GREEN] : p.sds_page_url || p.sds_url ? ["Online", reg, 8.5, MUTED] : ["Not found", bold, 8.5, RED]],
      ];
      const rowH = Math.max(...cells.map((c) => c.reduce((h, [, , s]) => h + s + 3, 0))) + 12;
      if (y - rowH < 60) newPage();
      cells.forEach((cell, i) => {
        let cy = y - 12;
        for (const [t, f, s, c] of cell) { text(t, COLS[i].x, cy, s, f, c); cy -= s + 3; }
      });
      y -= rowH;
      page.drawLine({ start: { x: M, y: y + 2 }, end: { x: W - M, y: y + 2 }, thickness: 0.6, color: LINE });
    }
  }

  // ---- footer on every page
  const pages = doc.getPages();
  pages.forEach((pg, i) => {
    pg.drawText(clean("Product data was read from label photos by AI and checked by the technician. Verify against the SDS before disposal."),
      { x: M, y: 28, size: 7, font: reg, color: MUTED });
    pg.drawText(`Page ${i + 1} of ${pages.length}`, { x: W - M - 50, y: 28, size: 7, font: reg, color: MUTED });
  });
  return doc.save();
}
