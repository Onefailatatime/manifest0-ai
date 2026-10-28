import { Agent } from "agents";
import { Buffer } from "node:buffer";
import { manifestCode } from "./manifest";
import { extractProducts, findSds, type KnownProduct } from "./muse";

// One VisitAgent per site visit, named by the visit id. It lives for the whole visit:
// the technician adds photos room by room, and the agent remembers every product it has
// already catalogued, so overlapping photos update a product instead of duplicating it.
//
// Queue (durable, one item at a time, in order):
//   processBatch (per upload)  ->  findSds (per new product)  ->  sendReport (after Finish)

type VisitState = { visitId: string | null; appUrl: string; log: string[] };

const MAX_PDF_BYTES = 10 * 1024 * 1024;
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
               signal_word = ?, quantity = ?, count_note = ?, hazard_statements = ?, ghs_pictograms = ?, ingredients = ?,
               photo_keys = ? WHERE id = ?`,
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
               physical_state, signal_word, hazard_statements, ghs_pictograms, ingredients, photo_keys)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            id, this.visitId, room, p.manufacturer, p.productName, p.productCode, p.containerType, p.containerMaterial,
            p.containerSize, p.innerType, p.innerCount, p.innerSize,
            Math.max(1, p.quantity), p.countNote, p.physicalState, p.signalWord, JSON.stringify(p.hazardStatements), JSON.stringify(p.ghsPictograms),
            JSON.stringify(p.ingredients), JSON.stringify(keys),
          ));
        }
      }
      statements.push(this.db("UPDATE photos SET processed = 1 WHERE batch_id = ?", batchId));
      await this.env.DB.batch(statements);

      this.log(`${room}: ${newIds.length} new product(s), ${updated} already known`);
      for (const productId of newIds) await this.queue("findSds", { productId });
    } catch (err) {
      await this.db("UPDATE photos SET processed = 2 WHERE batch_id = ?", batchId).run();
      this.log(`${room}: failed to read photos: ${err}`);
    }
  }

  // ---- Step 2: SDS — from the shared library if we've seen this product before, else web search ----
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
            + (SELECT COUNT(*) FROM products WHERE visit_id = ?1 AND sds_status = 'pending') AS n`, this.visitId,
    ).first<{ n: number }>();
    if (pending!.n > 0) {
      await this.queue("sendReport", {});
      return;
    }

    try {
      const visit = (await this.db("SELECT * FROM visits WHERE id = ?", this.visitId).first<VisitRow>())!;
      const { results: products } = await this.db(
        "SELECT * FROM products WHERE visit_id = ? ORDER BY room, product_name", this.visitId,
      ).all<ProductRow>();

      // Attach each distinct PDF until we hit the size limit; the rest are linked in the email.
      const attachments: Attachment[] = [];
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

      const visitUrl = `${this.state.appUrl}/?visit=${this.visitId}`;
      const to = [...new Set([visit.user_email, visit.client_email])];
      const html = reportHtml(visit, products, attachedKeys, this.state.appUrl, visitUrl);

      if (!this.env.RESEND_API_KEY) {
        // No email provider configured (e.g. local dev): keep the report so it can be opened in the browser.
        const key = `visits/${this.visitId}/report.html`;
        await this.env.FILES.put(key, html, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
        await this.db("UPDATE visits SET status = 'done' WHERE id = ?", this.visitId).run();
        this.log(`RESEND_API_KEY not set, email not sent. Report: /api/files/${key} (${attachments.length} PDFs would be attached)`);
        return;
      }

      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: this.env.EMAIL_FROM,
          to,
          reply_to: visit.user_email,
          subject: `Chemical inventory${visit.site_name ? ` – ${visit.site_name}` : ""} (${products.length} products)`,
          html,
          text: `Chemical inventory with ${products.length} products. View online: ${visitUrl}`,
          attachments,
        }),
      });
      if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);

      await this.db("UPDATE visits SET status = 'done', email_sent_at = datetime('now') WHERE id = ?", this.visitId).run();
      this.log(`Email sent to ${to.join(" and ")}`);
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
  id: string; created_at: string; user_email: string; client_email: string; site_name: string | null;
  status: string; error: string | null; email_sent_at: string | null;
};
export type ProductRow = {
  id: string; visit_id: string; room: string; manufacturer: string | null; product_name: string; product_code: string | null;
  container_type: string; container_material: string; container_size: string | null;
  inner_type: string | null; inner_count: number | null; inner_size: string | null; quantity: number; count_note: string | null; count_edited: number;
  physical_state: string | null; signal_word: string | null;
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

const maxOrNull = (a: number | null, b: number | null) => (a == null ? b : b == null ? a : Math.max(a, b));

/** "~50 aerosol, 12 oz each" for a packed box/drum, or "" */
export const contentsText = (p: Pick<ProductRow, "inner_type" | "inner_count" | "inner_size">) =>
  p.inner_type
    ? `contains ${p.inner_count != null ? `~${p.inner_count} ` : ""}${p.inner_type}${p.inner_size ? `, ${p.inner_size} each` : ""}`
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

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function reportHtml(visit: VisitRow, products: ProductRow[], attached: Set<string>, appUrl: string, visitUrl: string) {
  const rows = products.map((p) => {
    const manifest = manifestCode(p.container_type, p.container_material);
    const hazards = (JSON.parse(p.hazard_statements) as string[]).join("<br>");
    const sds =
      p.sds_key && attached.has(p.sds_key) ? "Attached"
      : p.sds_key ? `<a href="${esc(`${appUrl}/api/files/${p.sds_key}`)}">Download</a>`
      : p.sds_page_url || p.sds_url ? `<a href="${esc(p.sds_page_url ?? p.sds_url)}">Manufacturer page</a>`
      : "Not found";
    return `<tr>
      <td>${esc(p.room)}</td><td>${esc(p.manufacturer)}</td>
      <td><b>${esc(p.product_name)}</b><br><small>${esc(p.product_code)}</small></td>
      <td><b>${p.quantity} × ${esc(p.container_type)}</b>${p.container_size ? `<br><small>${esc(p.container_size)}</small>` : ""}${
        p.inner_type ? `<br><small>${esc(contentsText(p))}</small>` : ""}${
        p.count_note ? `<br><small><i>${esc(p.count_note)}</i></small>` : ""}</td>
      <td>${manifest.code ? `<b>${p.quantity} ${manifest.code}</b>` : `<small>${esc(manifest.hint)}</small>`}</td>
      <td>${esc(p.signal_word)}</td>
      <td><small>${hazards}</small></td><td>${sds}</td>
    </tr>`;
  }).join("");
  return `<div style="font-family:system-ui,sans-serif">
    <h2>Chemical inventory${visit.site_name ? ` – ${esc(visit.site_name)}` : ""}</h2>
    <p>Prepared by ${esc(visit.user_email)} on ${esc(visit.created_at)} UTC. <a href="${esc(visitUrl)}">View online</a></p>
    <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:14px">
      <tr><th>Room</th><th>Manufacturer</th><th>Product</th><th>Containers</th><th>Manifest (Item 10)</th><th>Signal word</th><th>Hazards</th><th>SDS</th></tr>
      ${rows}
    </table>
    <p style="color:#666;font-size:12px">Product data was read from label photos by AI. Verify against the attached SDS before disposal.</p>
  </div>`;
}
