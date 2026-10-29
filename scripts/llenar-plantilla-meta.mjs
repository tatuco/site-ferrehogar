#!/usr/bin/env node
/**
 * Llena la plantilla CSV de catálogo de Meta con los productos que tienen
 * imagen pública en build/imagenes-r2.json.
 *
 * Escribe las columnas obligatorias y un precio fijo. El resto de opcionales
 * quedan vacíos. image_link es la URL de R2. link abre WhatsApp con el
 * producto en el mensaje. price sigue el formato de la plantilla: número con
 * punto decimal, espacio y código ISO 4217.
 *
 * Uso: node scripts/llenar-plantilla-meta.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CATALOGO = path.join(ROOT, "build", "catalogo.json");
const IMAGENES = path.join(ROOT, "build", "imagenes-r2.json");
const PLANTILLA = path.join(ROOT, "build", "catalog_products.csv");

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 9999;
const SHORT_MAX = 100;
const FILLED = ["id", "title", "description", "availability", "condition", "link", "image_link", "brand"];
const WHATSAPP_PHONE = "584221608331";
const PRICE = "1.00 MXN";

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

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
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

function rowOf(product, imageUrl, columns) {
  const id = clip(product.id, SHORT_MAX);
  const title = clip(readable(textOf(product, "nombre")), TITLE_MAX);
  const description = descriptionOf(product);
  const brand = clip(readable(textOf(product, "marca")), SHORT_MAX);
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
    price: PRICE,
    link: whatsappLink(title, textOf(product, "codigo")),
    image_link: imageUrl,
    brand,
  };
  return {
    reasons,
    line: columns.map((column) => csvField(values[column] ?? "")).join(","),
  };
}

function main() {
  const catalogo = loadJson(CATALOGO);
  const imagenes = loadJson(IMAGENES);
  const mapa = imagenes?.imagenes;
  if (!mapa || typeof mapa !== "object" || Array.isArray(mapa)) {
    throw new Error("build/imagenes-r2.json no tiene un objeto imagenes.");
  }
  const productos = catalogo?.productos;
  if (!Array.isArray(productos)) {
    throw new Error("build/catalogo.json no tiene un arreglo productos.");
  }

  const { newline, description, columns } = headerLines(PLANTILLA);
  const missing = FILLED.filter((name) => !columns.includes(name));
  if (missing.length) {
    throw new Error(`Faltan columnas en la plantilla: ${missing.join(", ")}`);
  }

  const lines = [];
  const porCatalogo = {};
  const omitidos = [];
  for (const product of productos) {
    const imageUrl = mapa[product?.id];
    if (typeof imageUrl !== "string") continue;
    const row = rowOf(product, imageUrl, columns);
    if (row.reasons.length) {
      omitidos.push(`${product?.id || "(sin id)"}: ${row.reasons.join(", ")}`);
      continue;
    }
    lines.push(row.line);
    const catalogoId = textOf(product, "catalogo") || "(sin catalogo)";
    porCatalogo[catalogoId] = (porCatalogo[catalogoId] || 0) + 1;
  }

  const body = [description, columns.join(","), ...lines].join(newline) + newline;
  fs.writeFileSync(PLANTILLA, body);

  console.log(`Plantilla: ${path.relative(ROOT, PLANTILLA)}`);
  console.log(`Productos con imagen: ${lines.length}`);
  for (const [nombre, total] of Object.entries(porCatalogo).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${nombre}: ${total}`);
  }
  if (omitidos.length) {
    console.log(`Omitidos: ${omitidos.length}`);
    for (const item of omitidos.slice(0, 20)) console.log(`  ${item}`);
  }
}

main();
