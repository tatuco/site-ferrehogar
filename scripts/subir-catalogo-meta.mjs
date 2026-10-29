#!/usr/bin/env node
/**
 * Sube el catálogo local a Meta para usarlo en WhatsApp Business.
 *
 * Flujo oficial:
 * 1. Catálogo de Commerce (Commerce Manager o POST /{business-id}/owned_product_catalogs).
 * 2. Alta de productos: POST /{catalog-id}/items_batch  (item_type=PRODUCT_ITEM).
 * 3. Estado del lote: GET /{catalog-id}/check_batch_request_status.
 * 4. Vincular a WhatsApp: POST /{whatsapp-business-account-id}/product_catalogs.
 *    Un catálogo por jerarquía de WhatsApp.
 *
 * Docs:
 * - https://developers.facebook.com/docs/whatsapp/cloud-api/guides/sell-products-and-services/upload-inventory
 * - https://developers.facebook.com/docs/marketing-api/reference/product-catalog/items_batch
 * - https://developers.facebook.com/docs/marketing-api/catalog/reference
 * - https://developers.facebook.com/docs/marketing-api/reference/product-catalog/check_batch_request_status
 * - https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account/product_catalogs/
 * - https://developers.facebook.com/docs/marketing-api/reference/business/owned_product_catalogs/
 *
 * Requiere Node.js 18 o superior (fetch nativo). Sin dependencias.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AVAILABILITY = new Set([
  "in stock",
  "out of stock",
  "available for order",
  "discontinued",
]);
const CONDITIONS = new Set(["new", "refurbished", "used"]);
const TERMINAL_STATUS = new Set(["finished", "canceled", "cancelled", "error", "failed"]);
const RETRYABLE_CODES = new Set([1, 2, 4, 17, 613, 80008, 80009, 80014]);
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 9999;
const SHORT_MAX = 100;

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function argValue(args, name) {
  const prefix = `--${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith("--")) {
    return args[index + 1];
  }
  return undefined;
}

function flag(args, name) {
  return args.includes(`--${name}`);
}

function bool(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|si|sí)$/i.test(String(value).trim());
}

function integer(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function required(name, value) {
  if (!value) {
    throw new Error(`Falta ${name} en .env`);
  }
  return value;
}

function clip(value, max) {
  const text = String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
  return text.length <= max ? text : text.slice(0, max).trimEnd();
}

function readable(text) {
  const source = String(text ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (!source) return "";
  const letters = source.replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g, "");
  const normalized =
    letters && letters === letters.toUpperCase() ? source.toLowerCase() : source;
  return normalized.charAt(0).toLocaleUpperCase("es") + normalized.slice(1);
}

function formatPrice(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return "";
  return `${n.toFixed(2)} ${currency}`;
}

function applyTax(amount, cfg) {
  const n = Number(amount);
  if (!Number.isFinite(n) || !cfg.includeIva) return n;
  return Math.round(n * (1 + cfg.ivaRate) * 100) / 100;
}

function fillTemplate(template, product) {
  return String(template)
    .replaceAll("{id}", encodeURIComponent(product.id ?? ""))
    .replaceAll("{codigo}", encodeURIComponent(product.codigo ?? ""))
    .replaceAll("{catalogo}", encodeURIComponent(product.catalogo ?? ""));
}

function isHttp(url) {
  return /^https?:\/\//i.test(url);
}

function isPlaceholderHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "ejemplo.com" || host === "example.com" || host.endsWith(".example.com");
  } catch {
    return false;
  }
}

function joinUrl(base, relative) {
  return `${String(base).replace(/\/+$/, "")}/${String(relative).replace(/^\/+/, "")}`;
}

function gtinOf(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return [8, 12, 13, 14].includes(digits.length) ? digits : "";
}

function chunk(items, size) {
  const batches = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function help() {
  console.log(`Uso:
  node scripts/subir-catalogo-meta.mjs [--dry-run] [--link] [--limit N]

Lee las variables de .env y sube build/catalogo.json a Meta.

  --dry-run   Valida y escribe el reporte, sin llamar a Graph API.
  --link      Asocia el catálogo a WHATSAPP_BUSINESS_ACCOUNT_ID.
  --limit N   Procesa solo los primeros N productos del JSON.
  --imagenes  Ruta del JSON id → URL generado por subir-imagenes-r2.mjs.

Si existe build/imagenes-r2.json, image_link sale de ese mapa.

Documentación:
  https://developers.facebook.com/docs/marketing-api/reference/product-catalog/items_batch
  https://developers.facebook.com/docs/whatsapp/cloud-api/guides/sell-products-and-services/upload-inventory
`);
}

function readConfig(args) {
  const dryRun = flag(args, "dry-run") || bool(process.env.DRY_RUN, false);
  const link = flag(args, "link") || bool(process.env.LINK_WHATSAPP_CATALOG, false);
  const limit = integer(argValue(args, "limit") ?? process.env.LIMIT, 0);
  const batchSize = Math.min(5000, Math.max(1, integer(process.env.BATCH_SIZE, 2000)));
  const method = String(process.env.BATCH_METHOD || "UPDATE").toUpperCase();
  if (!["CREATE", "UPDATE"].includes(method)) {
    throw new Error("BATCH_METHOD debe ser CREATE o UPDATE");
  }
  const availability = process.env.DEFAULT_AVAILABILITY || "available for order";
  if (!AVAILABILITY.has(availability)) {
    throw new Error(
      `DEFAULT_AVAILABILITY debe ser uno de: ${[...AVAILABILITY].join(", ")}`,
    );
  }
  const condition = process.env.DEFAULT_CONDITION || "new";
  if (!CONDITIONS.has(condition)) {
    throw new Error(`DEFAULT_CONDITION debe ser uno de: ${[...CONDITIONS].join(", ")}`);
  }
  const version = process.env.GRAPH_API_VERSION || "v25.0";
  if (!/^v\d+\.\d+$/.test(version)) {
    throw new Error("GRAPH_API_VERSION debe tener la forma v25.0");
  }

  const cfg = {
    dryRun,
    link,
    limit,
    batchSize,
    method,
    allowUpsert: bool(process.env.ALLOW_UPSERT, true),
    availability,
    condition,
    version,
    graphBase: `https://graph.facebook.com/${version}`,
    token: process.env.META_ACCESS_TOKEN || "",
    catalogId: process.env.META_CATALOG_ID || "",
    businessId: process.env.META_BUSINESS_ID || "",
    pageId: process.env.META_PAGE_ID || "",
    catalogName: process.env.CATALOG_NAME || "Ferreteria",
    createCatalog: bool(process.env.CREATE_CATALOG_IF_MISSING, false),
    wabaId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || "",
    catalogPath: path.resolve(ROOT, process.env.CATALOG_PATH || "build/catalogo.json"),
    currency: (process.env.CURRENCY || "").toUpperCase(),
    includeIva: bool(process.env.INCLUDE_IVA, false),
    ivaRate: Number(process.env.IVA_RATE || "0.16"),
    storeBaseUrl: process.env.STORE_BASE_URL || "",
    imageBaseUrl: process.env.IMAGE_BASE_URL || "",
    imagenesR2Path: path.resolve(
      ROOT,
      argValue(args, "imagenes") || process.env.IMAGENES_R2_PATH || "build/imagenes-r2.json",
    ),
    placeholderImageUrl: process.env.PLACEHOLDER_IMAGE_URL || "",
    skipWithoutImage: bool(process.env.SKIP_WITHOUT_IMAGE, true),
    preserveCase: bool(process.env.PRESERVE_CASE, false),
    filterProveedor: (process.env.FILTER_PROVEEDOR || "").trim(),
    filterCatalogo: (process.env.FILTER_CATALOGO || "").trim(),
    pollIntervalMs: Math.max(1000, integer(process.env.POLL_INTERVAL_MS, 5000)),
    pollTimeoutMs: Math.max(5000, integer(process.env.POLL_TIMEOUT_MS, 600000)),
    batchDelayMs: Math.max(0, integer(process.env.BATCH_DELAY_MS, 1000)),
    reportPath: path.resolve(ROOT, process.env.REPORT_PATH || "build/meta-upload-report.json"),
  };

  if (!Number.isFinite(cfg.ivaRate) || cfg.ivaRate < 0) {
    throw new Error("IVA_RATE debe ser un número mayor o igual a 0");
  }
  if (cfg.batchSize > 3000) {
    console.log(
      "Aviso: Meta recomienda menos de 3000 registros por lote. BATCH_SIZE quedó por encima.",
    );
  }
  return cfg;
}

function assertReady(cfg) {
  required("STORE_BASE_URL", cfg.storeBaseUrl);
  if (!isHttp(cfg.storeBaseUrl)) {
    throw new Error("STORE_BASE_URL debe empezar por http:// o https://");
  }
  if (cfg.imageBaseUrl && !isHttp(cfg.imageBaseUrl)) {
    throw new Error("IMAGE_BASE_URL debe empezar por http:// o https://");
  }
  if (cfg.placeholderImageUrl && !isHttp(cfg.placeholderImageUrl)) {
    throw new Error("PLACEHOLDER_IMAGE_URL debe empezar por http:// o https://");
  }
  const publicUrls = [cfg.storeBaseUrl, cfg.imageBaseUrl, cfg.placeholderImageUrl].filter(Boolean);
  if (!cfg.dryRun && publicUrls.some(isPlaceholderHost)) {
    throw new Error(
      "STORE_BASE_URL, IMAGE_BASE_URL o PLACEHOLDER_IMAGE_URL siguen en ejemplo.com. Sustituye esas URLs antes de subir.",
    );
  }
  if (!cfg.dryRun) {
    required("META_ACCESS_TOKEN", cfg.token);
    if (!cfg.catalogId && !(cfg.createCatalog && cfg.businessId)) {
      throw new Error("Define META_CATALOG_ID, o CREATE_CATALOG_IF_MISSING=true con META_BUSINESS_ID");
    }
  }
  if (cfg.link && !cfg.dryRun) required("WHATSAPP_BUSINESS_ACCOUNT_ID", cfg.wabaId);
}

function textOf(product, field) {
  return product?.[field] ? String(product[field]).trim() : "";
}

function presentText(cfg, value, max) {
  const raw = cfg.preserveCase ? String(value ?? "") : readable(value);
  return clip(raw, max);
}

function productLink(cfg, product) {
  const url = fillTemplate(cfg.storeBaseUrl, product);
  return isHttp(url) ? url : "";
}

function loadImageMap(cfg) {
  cfg.imageById = null;
  if (!fs.existsSync(cfg.imagenesR2Path)) return;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(cfg.imagenesR2Path, "utf8"));
  } catch (error) {
    throw new Error(`No se pudo leer ${cfg.imagenesR2Path}: ${error.message}`);
  }
  const imagenes = data?.imagenes;
  if (!imagenes || typeof imagenes !== "object" || Array.isArray(imagenes)) {
    throw new Error(`${path.relative(ROOT, cfg.imagenesR2Path)} no tiene un objeto "imagenes".`);
  }
  cfg.imageById = imagenes;
  console.log(
    `Mapa de imágenes R2: ${Object.keys(imagenes).length} enlaces (${path.relative(ROOT, cfg.imagenesR2Path)}).`,
  );
}

function productImage(cfg, product) {
  const mapped = cfg.imageById?.[product?.id];
  if (typeof mapped === "string" && /^https:\/\//i.test(mapped)) return mapped;
  const raw = textOf(product, "imagen");
  if (isHttp(raw)) return raw;
  if (raw && cfg.imageBaseUrl) return joinUrl(cfg.imageBaseUrl, raw);
  if (!cfg.skipWithoutImage && cfg.placeholderImageUrl) return cfg.placeholderImageUrl;
  return "";
}

function descriptionOf(cfg, product) {
  const detail = textOf(product, "detalle");
  if (detail) return presentText(cfg, detail, DESCRIPTION_MAX);
  const name = cfg.preserveCase ? textOf(product, "nombre") : readable(textOf(product, "nombre"));
  const parts = [
    name,
    textOf(product, "marca") && `Marca: ${textOf(product, "marca")}`,
    textOf(product, "codigo") && `Código: ${textOf(product, "codigo")}`,
    textOf(product, "unidad") && `Unidad: ${textOf(product, "unidad")}`,
    textOf(product, "contenido") && `Contenido: ${textOf(product, "contenido")}`,
  ].filter(Boolean);
  return clip(parts.join(". "), DESCRIPTION_MAX);
}

function mapProduct(cfg, product) {
  const reasons = [];
  const id = clip(product?.id, SHORT_MAX);
  const title = presentText(cfg, textOf(product, "nombre"), TITLE_MAX);
  const description = descriptionOf(cfg, product);
  const price = formatPrice(applyTax(product?.precio, cfg), cfg.currency);
  const link = productLink(cfg, product);
  const imageLink = productImage(cfg, product);
  const brand = clip(textOf(product, "marca") || textOf(product, "catalogo"), SHORT_MAX);
  const gtin = gtinOf(product?.barra);
  const mpn = clip(textOf(product, "referencia"), SHORT_MAX);

  if (!id) reasons.push("sin id");
  if (!title) reasons.push("sin nombre");
  if (!description) reasons.push("sin descripcion");
  if (!price) reasons.push("precio invalido");
  if (!link) reasons.push("link invalido");
  if (!imageLink) reasons.push("sin imagen publica");
  if (!brand && !gtin && !mpn) reasons.push("falta brand, gtin o mpn");

  let availability = cfg.availability;
  if (typeof product?.existencia === "number") {
    availability = product.existencia > 0 ? "in stock" : "out of stock";
  }

  const data = {
    id,
    title,
    description,
    availability,
    condition: cfg.condition,
    price,
    link,
    image_link: imageLink,
    status: "active",
  };
  if (brand) data.brand = brand;
  if (gtin) data.gtin = gtin;
  if (mpn) data.mpn = mpn;

  const sale = formatPrice(applyTax(product?.precioFinal, cfg), cfg.currency);
  if (sale && Number(product.precioFinal) < Number(product.precio)) data.sale_price = sale;
  if (typeof product?.existencia === "number" && product.existencia >= 0) {
    data.quantity_to_sell_on_facebook = Math.max(0, Math.floor(product.existencia));
  }

  const labels = {
    custom_label_0: textOf(product, "proveedor"),
    custom_label_1: textOf(product, "catalogo"),
    custom_label_2: textOf(product, "categoria"),
    custom_label_3: textOf(product, "subcategoria"),
    custom_label_4: textOf(product, "rubro"),
  };
  for (const [key, label] of Object.entries(labels)) {
    if (label) data[key] = clip(label, SHORT_MAX);
  }

  return {
    reasons,
    request: { method: cfg.method, data },
  };
}

async function graph(url, options, attempt = 0) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 500) };
    }
  }
  if (response.ok && !body.error) return body;

  const code = body.error?.code;
  const retryable =
    response.status === 429 || response.status >= 500 || RETRYABLE_CODES.has(code);
  if (retryable && attempt < 6) {
    const wait = Math.min(120000, 5000 * 2 ** attempt);
    console.log(
      `Graph API respondió ${response.status} (código ${code ?? "sin código"}). Reintento ${attempt + 1} en ${Math.round(wait / 1000)} s.`,
    );
    await sleep(wait);
    return graph(url, options, attempt + 1);
  }

  const message = body.error?.message || body.raw || response.statusText;
  const error = new Error(`Graph API ${response.status}: ${message}`);
  error.detail = body.error || null;
  throw error;
}

function authHeaders(cfg) {
  return { Authorization: `Bearer ${cfg.token}` };
}

async function ensureCatalog(cfg) {
  if (cfg.catalogId || cfg.dryRun) return cfg.catalogId;
  const body = new URLSearchParams({
    name: cfg.catalogName,
    vertical: "commerce",
  });
  if (cfg.pageId) body.set("page_id", cfg.pageId);
  console.log(`Creando catálogo "${cfg.catalogName}" en el negocio ${cfg.businessId}…`);
  const created = await graph(`${cfg.graphBase}/${cfg.businessId}/owned_product_catalogs`, {
    method: "POST",
    headers: authHeaders(cfg),
    body,
  });
  if (!created.id) throw new Error("Meta no devolvió el id del catálogo creado");
  console.log(`Catálogo creado: ${created.id}`);
  return String(created.id);
}

async function sendBatch(cfg, requests) {
  const body = new URLSearchParams({
    item_type: "PRODUCT_ITEM",
    allow_upsert: cfg.allowUpsert ? "true" : "false",
    requests: JSON.stringify(requests),
  });
  return graph(`${cfg.graphBase}/${cfg.catalogId}/items_batch`, {
    method: "POST",
    headers: authHeaders(cfg),
    body,
  });
}

async function pollHandle(cfg, handle) {
  const started = Date.now();
  while (Date.now() - started < cfg.pollTimeoutMs) {
    const params = new URLSearchParams({
      handle,
      load_ids_of_invalid_requests: "true",
      fields: "handle,status,warnings,errors_total_count,ids_of_invalid_requests",
    });
    const status = await graph(
      `${cfg.graphBase}/${cfg.catalogId}/check_batch_request_status?${params}`,
      { headers: authHeaders(cfg) },
    );
    const row = status.data?.[0];
    if (row?.status && TERMINAL_STATUS.has(row.status)) return row;
    await sleep(cfg.pollIntervalMs);
  }
  throw new Error(`Tiempo de espera agotado para el handle ${handle}`);
}

function compactStatus(row) {
  if (!row) return null;
  return {
    handle: row.handle,
    status: row.status,
    errors_total_count: row.errors_total_count ?? 0,
    warnings: Array.isArray(row.warnings) ? row.warnings.slice(0, 30) : [],
    ids_of_invalid_requests: Array.isArray(row.ids_of_invalid_requests)
      ? row.ids_of_invalid_requests.slice(0, 100)
      : [],
  };
}

function compactValidation(validationStatus) {
  if (!Array.isArray(validationStatus)) return [];
  return validationStatus
    .filter((row) => (row.errors && row.errors.length) || (row.warnings && row.warnings.length))
    .slice(0, 50);
}

async function linkCatalog(cfg) {
  if (!cfg.link) return null;
  if (cfg.dryRun) {
    return { dryRun: true, wabaId: cfg.wabaId, catalogId: cfg.catalogId };
  }
  console.log(`Vinculando el catálogo ${cfg.catalogId} a WhatsApp ${cfg.wabaId}…`);
  const body = new URLSearchParams({ catalog_id: cfg.catalogId });
  const result = await graph(`${cfg.graphBase}/${cfg.wabaId}/product_catalogs`, {
    method: "POST",
    headers: authHeaders(cfg),
    body,
  });
  return result;
}

function loadProducts(cfg) {
  const raw = JSON.parse(fs.readFileSync(cfg.catalogPath, "utf8"));
  const products = Array.isArray(raw.productos) ? raw.productos : [];
  if (!cfg.currency) cfg.currency = String(raw.meta?.moneda || "MXN").toUpperCase();
  if (!/^[A-Z]{3}$/.test(cfg.currency)) {
    throw new Error("CURRENCY debe ser un código ISO 4217 de 3 letras, por ejemplo MXN");
  }
  return { raw, products };
}

function selectProducts(cfg, products) {
  return products.filter((product) => {
    if (cfg.filterProveedor && product.proveedor !== cfg.filterProveedor) return false;
    if (cfg.filterCatalogo && product.catalogo !== cfg.filterCatalogo) return false;
    return true;
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (flag(args, "help") || flag(args, "h")) {
    help();
    return;
  }

  loadEnv(path.join(ROOT, ".env"));
  const cfg = readConfig(args);
  assertReady(cfg);
  await upload(cfg);
}

async function upload(cfg) {
  loadImageMap(cfg);
  const { raw, products } = loadProducts(cfg);
  const selected = selectProducts(cfg, products);
  const considered = cfg.limit > 0 ? selected.slice(0, cfg.limit) : selected;
  const motivos = {};
  const valid = [];

  for (const product of considered) {
    const mapped = mapProduct(cfg, product);
    if (mapped.reasons.length) {
      for (const reason of mapped.reasons) motivos[reason] = (motivos[reason] || 0) + 1;
      continue;
    }
    valid.push(mapped.request);
  }

  const report = {
    generado: new Date().toISOString(),
    dryRun: cfg.dryRun,
    documentacion: {
      itemsBatch:
        "https://developers.facebook.com/docs/marketing-api/reference/product-catalog/items_batch",
      campos: "https://developers.facebook.com/docs/marketing-api/catalog/reference",
      whatsapp:
        "https://developers.facebook.com/docs/whatsapp/cloud-api/guides/sell-products-and-services/upload-inventory",
    },
    origen: {
      archivo: path.relative(ROOT, cfg.catalogPath),
      total: products.length,
      monedaCatalogo: raw.meta?.moneda || null,
      preciosSinIVA: raw.meta?.preciosSinIVA ?? null,
    },
    envio: {
      graph: cfg.version,
      catalogId: cfg.catalogId || null,
      method: cfg.method,
      allowUpsert: cfg.allowUpsert,
      itemType: "PRODUCT_ITEM",
      currency: cfg.currency,
      includeIva: cfg.includeIva,
      batchSize: cfg.batchSize,
      linkWhatsapp: cfg.link,
    },
    resultado: {
      considerados: considered.length,
      validos: valid.length,
      omitidos: considered.length - valid.length,
      motivos,
      lotes: Math.ceil(valid.length / cfg.batchSize) || 0,
    },
    muestra: valid.slice(0, 2),
    lotes: [],
    vinculoWhatsapp: null,
    error: null,
  };

  console.log(
    `${cfg.dryRun ? "Simulación" : "Subida"}: ${valid.length} productos válidos, ${report.resultado.omitidos} omitidos, de ${considered.length} considerados.`,
  );
  for (const [reason, count] of Object.entries(motivos).sort((a, b) => b[1] - a[1])) {
    console.log(`  - ${reason}: ${count}`);
  }

  if (!valid.length) {
    writeReport(cfg, report);
    throw new Error("Ningún producto cumple los campos que Meta exige para subirlo.");
  }

  if (cfg.dryRun) {
    if ([cfg.storeBaseUrl, cfg.imageBaseUrl].some(isPlaceholderHost)) {
      console.log("Aviso: las URLs públicas siguen en ejemplo.com. Cámbialas antes de la subida real.");
    }
    writeReport(cfg, report);
    console.log(`Reporte: ${path.relative(ROOT, cfg.reportPath)}`);
    return;
  }

  try {
    cfg.catalogId = await ensureCatalog(cfg);
    report.envio.catalogId = cfg.catalogId;

    const batches = chunk(valid, cfg.batchSize);
    let failed = false;
    for (let index = 0; index < batches.length; index += 1) {
      const requests = batches[index];
      console.log(`Lote ${index + 1}/${batches.length} (${requests.length} productos)…`);
      const sent = await sendBatch(cfg, requests);
      const entry = {
        lote: index + 1,
        productos: requests.length,
        handles: sent.handles || [],
        validation_status: compactValidation(sent.validation_status),
        estado: null,
      };
      const handle = sent.handles?.[0];
      if (!handle) {
        failed = true;
        entry.estado = { status: "no_ingestado" };
        console.log("Meta no ingirió el lote. Revisa validation_status en el reporte.");
      } else {
        console.log(`Handle ${handle}. Esperando el procesamiento…`);
        entry.estado = compactStatus(await pollHandle(cfg, handle));
        const errors = entry.estado?.errors_total_count || 0;
        console.log(`Lote ${index + 1}: ${entry.estado?.status || "sin estado"}, errores ${errors}.`);
        if (entry.estado?.status !== "finished" || errors > 0) failed = true;
      }
      report.lotes.push(entry);
      if (index < batches.length - 1 && cfg.batchDelayMs) await sleep(cfg.batchDelayMs);
    }

    if (!failed) report.vinculoWhatsapp = await linkCatalog(cfg);
    else if (cfg.link) {
      report.vinculoWhatsapp = {
        omitido: "Hay lotes con errores. El catálogo no se vinculó a WhatsApp.",
      };
    }
    if (failed) {
      throw new Error("La subida terminó con lotes incompletos o con errores. Revisa el reporte.");
    }
  } catch (error) {
    report.error = error.message;
    if (error.detail) {
      report.errorDetail = {
        message: error.detail.message,
        type: error.detail.type,
        code: error.detail.code,
        error_subcode: error.detail.error_subcode,
        fbtrace_id: error.detail.fbtrace_id,
      };
    }
    throw error;
  } finally {
    writeReport(cfg, report);
    console.log(`Reporte: ${path.relative(ROOT, cfg.reportPath)}`);
  }
}

function writeReport(cfg, report) {
  fs.mkdirSync(path.dirname(cfg.reportPath), { recursive: true });
  fs.writeFileSync(cfg.reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.message);
  if (error.detail) console.error(JSON.stringify(error.detail));
  process.exitCode = 1;
});
