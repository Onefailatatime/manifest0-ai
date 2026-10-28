// Talks to Meta's Model API (Responses endpoint) — Muse Spark.

import { CONTAINER_MATERIALS, type ContainerMaterial } from "./manifest";

const API = "https://api.meta.ai/v1/responses";

type Env = { MODEL_API_KEY: string; MUSE_MODEL: string };

async function respond<T>(env: Env, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(API, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.MODEL_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: env.MUSE_MODEL, ...body }),
  });
  const json: any = await res.json();
  if (!res.ok || json.error) throw new Error(`Muse ${res.status}: ${JSON.stringify(json.error ?? json)}`);

  // The final answer is the last "message" item in output (earlier ones are progress commentary).
  const messages = (json.output ?? []).filter((o: any) => o.type === "message");
  const text = messages.at(-1)?.content?.find((c: any) => c.type === "output_text")?.text;
  if (!text) throw new Error(`Muse returned no text (status ${json.status})`);
  return JSON.parse(text) as T;
}

// Forces Muse to reply with JSON matching a schema.
const jsonFormat = (name: string, schema: object) => ({
  format: { type: "json_schema", name, strict: true, schema },
});

const str = { type: "string" };
const strOrNull = { type: ["string", "null"] };
const strList = { type: "array", items: str };

export type ExtractedProduct = {
  manufacturer: string | null;
  productName: string;
  productCode: string | null;
  containerType: ContainerType;
  containerMaterial: ContainerMaterial;
  containerSize: string | null;
  innerType: ContainerType | null;
  innerCount: number | null;
  innerSize: string | null;
  countNote: string | null;
  physicalState: "solid" | "liquid" | "gas" | "aerosol" | "unknown";
  signalWord: "DANGER" | "WARNING" | "none";
  hazardStatements: string[];
  ghsPictograms: string[];
  ingredients: string[];
  quantity: number;
  imageIndexes: number[];
  matchesProductId: string | null;
};

export const CONTAINER_TYPES = [
  "drum", "pail", "jug", "bottle", "can", "aerosol", "box", "bag", "tote", "cylinder", "tube", "other",
] as const;
export type ContainerType = (typeof CONTAINER_TYPES)[number];

/** A product already catalogued in this room, shown to Muse so it can recognise repeats. */
export type KnownProduct = {
  id: string;
  manufacturer: string | null;
  productName: string;
  productCode: string | null;
  containerType: string;
  containerSize: string | null;
  innerType: string | null;
  quantity: number;
};

const productSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "manufacturer", "productName", "productCode", "containerType", "containerMaterial", "containerSize",
    "innerType", "innerCount", "innerSize", "countNote", "physicalState",
    "signalWord", "hazardStatements", "ghsPictograms", "ingredients", "quantity", "imageIndexes", "matchesProductId",
  ],
  properties: {
    manufacturer: strOrNull,
    productName: str,
    productCode: { ...strOrNull, description: "EPA Reg. No., product/item code or UPC, if printed" },
    containerType: {
      type: "string",
      enum: CONTAINER_TYPES,
      description:
        "the OUTER container that would be picked up: drum/barrel (30-55 gal), pail/bucket (1-5 gal), jug, bottle, " +
        "can (metal, non-aerosol), aerosol (spray can), box/carton, bag/sack, tote (IBC), cylinder (gas), tube. " +
        "If small items of this product are packed in a box or drum, this is \"box\"/\"drum\", not the items.",
    },
    containerMaterial: {
      type: "string",
      enum: CONTAINER_MATERIALS,
      description: "what the outer container is made of (fiber = cardboard/fiberboard); unknown if you can't tell",
    },
    containerSize: {
      ...strOrNull,
      description:
        "capacity of the outer container, e.g. \"55 gal\", \"5 gal\", \"NET 2 QT (64 FL OZ)\". Not how full it is. " +
        "If not printed but it's a standard size (55 gal drum, 5 gal pail), give it with \"~\", e.g. \"~55 gal\"",
    },
    innerType: {
      type: ["string", "null"],
      enum: [...CONTAINER_TYPES, null],
      description: "only when the outer container is a box/drum packed with small items of this product: what the items are; else null",
    },
    innerCount: {
      type: ["integer", "null"],
      description: "only for a packed box/drum: estimated number of items inside (from what's visible, the box's printed count, or its size); else null",
    },
    innerSize: { ...strOrNull, description: "only for a packed box/drum: size of one item as printed, e.g. \"12 oz\"; else null" },
    countNote: {
      ...strOrNull,
      description: "only if the count is uncertain, say why, e.g. \"pallet partly hidden, at least 6\" or \"boxes stacked, 2 rows visible\"",
    },
    physicalState: { type: "string", enum: ["solid", "liquid", "gas", "aerosol", "unknown"] },
    signalWord: { type: "string", enum: ["DANGER", "WARNING", "none"] },
    hazardStatements: strList,
    ghsPictograms: { ...strList, description: "e.g. flame, corrosion, exclamation mark, health hazard" },
    ingredients: { ...strList, description: "active/hazardous ingredients with % if shown" },
    quantity: {
      type: "integer",
      description:
        "number of separate containers of this product (of this containerType and size) in these photos. " +
        "Count each physical container once, even if it appears in several overlapping photos. " +
        "Count closed boxes as boxes, not their contents.",
    },
    imageIndexes: { type: "array", items: { type: "integer" }, description: "0-based indexes of the photos showing this product" },
    matchesProductId: { ...strOrNull, description: "id of the already-catalogued product this is, or null if it's new" },
  },
};

/**
 * Reads a batch of label photos from one room.
 * Several photos may show the same product (front/back, overlapping shots) — they're merged into one.
 * Products already catalogued in this room are passed in so Muse can say "this is product X again".
 */
export async function extractProducts(env: Env, images: { mime: string; base64: string }[], known: KnownProduct[]) {
  const knownList = known.length
    ? `Products ALREADY catalogued in this room (from earlier photos):\n${JSON.stringify(known)}\n` +
      `If a product in these new photos is one of these, set matchesProductId to its id ` +
      `(same manufacturer, product, container type and size). Otherwise matchesProductId is null. ` +
      `For a match, quantity is the number of containers visible in THESE photos; containers already counted earlier ` +
      `may appear again, so don't add them twice.\n`
    : `Nothing has been catalogued in this room yet, so matchesProductId is always null.\n`;

  const result = await respond<{ products: ExtractedProduct[] }>(env, {
    input: [{
      role: "user",
      content: [
        {
          type: "input_text",
          text:
            `You are cataloguing chemical products for a hazardous-waste inventory, walking through a site room by room. ` +
            `Below are ${images.length} new photo(s) from one room, numbered from 0 in order. Photos may overlap. ` +
            `Identify every distinct product. Photos of the same product (e.g. front and back label) must be merged into ONE product. ` +
            `The same product in different container types or sizes (one drum and three jugs) is separate products. ` +
            `Small items (bottles, cans, aerosols) are often packed into a box or drum: then the product is the box/drum ` +
            `(containerType box/drum, quantity = number of boxes) with innerType/innerCount describing the items inside. ` +
            `A photo of a packed box and a photo of one item's label from it are the SAME product. ` +
            `Small items standing loose (not in a box) are counted individually with innerType null. ` +
            `For the waste pickup, the count and container type matter as much as the label: count carefully. ` +
            `Copy text exactly as printed; use null when something isn't visible. Don't guess.\n\n` + knownList,
        },
        ...images.map((img) => ({ type: "input_image", image_url: `data:${img.mime};base64,${img.base64}` })),
      ],
    }],
    text: jsonFormat("products", {
      type: "object",
      additionalProperties: false,
      required: ["products"],
      properties: { products: { type: "array", items: productSchema } },
    }),
  });
  return result.products;
}

export type SdsSearchResult = {
  pdfUrl: string | null;
  pageUrl: string | null;
  isSds: boolean;
  confidence: "high" | "medium" | "low";
  notes: string;
};

/** Web-searches for the product's official Safety Data Sheet. */
export async function findSds(env: Env, p: { manufacturer: string | null; productName: string; productCode: string | null }) {
  return respond<SdsSearchResult>(env, {
    tools: [{ type: "web_search" }],
    input:
      `Find the official Safety Data Sheet (SDS) PDF for this product:\n` +
      `Manufacturer: ${p.manufacturer ?? "unknown"}\nProduct: ${p.productName}\n` +
      (p.productCode ? `Code/EPA Reg. No.: ${p.productCode}\n` : "") +
      `Prefer the manufacturer's own website and the US version. Open the PDF to confirm it's the right product. ` +
      `pdfUrl must be a direct link to the PDF file; if you only find a page that links to it, give pageUrl. ` +
      `Only a real Safety Data Sheet counts (titled "Safety Data Sheet" or "Material Safety Data Sheet", with numbered GHS sections). ` +
      `Ingredient disclosures, product spec sheets and labels are NOT SDSs — set isSds to false for those.`,
    text: jsonFormat("sds", {
      type: "object",
      additionalProperties: false,
      required: ["pdfUrl", "pageUrl", "isSds", "confidence", "notes"],
      properties: {
        pdfUrl: strOrNull,
        pageUrl: strOrNull,
        isSds: { type: "boolean", description: "true only if pdfUrl is a genuine Safety Data Sheet for this product" },
        confidence: { type: "string", enum: ["high", "medium", "low"] },
        notes: str,
      },
    }),
  });
}
