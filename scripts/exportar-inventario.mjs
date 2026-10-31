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
  const final = Number(producto.precioFinal);
  if (Number.isFinite(final) && producto.precioFinal !== "" && producto.precioFinal != null) {
    return { costo: final, origen: "precioFinal" };
  }
  const lista = Number(producto.precio);
  if (Number.isFinite(lista) && producto.precio !== "" && producto.precio != null) {
    return { costo: lista, origen: "precio" };
  }
  return { costo: null, origen: "ninguno" };
}

function precioVentaDe(costo, margenMin) {
  const costoCentavos = Math.round(costo * 100);
  const ventaCentavos = Math.round((costoCentavos * (100 + margenMin)) / 100);
  return (ventaCentavos / 100).toFixed(2);
}

function filaDe(producto, columnas) {
  const margen = producto.margen || {};
  const { costo, origen } = costoDe(producto);
  const margenMin = Number.isFinite(margen.min) ? margen.min : null;
  const precioVenta =
    costo != null && margenMin != null ? precioVentaDe(costo, margenMin) : "";

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

function main() {
  const catalogo = JSON.parse(fs.readFileSync(CATALOGO, "utf8"));
  const productos = catalogo?.productos;
  if (!Array.isArray(productos)) {
    throw new Error("build/catalogo.categorizado.json no tiene un arreglo productos.");
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

  fs.writeFileSync(SALIDA, `\uFEFF${lineas.join("\r\n")}\r\n`);
  console.log(`Inventario: ${path.relative(ROOT, SALIDA)}`);
  console.log(`Productos: ${productos.length}`);
  console.log(`Con precio de venta: ${conVenta}`);
  console.log(`Costo desde precio: ${origenCosto.precio}`);
  console.log(`Costo desde precioFinal: ${origenCosto.precioFinal}`);
  console.log(`Sin costo: ${origenCosto.ninguno}`);
  console.log(`Columnas: ${columnas.join(", ")}`);
  for (const [id, total] of Object.entries(conteo)) console.log(`${total}\t${id}`);
}

main();
