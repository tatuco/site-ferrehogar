#!/usr/bin/env node
/**
 * Copia el margen de build/catalogo.categorizado.json a build/datos.js
 * sin cambiar el resto de cada producto (en particular la URL de imagen).
 *
 * Uso: node scripts/aplicar-margenes-datos.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATOS = path.join(ROOT, "build", "datos.js");
const CATEGORIZADO = path.join(ROOT, "build", "catalogo.categorizado.json");

const raw = fs.readFileSync(DATOS, "utf8");
const json = raw.replace(/^window\.CATALOGO\s*=\s*/, "").replace(/;\s*$/, "");
const datos = JSON.parse(json);
const catalogo = JSON.parse(fs.readFileSync(CATEGORIZADO, "utf8"));

const porId = new Map(catalogo.productos.map((producto) => [producto.id, producto.margen]));
let aplicados = 0;
let sinMargen = 0;
for (const producto of datos.productos) {
  const margen = porId.get(producto.id);
  if (!margen) {
    sinMargen += 1;
    continue;
  }
  producto.margen = margen;
  aplicados += 1;
}
datos.margenes = catalogo.margenes;

fs.writeFileSync(DATOS, `window.CATALOGO = ${JSON.stringify(datos)};\n`);
console.log(`Productos en datos.js: ${datos.productos.length}`);
console.log(`Márgenes aplicados: ${aplicados}`);
console.log(`Sin margen: ${sinMargen}`);
console.log(`Imagen del primero: ${datos.productos[0]?.imagen || ""}`);
