#!/usr/bin/env node
/**
 * Llena la plantilla CSV de catálogo de Meta desde
 * build/catalogo-ferrehogar-interno.js.
 *
 * Escribe las columnas obligatorias. El resto de opcionales quedan vacíos.
 * image_link es la imagen pública del producto. link abre WhatsApp con el
 * producto en el mensaje. price usa el precio del catálogo, en dólares; si
 * no hay un precio mayor que cero, queda en 1.00 USD. El formato es el de
 * la plantilla: número con punto decimal, espacio y código ISO 4217.
 *
 * Uso: node scripts/llenar-plantilla-meta.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CATALOGO = path.join(ROOT, "build", "catalogo-ferrehogar-interno.js");
const PLANTILLA = path.join(ROOT, "build", "catalog_products.csv");

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 9999;
const SHORT_MAX = 100;
const FILLED = ["id", "title", "description", "availability", "condition", "link", "image_link", "brand"];
const WHATSAPP_PHONE = "584221608331";
const CURRENCY = "USD";
const DEFAULT_PRICE = 1;

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

function textOf(product, field) {
  return product?.[field] ? String(product[field]).trim() : "";
}

function descriptionOf(product) {
  const detail = textOf(product, "detalle");
  if (detail) return clip(readable(detail), DESCRIPTION_MAX);
  const name = readable(textOf(product, "nombre"));
  const marca = readable(textOf(product, "marca"));
  const parts = [
    name,
    marca && `Marca: ${marca}`,
    textOf(product, "codigo") && `Código: ${textOf(product, "codigo")}`,
    textOf(product, "referencia") && `Referencia: ${textOf(product, "referencia")}`,
    textOf(product, "unidad") && `Unidad: ${textOf(product, "unidad")}`,
  ].filter(Boolean);
  const text = parts.join(". ");
  return clip(text.endsWith(".") ? text : `${text}.`, DESCRIPTION_MAX);
}

function whatsappLink(title, codigo) {
  const code = codigo ? ` (código ${codigo})` : "";
  const text = `Hola, quiero información del producto ${title}${code}.`;
  return `https://wa.me/${WHATSAPP_PHONE}?text=${encodeURIComponent(text)}`;
}

function csvField(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function loadCatalogo(file) {
  const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").trim();
  const start = raw.indexOf("{");
  if (start < 0) {
    throw new Error(`${path.relative(ROOT, file)} no contiene el catálogo.`);
  }
  try {
    return JSON.parse(raw.slice(start).replace(/;\s*$/, ""));
  } catch (error) {
    throw new Error(`No se pudo leer ${path.relative(ROOT, file)}: ${error.message}`);
  }
}

function priceOf(product) {
  const amount = Number(product?.precio);
  const usable = Number.isFinite(amount) && amount > 0 ? amount : DEFAULT_PRICE;
  return {
    text: `${usable.toFixed(2)} ${CURRENCY}`,
    porDefecto: !(Number.isFinite(amount) && amount > 0),
  };
}

function headerLines(file) {
  const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  const newline = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);
  const description = lines[0] ?? "";
  const columns = lines[1] ?? "";
  if (!columns.startsWith("id,title,description,")) {
    throw new Error(`${path.relative(ROOT, file)} no tiene el encabezado de la plantilla de Meta en la segunda fila.`);
  }
  return { newline, description, columns: columns.split(",") };
}

function rowOf(product, columns) {
  const id = clip(product.id, SHORT_MAX);
  const title = clip(readable(textOf(product, "nombre")), TITLE_MAX);
  const description = descriptionOf(product);
  const brand = clip(readable(textOf(product, "marca")), SHORT_MAX);
  const imageUrl = textOf(product, "imagen");
  const price = priceOf(product);
  const availability =
    typeof product.existencia === "number" && product.existencia <= 0 ? "out of stock" : "in stock";

  const reasons = [];
  if (!id) reasons.push("sin id");
  if (!title) reasons.push("sin nombre");
  if (!description) reasons.push("sin descripcion");
  if (!/^https:\/\//i.test(imageUrl)) reasons.push("sin imagen publica");
  if (!brand) reasons.push("sin marca");
  if (reasons.length) return { reasons };

  const values = {
    id,
    title,
    description,
    availability,
    condition: "new",
    price: price.text,
    link: whatsappLink(title, textOf(product, "codigo")),
    image_link: imageUrl,
    brand,
  };
  return {
    reasons,
    porDefecto: price.porDefecto,
    line: columns.map((column) => csvField(values[column] ?? "")).join(","),
  };
}

function main() {
  const catalogo = loadCatalogo(CATALOGO);
  const productos = catalogo?.productos;
  if (!Array.isArray(productos)) {
    throw new Error("build/catalogo-ferrehogar-interno.js no tiene un arreglo productos.");
  }

  const { newline, description, columns } = headerLines(PLANTILLA);
  const missing = FILLED.filter((name) => !columns.includes(name));
  if (missing.length) {
    throw new Error(`Faltan columnas en la plantilla: ${missing.join(", ")}`);
  }

  const lines = [];
  const porCatalogo = {};
  const omitidos = [];
  let porDefecto = 0;
  for (const product of productos) {
    const row = rowOf(product, columns);
    if (row.reasons.length) {
      omitidos.push(`${product?.id || "(sin id)"}: ${row.reasons.join(", ")}`);
      continue;
    }
    if (row.porDefecto) porDefecto += 1;
    lines.push(row.line);
    const catalogoId = textOf(product, "catalogo") || "(sin catalogo)";
    porCatalogo[catalogoId] = (porCatalogo[catalogoId] || 0) + 1;
  }

  const body = [description, columns.join(","), ...lines].join(newline) + newline;
  fs.writeFileSync(PLANTILLA, body);

  console.log(`Plantilla: ${path.relative(ROOT, PLANTILLA)}`);
  console.log(`Productos escritos: ${lines.length}`);
  console.log(`Precio por defecto ${DEFAULT_PRICE.toFixed(2)} ${CURRENCY}: ${porDefecto}`);
  for (const [nombre, total] of Object.entries(porCatalogo).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${nombre}: ${total}`);
  }
  if (omitidos.length) {
    console.log(`Omitidos: ${omitidos.length}`);
    for (const item of omitidos.slice(0, 20)) console.log(`  ${item}`);
  }
}

main();
