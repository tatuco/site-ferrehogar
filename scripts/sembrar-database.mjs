#!/usr/bin/env node
/**
 * Siembra database.json desde el catálogo categorizado y copia al índice
 * de enlaces las URLs públicas que hoy están en datos.js.
 *
 * database.json no guarda margen, precio de venta ni URL de R2.
 *
 *   node scripts/sembrar-database.mjs
 *   node scripts/sembrar-database.mjs --forzar
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORIGEN = path.join(ROOT, "build", "catalogo.categorizado.json");
const DATOS = path.join(ROOT, "build", "datos.js");
const DATABASE = path.join(ROOT, "database.json");
const INDICE = path.join(ROOT, "build", "imagenes-r2.json");

function escribirAtomico(archivo, texto) {
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  const tmp = `${archivo}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, texto);
  fs.renameSync(tmp, archivo);
}

function esHttp(valor) {
  return /^https?:\/\//i.test(String(valor || ""));
}

function leerDatos(archivo) {
  let texto = fs.readFileSync(archivo, "utf8");
  const prefijo = "window.CATALOGO = ";
  if (texto.startsWith(prefijo)) texto = texto.slice(prefijo.length);
  texto = texto.trim().replace(/;\s*$/, "");
  return JSON.parse(texto);
}

function leerIndice(archivo) {
  if (!fs.existsSync(archivo)) {
    return { generado: null, bucket: "", baseUrl: "", imagenes: {} };
  }
  const data = JSON.parse(fs.readFileSync(archivo, "utf8"));
  const imagenes =
    data && data.imagenes && typeof data.imagenes === "object" && !Array.isArray(data.imagenes)
      ? { ...data.imagenes }
      : {};
  return {
    generado: data.generado || null,
    bucket: data.bucket || "",
    baseUrl: data.baseUrl || "",
    imagenes,
  };
}

function sembrar() {
  const forzar = process.argv.includes("--forzar");
  if (fs.existsSync(DATABASE) && !forzar) {
    throw new Error("database.json ya existe. Usa --forzar para volver a sembrarlo.");
  }
  if (!fs.existsSync(ORIGEN)) {
    throw new Error("No está build/catalogo.categorizado.json.");
  }
  if (!fs.existsSync(DATOS)) {
    throw new Error("No está build/datos.js.");
  }

  const origen = JSON.parse(fs.readFileSync(ORIGEN, "utf8"));
  if (!Array.isArray(origen.productos)) {
    throw new Error("El catálogo categorizado no tiene productos.");
  }

  let urlsEnProducto = 0;
  const productos = origen.productos.map((producto) => {
    const copia = { ...producto };
    delete copia.margen;
    delete copia.precioVenta;
    delete copia.categoriaMargen;
    delete copia.margenMin;
    delete copia.margenMax;
    if (esHttp(copia.imagen)) {
      urlsEnProducto += 1;
      delete copia.imagen;
    }
    return copia;
  });

  const database = {
    meta: origen.meta,
    proveedores: origen.proveedores,
    catalogos: origen.catalogos,
    productos,
    resumen: origen.resumen,
    ingresosAplicados: {},
  };

  const datos = leerDatos(DATOS);
  const indice = leerIndice(INDICE);
  let conservadas = 0;
  let nuevas = 0;
  for (const producto of datos.productos || []) {
    if (!producto?.id || !esHttp(producto.imagen)) continue;
    const anterior = indice.imagenes[producto.id];
    if (anterior === producto.imagen) {
      conservadas += 1;
      continue;
    }
    if (!anterior) nuevas += 1;
    indice.imagenes[producto.id] = producto.imagen;
    conservadas += 1;
  }

  escribirAtomico(DATABASE, `${JSON.stringify(database)}\n`);
  escribirAtomico(
    INDICE,
    `${JSON.stringify(
      {
        generado: new Date().toISOString(),
        bucket: indice.bucket,
        baseUrl: indice.baseUrl,
        total: Object.keys(indice.imagenes).length,
        imagenes: indice.imagenes,
      },
      null,
      2,
    )}\n`,
  );

  const muestra = productos[0];
  console.log(`database.json: ${productos.length} productos`);
  console.log(`Sin margen en el primero: ${muestra.margen === undefined}`);
  console.log(`Imagen local de muestra: ${muestra.imagen || "(sin ruta local)"}`);
  console.log(`URLs públicas que estaban dentro del producto: ${urlsEnProducto}`);
  console.log(`Enlaces en el índice: ${Object.keys(indice.imagenes).length} (nuevos ${nuevas})`);
}

try {
  sembrar();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
