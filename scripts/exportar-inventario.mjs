#!/usr/bin/env node
/**
 * Exporta el catálogo categorizado a build/inventario.csv.
 *
 * Conserva las columnas del inventario y, junto al costo, agrega la
 * categoría de margen y el precio de venta. El precio de venta usa el
 * margen mínimo de la categoría:
 *
 *   precioVenta = costo × (1 + margenMin / 100)
 *
 * El costo es precioFinal cuando el catálogo ya trae el descuento
 * aplicado; si no, es precio. Los dos siguen siendo el costo, sin IVA.
 *
 * Formato igual al export del sitio: UTF-8 con BOM, separador ";" y una
 * primera fila sep=; para Excel en español.
 *
 * Uso: node scripts/exportar-inventario.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { costoDe as costoUnitario, precioVentaDe } from "./lib/precio.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CATALOGO = path.join(ROOT, "build", "catalogo.categorizado.json");
const SALIDA = path.join(ROOT, "build", "inventario.csv");

const COLUMNAS_MARGEN = ["categoriaMargen", "margenMin", "precioVenta"];

function csvCampo(value) {
  if (value === null || value === undefined || value === "") return "";
  const text = String(value).replace(/\r?\n/g, " ");
  if (/[";\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function columnasDe(catalogo) {
  const columnas = Object.keys(catalogo?.meta?.campos || {});
  if (!columnas.length) throw new Error("El catálogo no declara campos.");
  if (!columnas.includes("imagen")) columnas.push("imagen");
  const precio = columnas.indexOf("precio");
  const destino = precio === -1 ? columnas.length : precio + 1;
  columnas.splice(destino, 0, ...COLUMNAS_MARGEN);
  return columnas;
}

function costoDe(producto) {
  const costo = costoUnitario(producto);
  if (costo == null) return { costo: null, origen: "ninguno" };
  const usaFinal =
    producto.precioFinal !== "" && producto.precioFinal != null && Number.isFinite(Number(producto.precioFinal));
  return { costo, origen: usaFinal ? "precioFinal" : "precio" };
}

function filaDe(producto, columnas) {
  const margen = producto.margen || {};
  const { costo, origen } = costoDe(producto);
  const margenMin = Number.isFinite(margen.min) ? margen.min : null;
  const precioVenta =
    costo != null && margenMin != null ? precioVentaDe(costo, margenMin).toFixed(2) : "";

  const valores = {
    ...producto,
    categoriaMargen: margen.categoria || "",
    margenMin: margenMin ?? "",
    precioVenta,
  };

  return {
    linea: columnas.map((campo) => csvCampo(valores[campo])).join(";"),
    origen,
    categoria: margen.id || "sin-margen",
    conVenta: precioVenta !== "",
  };
}

export function textoInventario(catalogo) {
  const productos = catalogo?.productos;
  if (!Array.isArray(productos)) {
    throw new Error("El catálogo no tiene un arreglo productos.");
  }
  const columnas = columnasDe(catalogo);
  const conteo = {};
  const origenCosto = { precio: 0, precioFinal: 0, ninguno: 0 };
  let conVenta = 0;
  const lineas = ["sep=;", columnas.join(";")];
  for (const producto of productos) {
    const fila = filaDe(producto, columnas);
    lineas.push(fila.linea);
    conteo[fila.categoria] = (conteo[fila.categoria] || 0) + 1;
    origenCosto[fila.origen] += 1;
    if (fila.conVenta) conVenta += 1;
  }
  return {
    texto: `\uFEFF${lineas.join("\r\n")}\r\n`,
    columnas,
    conteo,
    origenCosto,
    conVenta,
    total: productos.length,
  };
}

function main() {
  const catalogo = JSON.parse(fs.readFileSync(CATALOGO, "utf8"));
  const productos = catalogo?.productos;
  if (!Array.isArray(productos)) {
    throw new Error("build/catalogo.categorizado.json no tiene un arreglo productos.");
  }

  const informe = textoInventario(catalogo);
  fs.writeFileSync(SALIDA, informe.texto);
  console.log(`Inventario: ${path.relative(ROOT, SALIDA)}`);
  console.log(`Productos: ${informe.total}`);
  console.log(`Con precio de venta: ${informe.conVenta}`);
  console.log(`Costo desde precio: ${informe.origenCosto.precio}`);
  console.log(`Costo desde precioFinal: ${informe.origenCosto.precioFinal}`);
  console.log(`Sin costo: ${informe.origenCosto.ninguno}`);
  console.log(`Columnas: ${informe.columnas.join(", ")}`);
  for (const [id, total] of Object.entries(informe.conteo)) console.log(`${total}\t${id}`);
}

const esEntradaDirecta =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (esEntradaDirecta) main();
