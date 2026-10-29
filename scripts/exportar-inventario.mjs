#!/usr/bin/env node
/**
 * Exporta build/catalogo.json a un CSV de inventario.
 *
 * Las columnas salen de meta.campos, en ese orden. Si un producto trae un
 * campo extra (por ejemplo imagen), se agrega al final. Los campos vacíos
 * u omitidos quedan en blanco.
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
const CATALOGO = path.join(ROOT, "build", "catalogo.json");
const SALIDA = path.join(ROOT, "build", "inventario.csv");

function csvCampo(value) {
  if (value === null || value === undefined) return "";
  const text = String(value).replace(/\r?\n/g, " ");
  if (/[";\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function columnasDe(catalogo) {
  const declaradas = Object.keys(catalogo?.meta?.campos || {});
  const columnas = [...declaradas];
  const vistas = new Set(columnas);
  for (const producto of catalogo.productos) {
    for (const campo of Object.keys(producto)) {
      if (vistas.has(campo)) continue;
      vistas.add(campo);
      columnas.push(campo);
    }
  }
  if (!columnas.length) throw new Error("El catálogo no declara campos ni trae productos con datos.");
  return columnas;
}

function main() {
  const catalogo = JSON.parse(fs.readFileSync(CATALOGO, "utf8"));
  const productos = catalogo?.productos;
  if (!Array.isArray(productos)) {
    throw new Error("build/catalogo.json no tiene un arreglo productos.");
  }

  const columnas = columnasDe(catalogo);
  const lineas = ["sep=;", columnas.join(";")];
  for (const producto of productos) {
    lineas.push(columnas.map((campo) => csvCampo(producto[campo])).join(";"));
  }

  fs.writeFileSync(SALIDA, `\uFEFF${lineas.join("\r\n")}\r\n`);
  console.log(`Inventario: ${path.relative(ROOT, SALIDA)}`);
  console.log(`Productos: ${productos.length}`);
  console.log(`Columnas: ${columnas.join(", ")}`);
}

main();
