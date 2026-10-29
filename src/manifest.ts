// Container type codes for Item 10 of the EPA Uniform Hazardous Waste Manifest (Form 8700-22).
// The code describes the container the waste is SHIPPED in, so it depends on type and material.

export const MANIFEST_CODES = {
  BA: "Burlap, cloth, paper or plastic bags",
  CF: "Fiber or plastic boxes, cartons, cases",
  CM: "Metal boxes, cartons, cases (including roll-offs)",
  CW: "Wooden boxes, cartons, cases",
  CY: "Cylinders",
  DF: "Fiberboard or plastic drums, barrels, kegs",
  DM: "Metal drums, barrels, kegs",
  DW: "Wooden drums, barrels, kegs",
  TP: "Portable tanks",
} as const;
export type ManifestCode = keyof typeof MANIFEST_CODES;

export const CONTAINER_MATERIALS = ["metal", "plastic", "fiber", "wood", "glass", "unknown"] as const;
export type ContainerMaterial = (typeof CONTAINER_MATERIALS)[number];

/**
 * Manifest code for a container, or null with the reason when there isn't one yet:
 * small containers are lab-packed into a drum or box at pickup, and that outer container gets the code.
 */
export function manifestCode(type: string, material: string): { code: ManifestCode | null; hint: string | null } {
  const pick = (code: ManifestCode) => ({ code, hint: null });
  switch (type) {
    case "drum":
    case "pail":
      if (material === "metal") return pick("DM");
      if (material === "plastic" || material === "fiber") return pick("DF");
      if (material === "wood") return pick("DW");
      return { code: null, hint: "DM if metal, DF if plastic/fiber" };
    case "box":
      if (material === "metal") return pick("CM");
      if (material === "wood") return pick("CW");
      if (material === "fiber" || material === "plastic") return pick("CF");
      return { code: null, hint: "CF if cardboard/plastic, CM if metal" };
    case "bag":
      return pick("BA");
    case "cylinder":
      return pick("CY");
    case "tote":
      return pick("TP");
    default:
      return { code: null, hint: "lab pack: code set by the drum/box it's packed in" };
  }
}
