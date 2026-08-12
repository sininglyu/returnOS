// Tier 1 of the parsing pipeline (see plan): pulls schema.org Order/Product
// structured data directly out of an email's raw HTML — no network call,
// free, deterministic. A "miss" here (null) means lib/parse.ts falls
// through to Tier 2 (an LLM, not yet built) or, if that's unconfigured,
// skips the email entirely.
//
// JSON-LD (<script type="application/ld+json">) is the primary path — most
// major retailers use it. Microdata (itemtype="https://schema.org/Order")
// is a best-effort secondary path: proper microdata parsing needs a real
// HTML parser (element-scope boundaries), which isn't worth a new
// dependency for what's expected to be a rare fallback. It's a bounded
// regex scan, not spec-compliant — revisit if real inbox data shows it
// matters more than expected.
//
// IMPORTANT: never log email content here. This module doesn't log at all
// — the caller (lib/parse.ts) logs message IDs and outcomes only.

import type { ParseResult } from "./schemas";

type PurchaseFields = Extract<ParseResult, { isPurchase: true }>;
type JsonLdNode = Record<string, unknown>;

function getString(node: JsonLdNode, key: string): string | undefined {
  const v = node[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

function getNode(node: JsonLdNode, key: string): JsonLdNode | undefined {
  const v = node[key];
  if (Array.isArray(v)) {
    const first = v[0];
    return first && typeof first === "object"
      ? (first as JsonLdNode)
      : undefined;
  }
  return v && typeof v === "object" ? (v as JsonLdNode) : undefined;
}

function getNumber(node: JsonLdNode, key: string): number | null {
  const v = node[key];
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function firstString(...values: (string | undefined)[]): string | undefined {
  return values.find((v) => v !== undefined);
}

function schemaType(node: JsonLdNode): string[] {
  const t = node["@type"];
  const arr = Array.isArray(t) ? t : [t];
  return arr.filter((v): v is string => typeof v === "string");
}

function isType(node: JsonLdNode, name: "Order" | "Product"): boolean {
  return schemaType(node).some((t) => t.toLowerCase() === name.toLowerCase());
}

// Depth-first search through a parsed JSON-LD document (which may be a
// single node, an array of nodes, or a node with an @graph array) for the
// first Order or Product node.
function findOrderOrProductNode(value: unknown): JsonLdNode | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findOrderOrProductNode(item);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const node = value as JsonLdNode;
  if (isType(node, "Order") || isType(node, "Product")) return node;
  if (node["@graph"]) return findOrderOrProductNode(node["@graph"]);
  return null;
}

// Maps a found Order or Product JSON-LD node onto our field shape. Field
// paths vary by retailer (e.g. price shows up under acceptedOffer.price,
// orderedItem.offers.price, or partOfInvoice.totalPaymentDue.price
// depending on the site), so this probes a few common shapes defensively
// rather than assuming one exact layout.
function mapJsonLdNode(node: JsonLdNode): Partial<PurchaseFields> {
  const orderedItem = getNode(node, "orderedItem");
  const seller = getNode(node, "seller") ?? getNode(node, "merchant");
  const brand = orderedItem && getNode(orderedItem, "brand");
  const offers = (orderedItem && getNode(orderedItem, "offers")) ?? getNode(node, "acceptedOffer");
  const invoice = getNode(node, "partOfInvoice");
  const totalPaymentDue = invoice && getNode(invoice, "totalPaymentDue");
  const priceNode = offers ?? totalPaymentDue ?? node;

  const isOrder = isType(node, "Order");

  return {
    retailer: firstString(
      seller && getString(seller, "name"),
      brand && getString(brand, "name"),
      !isOrder ? getString(node, "name") : undefined,
    ),
    itemName: firstString(
      orderedItem && getString(orderedItem, "name"),
      isOrder ? undefined : getString(node, "name"),
    ),
    orderDate: getString(node, "orderDate"),
    orderNumber: getString(node, "orderNumber"),
    price: getNumber(priceNode, "price"),
    currency: firstString(
      getString(priceNode, "priceCurrency"),
    ) ?? null,
  };
}

const JSON_LD_SCRIPT_RE =
  /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

function extractJsonLdPurchase(html: string): Partial<PurchaseFields> | null {
  const matches = html.matchAll(JSON_LD_SCRIPT_RE);
  for (const match of matches) {
    // A handful of sites incorrectly HTML-escape their JSON-LD payload -
    // undo the one entity that actually breaks JSON.parse.
    const raw = match[1].replace(/&amp;/g, "&");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const node = findOrderOrProductNode(parsed);
    if (node) return mapJsonLdNode(node);
  }
  return null;
}

const MICRODATA_TYPE_RE =
  /itemtype=["']https?:\/\/schema\.org\/(Order|Product)["']/i;
const MICRODATA_WINDOW = 5000; // chars scanned after the itemtype match

// Best-effort only - see file header. Doesn't respect itemscope
// boundaries, so a nested itemscope's props can bleed in; acceptable for
// a secondary fallback path.
function extractMicrodataPurchase(html: string): Partial<PurchaseFields> | null {
  const typeMatch = MICRODATA_TYPE_RE.exec(html);
  if (!typeMatch) return null;

  const window = html.slice(
    typeMatch.index,
    typeMatch.index + MICRODATA_WINDOW,
  );

  const prop = (name: string): string | undefined => {
    const contentRe = new RegExp(
      `itemprop=["']${name}["'][^>]*content=["']([^"']*)["']`,
      "i",
    );
    const contentMatch = contentRe.exec(window);
    if (contentMatch?.[1]) return contentMatch[1].trim();

    const textRe = new RegExp(`itemprop=["']${name}["'][^>]*>([^<]*)<`, "i");
    const textMatch = textRe.exec(window);
    return textMatch?.[1]?.trim() || undefined;
  };

  const priceRaw = prop("price");
  const price = priceRaw !== undefined ? Number(priceRaw) : NaN;

  return {
    retailer: firstString(prop("seller"), prop("brand")),
    itemName: prop("name"),
    orderDate: prop("orderDate"),
    orderNumber: prop("orderNumber"),
    price: Number.isFinite(price) ? price : null,
    currency: firstString(prop("priceCurrency")) ?? null,
  };
}

export function extractStructuredPurchase(html: string): ParseResult | null {
  if (!html) return null;

  const fields = extractJsonLdPurchase(html) ?? extractMicrodataPurchase(html);
  if (!fields) return null;

  // No partial results - all three required fields must be present, or
  // this is a miss (caller falls through to Tier 2 / skips).
  if (!fields.retailer || !fields.itemName || !fields.orderDate) {
    return null;
  }

  return {
    isPurchase: true,
    retailer: fields.retailer,
    itemName: fields.itemName,
    orderDate: fields.orderDate,
    price: fields.price ?? null,
    currency: fields.currency ?? null,
    orderNumber: fields.orderNumber ?? null,
    returnDeadline: fields.returnDeadline ?? null,
  };
}
