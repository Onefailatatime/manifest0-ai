// The inventory report as a PDF (US Letter). Drawn with pdf-lib: plain JavaScript, so it runs inside the Worker.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import { manifestCode } from "./manifest";
import { contentsText, type ProductRow, type VisitRow } from "./visit-agent";

const c = (hex: string) => rgb(parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255);
const NAVY = c("#041D3E"), YELLOW = c("#F3BF2B"), WHITE = c("#FFFFFF"), INK = c("#0F151F"), MUTED = c("#5A6372");
const LINE = c("#E3E6EA"), TINT = c("#F5F6F8"), ZEBRA = c("#FAFBFC"), ROOM = c("#E8EEFB");
const RED = c("#B42318"), RED_BG = c("#FEE4E2"), GREEN = c("#194A25"), GREEN_BG = c("#DAEDDB"), AMBER = c("#8A4B00"), AMBER_BG = c("#FDF0D5");

const W = 612, H = 792, M = 40, CW = W - 2 * M;   // page, margin, content width (points)
// Table columns: #, product, containers, EPA code, DOT hazard, SDS
const COLS = [{ x: M + 8, w: 18 }, { x: M + 28, w: 190 }, { x: M + 222, w: 112 }, { x: M + 338, w: 58 }, { x: M + 400, w: 86 }, { x: M + 488, w: 44 }];

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

/** "2026-10-29 21:16:50" -> "October 29, 2026" */
const longDate = (sqlTime: string) =>
  new Date(sqlTime.replace(" ", "T") + "Z").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

export async function reportPdf(visit: VisitRow, products: ProductRow[]) {
  const doc = await PDFDocument.create();
  const site = visit.site_name ?? "Site";
  doc.setTitle(clean(`Chemical inventory report - ${site}`));
  doc.setAuthor(clean(visit.prepared_by ?? visit.user_email));
  doc.setCreator("Manifest0 AI");
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page: PDFPage = doc.addPage([W, H]);
  let y = H;
  const text = (s: string, x: number, yy: number, size: number, font = reg, color: RGB = INK) =>
    page.drawText(clean(s), { x, y: yy, size, font, color });
  const textRight = (s: string, right: number, yy: number, size: number, font = reg, color: RGB = INK) =>
    text(s, right - font.widthOfTextAtSize(clean(s), size), yy, size, font, color);
  /** Rounded rectangle; (x, top) is its top-left corner. */
  const round = (x: number, top: number, w: number, h: number, r: number, color: RGB) =>
    page.drawSvgPath(`M ${r} 0 H ${w - r} A ${r} ${r} 0 0 1 ${w} ${r} V ${h - r} A ${r} ${r} 0 0 1 ${w - r} ${h} H ${r} A ${r} ${r} 0 0 1 0 ${h - r} V ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`,
      { x, y: top, color });
  /** Small colored label, e.g. DANGER or Attached; returns its height. */
  const pill = (s: string, x: number, top: number, fg: RGB, bg: RGB) => {
    const w = bold.widthOfTextAtSize(s, 7) + 10;
    round(x, top, w, 13, 6.5, bg);
    text(s, x + 5, top - 9.3, 7, bold, fg);
    return 13;
  };

  // ---- header: hazard tape on the top edge, logo, site name
  const titleLines = wrap(site, bold, 24, CW).slice(0, 2);
  function titleHeight() { return 82 + titleLines.length * 27; }
  const HB = titleHeight();
  page.drawRectangle({ x: 0, y: H - HB, width: W, height: HB, color: NAVY });
  for (let x = -12; x < W; x += 18) {
    page.drawSvgPath(`M ${x} 0 L ${x + 9} 0 L ${x + 17} 8 L ${x + 8} 8 Z`, { x: 0, y: H, color: YELLOW });
  }
  const ls = 26, lx = M, ltop = H - 30;                                     // logo: yellow diamond with a navy 0
  page.drawSvgPath(`M ${ls / 2} 0 L ${ls} ${ls / 2} L ${ls / 2} ${ls} L 0 ${ls / 2} Z`, { x: lx, y: ltop, color: YELLOW });
  page.drawEllipse({ x: lx + ls / 2, y: ltop - ls / 2, xScale: 3.3, yScale: 4.5, borderColor: NAVY, borderWidth: 2 });
  text("Manifest0", lx + 34, ltop - 17, 11, bold, WHITE);
  text("AI", lx + 34 + bold.widthOfTextAtSize("Manifest0 ", 11), ltop - 17, 11, bold, YELLOW);
  textRight("CHEMICAL INVENTORY REPORT", W - M, ltop - 16, 7.5, bold, YELLOW);
  let ty = H - 86;
  for (const l of titleLines) { text(l, M, ty, 24, bold, WHITE); ty -= 27; }
  y = H - HB - 26;

  // ---- details row
  const clients = (JSON.parse(visit.recipients) as string[]).slice(1);
  const rooms = [...new Set(products.map((p) => p.room))];
  const details: [string, string[]][] = [
    ["PREPARED BY", [visit.prepared_by ?? visit.user_email, ...(visit.company ? [visit.company] : [])]],
    ["DATE", [longDate(visit.created_at)]],
    ["CLIENT", clients.length ? clients : ["-"]],
    ["ROOMS", [rooms.join(", ") || "-"]],
  ];
  const dw = CW / 4;
  let detailH = 0;
  details.forEach(([label, lines], i) => {
    const x = M + i * dw;
    text(label, x, y, 7, bold, MUTED);
    let ly = y - 14;
    for (const line of lines) for (const l of wrap(line, reg, 9.5, dw - 12).slice(0, 3)) { text(l, x, ly, 9.5, reg, INK); ly -= 12; }
    detailH = Math.max(detailH, y - ly);
  });
  y -= detailH + 14;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.8, color: LINE });
  y -= 18;

  // ---- summary cards
  const stats: [string, string][] = [
    [String(products.length), products.length === 1 ? "product" : "products"],
    [String(rooms.length), rooms.length === 1 ? "room" : "rooms"],
    [String(products.reduce((a, p) => a + p.quantity, 0)), "containers"],
    [`${products.filter((p) => p.sds_key).length} / ${products.length}`, "SDS found"],
  ];
  const gap = 10, cw = (CW - 3 * gap) / 4, ch = 50;
  stats.forEach(([v, l], i) => {
    const x = M + i * (cw + gap);
    round(x, y, cw, ch, 6, TINT);
    page.drawRectangle({ x, y: y - ch + 10, width: 3, height: ch - 20, color: YELLOW });
    text(v, x + 14, y - 24, 18, bold, NAVY);
    text(l, x + 14, y - 38, 8.5, reg, MUTED);
  });
  y -= ch + 24;

  // ---- table
  const header = () => {
    round(M, y, CW, 22, 5, TINT);
    ["#", "PRODUCT", "CONTAINERS", "EPA CODE", "DOT HAZARD", "SDS"].forEach((h, i) => text(h, COLS[i].x, y - 14.5, 7, bold, MUTED));
    y -= 30;
  };
  const footerSpace = 50;
  const newPage = () => { page = doc.addPage([W, H]); y = H - M; header(); };
  header();

  let n = 0;
  for (const room of rooms) {
    const inRoom = products.filter((p) => p.room === room);
    if (y < footerSpace + 70) newPage();
    round(M, y, CW, 20, 4, ROOM);
    text(room, M + 8, y - 13.5, 9, bold, NAVY);
    textRight(`${inRoom.length} ${inRoom.length === 1 ? "product" : "products"}`, W - M - 8, y - 13.5, 8, reg, MUTED);
    y -= 24;

    inRoom.forEach((p, idx) => {
      n++;
      const m = manifestCode(p.container_type, p.container_material);
      const name = wrap(p.product_name, bold, 9.5, COLS[1].w - 6);
      const maker = p.manufacturer ? wrap(p.manufacturer, reg, 8, COLS[1].w - 6) : [];
      const size = [p.container_size?.split(/[(\n]/)[0].trim(), contentsText(p)].filter(Boolean).join(" · ");
      const sizeLines = size ? wrap(size, reg, 8, COLS[2].w - 6) : [];
      const haz = p.hazard_class ? wrap(p.hazard_class, reg, 8.5, COLS[4].w - 4) : [];
      const leftH = name.length * 12 + maker.length * 10 + (p.product_code ? 10 : 0);
      const hazH = (haz.length || 1) * 11 + (p.un_number ? 10 : 0) + (p.signal_word && p.signal_word !== "none" ? 16 : 0);
      const rowH = Math.max(leftH, 12 + sizeLines.length * 10, hazH, 16) + 16;
      if (y - rowH < footerSpace) newPage();
      if (idx % 2 === 1) page.drawRectangle({ x: M, y: y - rowH, width: CW, height: rowH, color: ZEBRA });

      const top = y - 8;
      text(String(n), COLS[0].x, top - 9, 8.5, reg, MUTED);
      let ly = top - 9;
      for (const l of name) { text(l, COLS[1].x, ly, 9.5, bold, INK); ly -= 12; }
      for (const l of maker) { text(l, COLS[1].x, ly, 8, reg, MUTED); ly -= 10; }
      if (p.product_code) text(p.product_code, COLS[1].x, ly, 8, reg, MUTED);

      text(`${p.quantity} x ${p.container_type === "other" ? "container" : p.container_type}`, COLS[2].x, top - 9, 9, reg, INK);
      ly = top - 21;
      for (const l of sizeLines) { text(l, COLS[2].x, ly, 8, reg, MUTED); ly -= 10; }

      if (m.code) text(`${p.quantity} ${m.code}`, COLS[3].x, top - 9, 9.5, bold, NAVY);
      else text("Lab pack", COLS[3].x, top - 9, 8.5, reg, MUTED);

      ly = top - 9;
      if (haz.length) for (const l of haz) { text(l, COLS[4].x, ly, 8.5, reg, INK); ly -= 11; }
      else { text("-", COLS[4].x, ly, 8.5, reg, MUTED); ly -= 11; }
      if (p.un_number) { text(p.un_number, COLS[4].x, ly, 8, reg, MUTED); ly -= 10; }
      if (p.signal_word && p.signal_word !== "none") {
        const danger = p.signal_word === "DANGER";
        pill(p.signal_word, COLS[4].x, ly + 6, danger ? RED : AMBER, danger ? RED_BG : AMBER_BG);
      }

      if (p.sds_key) pill("Attached", COLS[5].x, top - 1, GREEN, GREEN_BG);
      else if (p.sds_page_url || p.sds_url) pill("Online", COLS[5].x, top - 1, MUTED, TINT);
      else pill("Missing", COLS[5].x, top - 1, RED, RED_BG);

      y -= rowH;
      page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.5, color: LINE });
    });
    y -= 12;
  }

  // ---- footer: brand and page number
  const pages = doc.getPages();
  pages.forEach((pg, i) => {
    pg.drawLine({ start: { x: M, y: 40 }, end: { x: W - M, y: 40 }, thickness: 0.5, color: LINE });
    pg.drawText("Manifest0 AI", { x: M, y: 26, size: 7.5, font: bold, color: MUTED });
    const label = `Page ${i + 1} of ${pages.length}`;
    pg.drawText(label, { x: W - M - reg.widthOfTextAtSize(label, 7.5), y: 26, size: 7.5, font: reg, color: MUTED });
  });
  return doc.save();
}
