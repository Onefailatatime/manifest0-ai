import { Agent } from "agents";
import { Buffer } from "node:buffer";
import { manifestCode } from "./manifest";
import { extractProducts, findSds, type KnownProduct } from "./muse";
import { reportPdf } from "./report-pdf";

/** Byte-order mark: makes Excel open the CSV as UTF-8 (accents, symbols). */
const BOM = String.fromCharCode(0xfeff);

// One VisitAgent per site visit, named by the visit id. It lives for the whole visit:
// the technician adds photos room by room, and the agent remembers every product it has
// already catalogued, so overlapping photos update a product instead of duplicating it.
//
// Queue (durable, one item at a time, in order):
//   processBatch (per upload)  ->  findSdsMany (the batch's new products, 4 at a time)  ->  sendReport (after Finish)

type VisitState = { visitId: string | null; appUrl: string; log: string[] };

const MAX_PDF_BYTES = 10 * 1024 * 1024;
const SDS_AT_ONCE = 4; // parallel SDS web searches per batch
// Resend allows 40 MB of attachments per email after base64 (+33%), so keep raw PDFs under ~25 MB.
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export class VisitAgent extends Agent<Env, VisitState> {
  initialState: VisitState = { visitId: null, appUrl: "", log: [] };

  /** Called once when the visit is created. */
  async open(visitId: string, appUrl: string) {
    if (this.state.visitId) return;
    this.setState({ visitId, appUrl, log: [] });
    this.log("Visit started");
  }

  /** Called after each photo upload. */
  async addBatch(batchId: string) {
    await this.queue("processBatch", { batchId });
  }

  /** Called when the technician taps Finish. */
  async finish() {
    await this.db("UPDATE visits SET status = 'finishing' WHERE id = ?", this.visitId).run();
    this.log("Finishing: waiting for remaining work, then emailing");
    await this.queue("sendReport", {});
  }

  /** Progress log, shown on the visit page. */
  getLog() {
    return this.state.log;
  }

  // ---- Step 1: read a batch of photos, merge with what we already know in that room ----
  async processBatch({ batchId }: { batchId: string }) {
    const { results: photos } = await this.db(
      "SELECT id, room, r2_key FROM photos WHERE batch_id = ? AND processed = 0 ORDER BY r2_key", batchId,
    ).all<{ id: string; room: string; r2_key: string }>();
    if (!photos.length) return;
    const room = photos[0].room;
    this.log(`${room}: reading ${photos.length} photo(s)`);

    try {
      const { results: known } = await this.db(
        "SELECT * FROM products WHERE visit_id = ? AND room = ?", this.visitId, room,
      ).all<ProductRow>();

      const images = await Promise.all(photos.map(async (ph) => {
        const obj = await this.env.FILES.get(ph.r2_key);
        if (!obj) throw new Error(`Missing photo ${ph.r2_key}`);
        return { mime: obj.httpMetadata?.contentType ?? "image/jpeg", base64: Buffer.from(await obj.arrayBuffer()).toString("base64") };
      }));

      const extracted = await extractProducts(this.env, images, known.map(toKnown));
      const knownById = new Map(known.map((k) => [k.id, k]));
      const statements: D1PreparedStatement[] = [];
      const newIds: string[] = [];
      let updated = 0;

      for (const p of extracted) {
        const keys = p.imageIndexes.map((i) => photos[i]?.r2_key).filter(Boolean);
        const existing = p.matchesProductId ? knownById.get(p.matchesProductId) : undefined;

        if (existing) {
          // Same product seen again: fill in anything we didn't know yet, keep the highest count
          // (overlapping photos show the same containers again). A technician's correction always wins.
          updated++;
          const edited = existing.count_edited === 1;
          statements.push(this.db(
            `UPDATE products SET manufacturer = ?, product_code = ?, container_type = ?, container_material = ?,
               container_size = ?, inner_type = ?, inner_count = ?, inner_size = ?, physical_state = ?,
               signal_word = ?, hazard_class = ?, un_number = ?, quantity = ?, count_note = ?, hazard_statements = ?,
               ghs_pictograms = ?, ingredients = ?, photo_keys = ? WHERE id = ?`,
            existing.manufacturer ?? p.manufacturer,
            existing.product_code ?? p.productCode,
            edited || existing.container_type !== "other" ? existing.container_type : p.containerType,
            edited || existing.container_material !== "unknown" ? existing.container_material : p.containerMaterial,
            existing.container_size ?? p.containerSize,
            existing.inner_type ?? p.innerType,
            edited ? existing.inner_count : maxOrNull(existing.inner_count, p.innerCount),
            existing.inner_size ?? p.innerSize,
            existing.physical_state === "unknown" ? p.physicalState : existing.physical_state ?? p.physicalState,
            existing.signal_word === "none" ? p.signalWord : existing.signal_word ?? p.signalWord,
            existing.hazard_class ?? p.hazardClass,
            existing.un_number ?? p.unNumber,
            edited ? existing.quantity : Math.max(existing.quantity, p.quantity),
            edited ? existing.count_note : p.countNote ?? existing.count_note,
            union(existing.hazard_statements, p.hazardStatements),
            union(existing.ghs_pictograms, p.ghsPictograms),
            union(existing.ingredients, p.ingredients),
            union(existing.photo_keys, keys),
            existing.id,
          ));
        } else {
          const id = crypto.randomUUID();
          newIds.push(id);
          statements.push(this.db(
            `INSERT INTO products (id, visit_id, room, manufacturer, product_name, product_code, container_type,
               container_material, container_size, inner_type, inner_count, inner_size, quantity, count_note,
               physical_state, signal_word, hazard_class, un_number, hazard_statements, ghs_pictograms, ingredients, photo_keys)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            id, this.visitId, room, p.manufacturer, p.productName, p.productCode, p.containerType, p.containerMaterial,
            p.containerSize, p.innerType, p.innerCount, p.innerSize,
            Math.max(1, p.quantity), p.countNote, p.physicalState, p.signalWord, p.hazardClass, p.unNumber,
            JSON.stringify(p.hazardStatements), JSON.stringify(p.ghsPictograms),
            JSON.stringify(p.ingredients), JSON.stringify(keys),
          ));
        }
      }
      statements.push(this.db("UPDATE photos SET processed = 1 WHERE batch_id = ?", batchId));
      await this.env.DB.batch(statements);

      this.log(`${room}: ${newIds.length} new product(s), ${updated} already known`);
      if (newIds.length) await this.queue("findSdsMany", { productIds: newIds });
    } catch (err) {
      await this.db("UPDATE photos SET processed = 2 WHERE batch_id = ?", batchId).run();
      this.log(`${room}: failed to read photos: ${err}`);
    }
  }

  // ---- Step 2: SDS — from the shared library if we've seen this product before, else web search ----
  /** Looks up several SDS at once (each search takes 15-60 s, so one at a time was slow). */
  async findSdsMany({ productIds }: { productIds: string[] }) {
    const todo = [...productIds];
    const worker = async () => { for (let id = todo.shift(); id; id = todo.shift()) await this.findSds({ productId: id }); };
    await Promise.all(Array.from({ length: Math.min(SDS_AT_ONCE, todo.length) }, worker));
  }

  async findSds({ productId }: { productId: string }) {
    const p = await this.db("SELECT * FROM products WHERE id = ?", productId).first<ProductRow>();
    if (!p) return;

    try {
      const matchKey = norm(`${p.manufacturer ?? ""}|${p.product_name}`);
      const codeKey = p.product_code ? norm(p.product_code) : null;
      const hit = await this.db(
        "SELECT * FROM sds_library WHERE match_key = ? OR (code_key IS NOT NULL AND code_key = ?) LIMIT 1", matchKey, codeKey,
      ).first<LibraryRow>();

      if (hit) {
        await this.env.DB.batch([
          this.db(
            `UPDATE products SET sds_status = 'found', sds_source = 'library', sds_url = ?, sds_page_url = ?, sds_key = ?,
               sds_notes = 'From SDS library' WHERE id = ?`,
            hit.source_url, hit.page_url, hit.r2_key, productId,
          ),
          this.db("UPDATE sds_library SET times_used = times_used + 1 WHERE id = ?", hit.id),
        ]);
        this.log(`SDS from library: ${p.product_name}`);
        return;
      }

      this.log(`Searching web for SDS: ${p.product_name}`);
      const found = await findSds(this.env, {
        manufacturer: p.manufacturer, productName: p.product_name, productCode: p.product_code,
      });

      let sdsKey: string | null = null;
      if (found.pdfUrl && found.isSds) {
        const pdf = await downloadPdf(found.pdfUrl);
        if (pdf) {
          sdsKey = `sds/${crypto.randomUUID()}.pdf`;
          await this.env.FILES.put(sdsKey, pdf, { httpMetadata: { contentType: "application/pdf" } });
        }
      }
      const status = sdsKey ? "found" : found.pageUrl || found.pdfUrl ? "page_only" : "not_found";
      const statements = [this.db(
        `UPDATE products SET sds_status = ?, sds_source = 'web', sds_url = ?, sds_page_url = ?, sds_key = ?, sds_notes = ?
         WHERE id = ?`,
        status, found.pdfUrl, found.pageUrl, sdsKey, `${found.confidence}: ${found.notes}`, productId,
      )];
      if (sdsKey) {
        statements.push(this.db(
          `INSERT INTO sds_library (id, manufacturer, product_name, product_code, match_key, code_key, r2_key, source_url, page_url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          crypto.randomUUID(), p.manufacturer, p.product_name, p.product_code, matchKey, codeKey, sdsKey, found.pdfUrl, found.pageUrl,
        ));
      }
      await this.env.DB.batch(statements);
      this.log(`SDS ${status.replace("_", " ")}: ${p.product_name}`);
    } catch (err) {
      await this.db("UPDATE products SET sds_status = 'not_found', sds_notes = ? WHERE id = ?", String(err), productId).run();
      this.log(`SDS search failed: ${p.product_name}: ${err}`);
    }
  }

  // ---- Step 3: after Finish, email the inventory + SDS PDFs to the user and the client ----
  async sendReport() {
    // Photos or SDS searches still in flight? Go to the back of the queue and try again after them.
    const pending = await this.db(
      `SELECT (SELECT COUNT(*) FROM photos WHERE visit_id = ?1 AND processed = 0)
            + (SELECT COUNT(*) FROM products WHERE visit_id = ?1 AND sds_status = 'pending' AND removed = 0) AS n`, this.visitId,
    ).first<{ n: number }>();
    if (pending!.n > 0) {
      await this.queue("sendReport", {});
      return;
    }

    try {
      const visit = (await this.db("SELECT * FROM visits WHERE id = ?", this.visitId).first<VisitRow>())!;
      const { results: products } = await this.db(
        "SELECT * FROM products WHERE visit_id = ? AND removed = 0 ORDER BY room, product_name", this.visitId,
      ).all<ProductRow>();

      // The inventory as a spreadsheet first, then each distinct SDS PDF until we hit the size limit (the rest are linked).
      const site = safeFilename(visit.site_name ?? "site");
      const attachments: Attachment[] = [
        { content: Buffer.from(await reportPdf(visit, products)).toString("base64"), filename: `Inventory report - ${site}.pdf`, content_type: "application/pdf" },
        { content: Buffer.from(BOM + inventoryCsv(products)).toString("base64"), filename: `Inventory - ${site}.csv`, content_type: "text/csv" },
      ];
      const attachedKeys = new Set<string>();
      let total = 0;
      for (const p of products) {
        if (!p.sds_key || attachedKeys.has(p.sds_key)) continue;
        const obj = await this.env.FILES.get(p.sds_key);
        if (!obj || total + obj.size > MAX_ATTACHMENT_BYTES) continue;
        total += obj.size;
        attachedKeys.add(p.sds_key);
        attachments.push({
          content: Buffer.from(await obj.arrayBuffer()).toString("base64"),
          filename: `SDS - ${safeFilename(p.product_name)}.pdf`,
          content_type: "application/pdf",
        });
      }

      const to = recipientsOf(visit);
      const draft = defaultEmail(visit, products);
      const subject = visit.email_subject || draft.subject;
      const message = visit.email_message ?? draft.message;
      // The email is the technician's message in a branded frame; the report itself is the attached PDF.
      // No link to the walk: the app needs sign-in and clients don't have accounts.
      const html = emailHtml(visit, products, message, attachedKeys, this.state.appUrl);

      if (!this.env.RESEND_API_KEY) {
        // No email provider configured (e.g. local dev): keep the report so it can be opened in the browser.
        const key = `visits/${this.visitId}/report.html`;
        await this.env.FILES.put(key, html, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
        await this.db("UPDATE visits SET status = 'done' WHERE id = ?", this.visitId).run();
        this.log(`RESEND_API_KEY not set, email not sent. Report: /api/files/${key} (${attachments.length} files would be attached)`);
        return;
      }

      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: this.env.EMAIL_FROM,
          to,
          reply_to: visit.user_email,
          subject,
          html,
          text: message,
          attachments,
        }),
      });
      if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);

      await this.db("UPDATE visits SET status = 'done', email_sent_at = datetime('now') WHERE id = ?", this.visitId).run();
      this.log(`Email sent to ${to.join(", ")}`);
    } catch (err) {
      await this.db("UPDATE visits SET status = 'failed', error = ? WHERE id = ?", String(err), this.visitId).run();
      this.log(`Email failed: ${err}`);
    }
  }

  // ---- helpers ----
  private get visitId() {
    return this.state.visitId!;
  }

  private db(sql: string, ...params: unknown[]) {
    return this.env.DB.prepare(sql).bind(...params);
  }

  private log(line: string) {
    this.setState({ ...this.state, log: [...this.state.log, `${new Date().toISOString()} ${line}`] });
  }
}

// ---------- types & small utilities ----------

export type VisitRow = {
  id: string; created_at: string; user_email: string; client_email: string; recipients: string; site_name: string | null;
  status: string; error: string | null; email_sent_at: string | null;
  email_subject: string | null; email_message: string | null; prepared_by: string | null; company: string | null;
};
export type ProductRow = {
  id: string; visit_id: string; room: string; manufacturer: string | null; product_name: string; product_code: string | null;
  container_type: string; container_material: string; container_size: string | null;
  inner_type: string | null; inner_count: number | null; inner_size: string | null; quantity: number; count_note: string | null; count_edited: number;
  physical_state: string | null; signal_word: string | null; hazard_class: string | null; un_number: string | null;
  confirmed: number; removed: number;
  hazard_statements: string; ghs_pictograms: string; ingredients: string; photo_keys: string;
  sds_status: string; sds_source: string | null; sds_url: string | null; sds_page_url: string | null;
  sds_key: string | null; sds_notes: string | null;
};
type LibraryRow = { id: string; r2_key: string; source_url: string; page_url: string | null };
type Attachment = { content: string; filename: string; content_type: string };

const toKnown = (k: ProductRow): KnownProduct => ({
  id: k.id, manufacturer: k.manufacturer, productName: k.product_name, productCode: k.product_code,
  containerType: k.container_type, containerSize: k.container_size, innerType: k.inner_type, quantity: k.quantity,
});

/** Everyone the report goes to. Visits from before the recipients column only have the two email fields. */
const recipientsOf = (v: VisitRow): string[] => {
  const list = JSON.parse(v.recipients) as string[];
  return list.length ? list : [...new Set([v.user_email, v.client_email].filter(Boolean))];
};

const maxOrNull = (a: number | null, b: number | null) => (a == null ? b : b == null ? a : Math.max(a, b));

/** "~50 aerosol, 12 oz each" for a packed box/drum, or "" */
export const contentsText = (p: Pick<ProductRow, "inner_type" | "inner_count" | "inner_size">) =>
  p.inner_type || p.inner_count != null
    ? `contains ${p.inner_count != null ? `~${p.inner_count} ` : ""}${p.inner_type ?? "items"}${p.inner_size ? `, ${p.inner_size} each` : ""}`
    : "";

/** Merges a JSON array column with new values, without duplicates. */
const union = (json: string, add: string[]) => JSON.stringify([...new Set([...JSON.parse(json), ...add])]);

/** "Clorox | Scentiva Wipes, Coconut" -> "clorox|scentivawipescoconut" */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9|]/g, "");

/** Fetches a URL and returns it only if it really is a PDF. */
async function downloadPdf(url: string): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (ManifestZero SDS fetcher)" }, redirect: "follow" });
    if (!res.ok) return null;
    const bytes = await res.arrayBuffer();
    const isPdf = new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-";
    return isPdf && bytes.byteLength <= MAX_PDF_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

const safeFilename = (s: string) => s.replace(/[^\w\s.&()-]/g, "").slice(0, 80).trim();

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The email body: brand header, a summary, the technician's message, then what's attached and what isn't.
 * Email-safe: tables and inline styles only, no images (often blocked) and no CSS gradients (Gmail drops them). */
export function emailHtml(visit: VisitRow, products: ProductRow[], message: string, attached: Set<string>, appUrl: string) {
  const font = "font-family:Inter,'Segoe UI',system-ui,-apple-system,sans-serif";
  const muted = "color:#5a6372;font-size:13px";
  const link = "color:#1c5fe4";
  const rooms = new Set(products.map((p) => p.room)).size;
  const withSds = products.filter((p) => p.sds_key).length;
  const sdsFiles = new Set(products.map((p) => p.sds_key).filter((k) => k && attached.has(k))).size;
  const from = [visit.prepared_by, visit.company].filter(Boolean).join(", ") || visit.user_email;
  const site = visit.site_name ? ` – ${esc(visit.site_name)}` : "";

  const stat = (v: string | number, label: string) =>
    `<td style="padding:10px 10px;background:#f5f6f8;border-radius:8px;width:25%"><div style="font-size:20px;font-weight:700;color:#041d3e">${v}</div><div style="${muted}">${label}</div></td>`;
  const item = (name: string, note: string) =>
    `<tr><td style="padding:6px 0;font-size:14px;vertical-align:top;width:22px;color:#194a25">&#10003;</td><td style="padding:6px 0;font-size:14px"><b>${name}</b><br><span style="${muted}">${note}</span></td></tr>`;

  // SDS we have but couldn't attach (size limit): a public download link. None found: the maker's page if we know it.
  const tooBig = products.filter((p) => p.sds_key && !attached.has(p.sds_key));
  const missing = products.filter((p) => !p.sds_key);
  const notes = [
    ...tooBig.map((p) => `${esc(p.product_name)}: <a href="${esc(`${appUrl}/api/files/${p.sds_key}`)}" style="${link}">download SDS</a> (too large to attach)`),
    ...missing.map((p) => {
      const page = p.sds_page_url ?? p.sds_url;
      return `${esc(p.product_name)}: no SDS found online${page ? ` – <a href="${esc(page)}" style="${link}">manufacturer's page</a>` : ""}`;
    }),
  ];

  return `<div style="background:#f5f6f8;padding:24px 12px;${font}">
  <div style="max-width:620px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #d9dce1;color:#0f151f">
    <div style="background:#041d3e;color:#ffffff;padding:20px 24px">
      <div style="font-size:14px;font-weight:700">Manifest0 <span style="color:#f3bf2b">AI</span></div>
      <div style="font-size:22px;font-weight:700;margin-top:10px">Chemical inventory${site}</div>
      <div style="font-size:13px;color:#c9d3e3;margin-top:4px">Prepared by ${esc(from)} · ${esc(visit.created_at.slice(0, 10))}</div>
    </div>
    <div style="height:5px;background:#f3bf2b;line-height:5px;font-size:0">&nbsp;</div>
    <div style="padding:14px 18px 4px">
      <table cellspacing="6" cellpadding="0" style="width:100%"><tr>
        ${stat(products.length, products.length === 1 ? "product" : "products")}${stat(rooms, rooms === 1 ? "room" : "rooms")}${stat(products.reduce((a, p) => a + p.quantity, 0), "containers")}${stat(`${withSds}/${products.length}`, "SDS found")}
      </tr></table>
    </div>
    <div style="padding:8px 24px 0">${messageHtml(message)}</div>
    <div style="margin:0 24px;padding:14px 16px;border:1px solid #d9dce1;border-radius:8px">
      <div style="font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#5a6372;margin-bottom:4px">Attached</div>
      <table cellspacing="0" cellpadding="0" style="width:100%">
        ${item("Inventory report (PDF)", "Every product by room, with container counts, EPA manifest codes and DOT hazard classes.")}
        ${item("Inventory spreadsheet (CSV)", "The same inventory, ready for Excel or Google Sheets.")}
        ${sdsFiles ? item(`Safety Data Sheets (${sdsFiles} PDF${sdsFiles === 1 ? "" : "s"})`, "One per product, as published by the manufacturer.") : ""}
      </table>
      ${notes.length ? `<div style="margin-top:10px;padding:10px 12px;background:#fdf0d5;border-radius:6px;font-size:13px;color:#8a4b00">
        <b>Not attached</b><br>${notes.join("<br>")}</div>` : ""}
    </div>
    <div style="padding:20px 24px 24px;${muted}">
      Reply to this email to reach ${esc(visit.prepared_by || visit.user_email)}.<br>
      Product data was read from label photos by AI and checked by the technician. Verify against the SDS before disposal.
    </div>
  </div>
  <div style="text-align:center;font-size:12px;color:#5a6372;margin-top:14px">Sent with <a href="https://manifest0ai.com" style="color:#5a6372">Manifest0 AI</a></div>
</div>`;
}

/** The email the technician sees on the review screen before sending; they can edit both. */
export function defaultEmail(visit: VisitRow, products: ProductRow[]) {
  const site = visit.site_name ?? "the site";
  const rooms = new Set(products.map((p) => p.room)).size;
  const missing = products.filter((p) => !p.sds_key).map((p) => p.product_name);
  const withSds = products.length - missing.length;
  const sdsLine =
    !products.length ? ""
    : !withSds ? ` We couldn't find Safety Data Sheets online for these products; the report marks them.`
    : withSds === 1 && products.length === 1 ? ` and the Safety Data Sheet.`
    : ` and the Safety Data Sheets for ${withSds === products.length ? `all ${withSds}` : `${withSds} of ${products.length}`} products.` +
      (missing.length ? ` We couldn't find one online for ${listOf(missing)}; the report marks ${missing.length === 1 ? "it" : "them"}.` : "");
  return {
    subject: `Chemical inventory – ${site} (${plural(products.length, "product")})`,
    message:
      `Hello,\n\n` +
      `Here is the chemical inventory for ${site}: ${plural(products.length, "product")} in ${plural(rooms, "room")}.\n\n` +
      `Attached are the inventory report (PDF), a spreadsheet you can open in Excel` +
      (sdsLine.startsWith(" and") ? sdsLine : `.${sdsLine}`) + `\n\n` +
      `Best regards,\n${signature(visit)}`,
  };
}

/** Name and company; just the email when the technician set neither. */
const signature = (v: VisitRow) => [v.prepared_by, v.company].filter(Boolean).join("\n") || v.user_email;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "A", "A and B", "A, B and C", "A, B, C and 4 more" */
const listOf = (names: string[]) => {
  const shown = names.slice(0, 3);
  const more = names.length - shown.length;
  const head = more ? shown : shown.slice(0, -1);
  const tail = more ? `${more} more` : shown.at(-1)!;
  return head.length ? `${head.join(", ")} and ${tail}` : tail;
};

/** The technician's message as HTML, above the inventory table. */
export const messageHtml = (text: string) =>
  `<div style="font-size:15px;line-height:1.55;margin-bottom:20px">${
    text.trim().split(/\n{2,}/).map((para) => `<p>${esc(para).replace(/\n/g, "<br>")}</p>`).join("")}</div>`;

/** The inventory as CSV (opens in Excel / Google Sheets). */
export function inventoryCsv(products: ProductRow[]) {
  const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = ["Room", "Manufacturer", "Product", "Product code", "Containers", "Container type", "Container material",
    "Container size", "Contents", "EPA manifest (Item 10)", "DOT hazard class", "UN number", "Signal word", "Hazards", "SDS"];
  const rows = products.map((p) => {
    const m = manifestCode(p.container_type, p.container_material);
    return [p.room, p.manufacturer, p.product_name, p.product_code, p.quantity, p.container_type, p.container_material,
      p.container_size, contentsText(p), m.code ? `${p.quantity} ${m.code}` : m.hint, p.hazard_class, p.un_number, p.signal_word,
      (JSON.parse(p.hazard_statements) as string[]).join("; "), p.sds_key ? "Attached" : p.sds_page_url ?? p.sds_url ?? "Not found"];
  });
  return [head, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
}
