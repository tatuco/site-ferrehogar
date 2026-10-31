#!/usr/bin/env node
/**
 * Fusiona los CSV nuevos en database.json, sube las fotos que existan
 * por nombre a R2 y regenera las salidas del índice, el inventario y el cotizador.
 *
 *   npm run actualizar
 *   npm run actualizar -- --sin-r2
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asignarMargenes } from "./categorizar-margenes.mjs";
import { textoInventario } from "./exportar-inventario.mjs";
import { aplicarFilas, crearIndice, reservarFilas, validarLote } from "./lib/lote.mjs";
import { precioVentaProducto } from "./lib/precio.mjs";
import { joinUrl, loadEnv, uploadOne } from "./subir-imagenes-r2.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE = path.join(ROOT, "database.json");
const INGRESOS = path.join(ROOT, "data", "ingresos");
const MANUALES = path.join(ROOT, "build", "img-manuales");
const INDICE = path.join(ROOT, "build", "imagenes-r2.json");
const CATEGORIZADO = path.join(ROOT, "build", "catalogo.categorizado.json");
const INTERNO = path.join(ROOT, "build", "catalogo-ferrehogar-interno.js");
const INVENTARIO = path.join(ROOT, "build", "inventario.csv");
const COTIZADOR = path.join(ROOT, "build", "cotizador", "cotizador.json");
const EXTENSIONES = ["jpg", "jpeg", "png", "webp", "gif"];
const MIME = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

function escribirAtomico(archivo, texto) {
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  const tmp = `${archivo}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, texto);
  fs.renameSync(tmp, archivo);
}

function sha256Archivo(archivo) {
  return crypto.createHash("sha256").update(fs.readFileSync(archivo)).digest("hex");
}

function norm(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\\/]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/\.+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function talloDe(nombre) {
  const base = nombre.trim();
  const conPunto = base.match(new RegExp(`^(.*)\\.(${EXTENSIONES.join("|")})$`, "i"));
  if (conPunto) return conPunto[1].trim();
  const pegada = base.match(new RegExp(`^(.*)(${EXTENSIONES.join("|")})$`, "i"));
  if (pegada) return pegada[1].trim();
  return base;
}

function extensionDe(nombre) {
  const match = nombre.toLowerCase().match(/\.([a-z0-9]+)$/);
  const ext = match ? match[1] : "";
  return EXTENSIONES.includes(ext) ? ext : "";
}

function claveObjeto(prefix, producto, ext) {
  const catalogo = String(producto.catalogo || "sin-catalogo").replace(/[\\/]+/g, "-");
  const archivo = `${producto.id}.${ext}`.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const relativa = `img/${catalogo}/${archivo}`;
  return prefix ? `${prefix}/${relativa}` : relativa;
}

function leerDatabase() {
  if (!fs.existsSync(DATABASE)) {
    throw new Error("Falta database.json. Corre primero: node scripts/sembrar-database.mjs");
  }
  const db = JSON.parse(fs.readFileSync(DATABASE, "utf8"));
  if (!Array.isArray(db.productos)) throw new Error("database.json no tiene productos.");
  if (!db.ingresosAplicados || typeof db.ingresosAplicados !== "object") db.ingresosAplicados = {};
  if (!Array.isArray(db.proveedores)) db.proveedores = [];
  if (!Array.isArray(db.catalogos)) db.catalogos = [];
  return db;
}

function csvPendientes(db) {
  if (!fs.existsSync(INGRESOS)) return [];
  return fs
    .readdirSync(INGRESOS)
    .filter((nombre) => nombre.toLowerCase().endsWith(".csv") && nombre.toLowerCase() !== "plantilla.csv")
    .sort((a, b) => a.localeCompare(b, "es"))
    .map((nombre) => {
      const archivo = path.join(INGRESOS, nombre);
      const hash = sha256Archivo(archivo);
      const previo = db.ingresosAplicados[nombre];
      return {
        nombre,
        archivo,
        hash,
        aplicado: previo?.sha256 === hash,
      };
    });
}

function fusionar(db, pendientes) {
  const indice = crearIndice(db.productos);
  const planes = [];
  const rechazados = [];

  for (const lote of pendientes) {
    if (lote.aplicado) continue;
    const texto = fs.readFileSync(lote.archivo, "utf8");
    const resultado = validarLote(texto, indice);
    if (resultado.errores.length) {
      rechazados.push({ nombre: lote.nombre, errores: resultado.errores });
      continue;
    }
    reservarFilas(indice, resultado.filas);
    planes.push({ ...lote, filas: resultado.filas });
  }

  if (rechazados.length) {
    for (const lote of rechazados) {
      console.error(`No se fusionó ${lote.nombre}:`);
      for (const error of lote.errores) console.error(`  ${error}`);
    }
    throw new Error("Hay CSV con filas inválidas. database.json no cambió.");
  }

  let altas = 0;
  let actualizaciones = 0;
  for (const lote of planes) {
    const informe = aplicarFilas(db, lote.filas);
    altas += informe.altas;
    actualizaciones += informe.actualizaciones;
    db.ingresosAplicados[lote.nombre] = {
      sha256: lote.hash,
      aplicado: new Date().toISOString(),
      filas: lote.filas.length,
    };
    console.log(
      `${lote.nombre}: ${lote.filas.length} filas, ${informe.altas} altas, ${informe.actualizaciones} actualizaciones.`,
    );
  }

  if (planes.length) refrescarAgrupaciones(db);
  return { archivos: planes.length, altas, actualizaciones };
}

function refrescarAgrupaciones(db) {
  const porProveedor = new Map();
  const porCatalogo = new Map();
  for (const producto of db.productos) {
    const provId = producto.proveedor || "";
    const catId = producto.catalogo || "";
    if (!porProveedor.has(provId)) {
      porProveedor.set(provId, { total: 0, catalogos: new Set(), marcas: new Set() });
    }
    const prov = porProveedor.get(provId);
    prov.total += 1;
    if (catId) prov.catalogos.add(catId);
    if (producto.marca) prov.marcas.add(producto.marca);
    if (!porCatalogo.has(catId)) porCatalogo.set(catId, { total: 0, proveedor: provId });
    porCatalogo.get(catId).total += 1;
  }

  const vistosProv = new Set();
  for (const proveedor of db.proveedores) {
    vistosProv.add(proveedor.id);
    const info = porProveedor.get(proveedor.id);
    if (!info) continue;
    proveedor.total = info.total;
    proveedor.catalogos = [...info.catalogos].sort();
    proveedor.marcas = info.marcas.size;
  }
  for (const [id, info] of porProveedor) {
    if (!id || vistosProv.has(id)) continue;
    db.proveedores.push({
      id,
      nombre: id,
      total: info.total,
      catalogos: [...info.catalogos].sort(),
      marcas: info.marcas.size,
    });
  }

  const vistosCat = new Set();
  for (const catalogo of db.catalogos) {
    vistosCat.add(catalogo.id);
    const info = porCatalogo.get(catalogo.id);
    if (!info) continue;
    catalogo.total = info.total;
  }
  for (const [id, info] of porCatalogo) {
    if (!id || vistosCat.has(id)) continue;
    db.catalogos.push({
      id,
      nombre: id,
      proveedor: info.proveedor,
      total: info.total,
    });
  }

  const codigos = new Map();
  let sinMarcaOriginal = 0;
  let sinPrecio = 0;
  let precioCero = 0;
  let sinUnidad = 0;
  let sinNombre = 0;
  let conDescuento = 0;
  let conDetalle = 0;
  let conBarra = 0;
  for (const producto of db.productos) {
    if (!producto.marcaOriginal) sinMarcaOriginal += 1;
    if (producto.precio === undefined || producto.precio === null || producto.precio === "") sinPrecio += 1;
    else if (Number(producto.precio) === 0) precioCero += 1;
    if (!producto.unidad) sinUnidad += 1;
    if (!producto.nombre) sinNombre += 1;
    if (producto.descuento !== undefined && producto.descuento !== null && producto.descuento !== "") {
      conDescuento += 1;
    }
    if (producto.detalle) conDetalle += 1;
    if (producto.barra) conBarra += 1;
    const codigo = String(producto.codigo);
    codigos.set(codigo, (codigos.get(codigo) || 0) + 1);
  }
  let codigosDuplicados = 0;
  for (const total of codigos.values()) {
    if (total > 1) codigosDuplicados += 1;
  }
  db.resumen = {
    totalProductos: db.productos.length,
    totalProveedores: db.proveedores.length,
    totalCatalogos: db.catalogos.length,
    sinMarcaOriginal,
    sinPrecio,
    precioCero,
    sinUnidad,
    sinNombre,
    conDescuento,
    conDetalle,
    conBarra,
    codigosDuplicados,
  };
  if (db.meta) db.meta.generado = new Date().toISOString();
}

function indiceFotos() {
  const mapa = new Map();
  if (!fs.existsSync(MANUALES)) return mapa;
  for (const nombre of fs.readdirSync(MANUALES)) {
    if (nombre.startsWith(".")) continue;
    const archivo = path.join(MANUALES, nombre);
    let stat;
    try {
      stat = fs.statSync(archivo);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const ext = extensionDe(nombre);
    if (!ext) continue;
    const clave = norm(talloDe(nombre));
    if (!clave || mapa.has(clave)) continue;
    mapa.set(clave, { archivo, nombre, ext });
  }
  return mapa;
}

function fotosParaSubir(productos) {
  const fotos = indiceFotos();
  const cola = [];
  const usados = new Set();
  for (const producto of productos) {
    const candidatas = [norm(producto.id), norm(`${producto.catalogo}-${producto.codigo}`)];
    const foto = candidatas.map((clave) => fotos.get(clave)).find(Boolean);
    if (!foto || usados.has(foto.archivo)) continue;
    usados.add(foto.archivo);
    cola.push({ producto, ...foto });
  }
  return cola;
}

function configR2() {
  loadEnv(path.join(ROOT, ".env"));
  const publicBaseUrl = String(process.env.R2_PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  const prefix = String(process.env.R2_PREFIX ?? "products").replace(/^\/+|\/+$/g, "");
  const cfg = {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID || "",
    accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
    bucket: process.env.R2_BUCKET || "",
    prefix,
    publicBaseUrl,
  };
  for (const [nombre, valor] of [
    ["CLOUDFLARE_ACCOUNT_ID", cfg.accountId],
    ["R2_ACCESS_KEY_ID", cfg.accessKeyId],
    ["R2_SECRET_ACCESS_KEY", cfg.secretAccessKey],
    ["R2_BUCKET", cfg.bucket],
    ["R2_PUBLIC_BASE_URL", cfg.publicBaseUrl],
  ]) {
    if (!valor) throw new Error(`Falta ${nombre} en .env`);
  }
  if (!/^https?:\/\//i.test(cfg.publicBaseUrl)) {
    throw new Error("R2_PUBLIC_BASE_URL debe empezar por http:// o https://");
  }
  return cfg;
}

function leerIndice() {
  if (!fs.existsSync(INDICE)) {
    return { bucket: "", baseUrl: "", imagenes: {} };
  }
  const data = JSON.parse(fs.readFileSync(INDICE, "utf8"));
  const imagenes =
    data && data.imagenes && typeof data.imagenes === "object" && !Array.isArray(data.imagenes)
      ? { ...data.imagenes }
      : {};
  return { bucket: data.bucket || "", baseUrl: data.baseUrl || "", imagenes };
}

function guardarIndice(indice, cfg) {
  escribirAtomico(
    INDICE,
    `${JSON.stringify(
      {
        generado: new Date().toISOString(),
        bucket: cfg?.bucket || indice.bucket || "",
        baseUrl: cfg?.publicBaseUrl || indice.baseUrl || "",
        total: Object.keys(indice.imagenes).length,
        imagenes: indice.imagenes,
      },
      null,
      2,
    )}\n`,
  );
}

async function pool(items, concurrency, worker) {
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
}

async function publicarFotos(db, sinR2) {
  const cola = fotosParaSubir(db.productos);
  const indice = leerIndice();
  if (sinR2 || cola.length === 0) {
    console.log(
      sinR2
        ? `Sin R2. Fotos en la bandeja: ${cola.length}. El índice conserva ${Object.keys(indice.imagenes).length} enlaces.`
        : `No hay fotos nuevas en build/img-manuales. Enlaces: ${Object.keys(indice.imagenes).length}.`,
    );
    return { errores: 0, indice };
  }

  const cfg = configR2();
  const stats = { subidas: 0, existentes: 0, errores: 0 };
  let hechas = 0;
  await pool(cola, 4, async (item) => {
    const key = claveObjeto(cfg.prefix, item.producto, item.ext);
    try {
      const resultado = await uploadOne(cfg, {
        key,
        file: item.archivo,
        contentType: MIME[item.ext] || "application/octet-stream",
      });
      if (resultado === "existente") stats.existentes += 1;
      else stats.subidas += 1;
      indice.imagenes[item.producto.id] = joinUrl(cfg.publicBaseUrl, key);
    } catch (error) {
      stats.errores += 1;
      console.error(`${item.producto.id}: ${error.message}`);
    }
    hechas += 1;
    if (hechas % 25 === 0 || hechas === cola.length) guardarIndice(indice, cfg);
  });
  guardarIndice(indice, cfg);
  console.log(
    `Fotos: ${cola.length}. Subidas ${stats.subidas}, ya estaban ${stats.existentes}, errores ${stats.errores}.`,
  );
  return { errores: stats.errores, indice };
}

function copiarProducto(producto) {
  const copia = { ...producto };
  delete copia.margen;
  return copia;
}

function urlPublica(indice, id) {
  const url = indice.imagenes[id];
  return typeof url === "string" && /^https?:\/\//i.test(url) ? url : "";
}

function generarSalidas(db, indice) {
  const productos = db.productos.map((producto) => copiarProducto(producto));
  const catalogo = {
    meta: { ...db.meta, generado: new Date().toISOString(), moneda: "USD" },
    proveedores: db.proveedores,
    catalogos: db.catalogos,
    productos,
    resumen: db.resumen,
  };
  asignarMargenes(catalogo);

  const internoProductos = catalogo.productos.map((producto) => {
    const copia = { ...producto };
    const publica = urlPublica(indice, producto.id);
    if (publica) copia.imagen = publica;
    return copia;
  });
  const interno = {
    ...catalogo,
    productos: internoProductos,
  };

  const cotizadorProductos = internoProductos.map((producto) => {
    const venta = precioVentaProducto(producto, producto.margen?.min);
    const fila = {
      id: producto.id,
      codigo: producto.codigo,
      nombre: producto.nombre || "",
      marca: producto.marca || "",
      unidad: producto.unidad || "",
      existencia: producto.existencia ?? null,
      categoriaMargen: producto.margen?.categoria || "",
      margenMin: producto.margen?.min ?? null,
      margenMax: producto.margen?.max ?? null,
      precioVenta: venta == null ? null : Number(venta.toFixed(2)),
    };
    const publica = urlPublica(indice, producto.id);
    if (publica) fila.imagen = publica;
    return fila;
  });
  const cotizador = {
    meta: {
      generado: catalogo.meta.generado,
      moneda: "USD",
      preciosSinIVA: catalogo.meta.preciosSinIVA ?? true,
      nota: "Precios de venta con el margen mínimo de cada categoría. No incluye el costo del proveedor.",
    },
    productos: cotizadorProductos,
  };

  escribirAtomico(CATEGORIZADO, `${JSON.stringify(catalogo)}\n`);
  escribirAtomico(INTERNO, `window.CATALOGO = ${JSON.stringify(interno)};\n`);
  escribirAtomico(INVENTARIO, textoInventario(catalogo).texto);
  escribirAtomico(COTIZADOR, `${JSON.stringify(cotizador)}\n`);

  const conVenta = cotizadorProductos.filter((producto) => producto.precioVenta != null).length;
  console.log(`Salidas: ${catalogo.productos.length} productos, ${conVenta} con precio de venta.`);
  console.log("build/catalogo.categorizado.json");
  console.log("build/catalogo-ferrehogar-interno.js");
  console.log("build/inventario.csv");
  console.log("build/cotizador/cotizador.json");
}

function ayuda() {
  console.log(`Uso:
  npm run actualizar
  npm run actualizar -- --sin-r2

Lee los CSV nuevos de data/ingresos (no relee un archivo ya aplicado si no cambió),
los fusiona en database.json, sube las fotos de build/img-manuales que coincidan
con el nombre <catalogo>-<codigo> y regenera el índice, el inventario y el cotizador.

--sin-r2  no llama a R2 y reutiliza build/imagenes-r2.json.
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    ayuda();
    return;
  }
  const sinR2 = args.includes("--sin-r2");
  const db = leerDatabase();
  const pendientes = csvPendientes(db);
  const ya = pendientes.filter((lote) => lote.aplicado).length;
  const nuevos = pendientes.length - ya;
  console.log(`CSV en data/ingresos: ${pendientes.length}. Ya aplicados: ${ya}. Por fusionar: ${nuevos}.`);
  fusionar(db, pendientes);
  if (nuevos > 0) escribirAtomico(DATABASE, `${JSON.stringify(db)}\n`);
  else console.log("database.json no tenía CSV nuevos.");

  const fotos = await publicarFotos(db, sinR2);
  generarSalidas(db, fotos.indice);
  if (fotos.errores) {
    throw new Error(`${fotos.errores} fotos no se pudieron subir. Las salidas usan los enlaces que sí quedaron.`);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
