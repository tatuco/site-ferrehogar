#!/usr/bin/env node
/**
 * Busca en internet una imagen para cada producto sin foto, la guarda como
 * <catalogo>-<codigo>.<ext> y escribe un catálogo nuevo con todos los productos.
 *
 * Quien ya tiene `imagen` se copia igual.
 * Quien recibe una foto nueva queda con la ruta en `imagen` e `imagen_download: true`.
 *
 * La búsqueda usa el nombre del producto (y la marca, si no está ya en el nombre).
 * La búsqueda usa Bing Imágenes. Si Bing no trae fotos o responde 429, sigue con
 * Yandex Imágenes. Pueden estar sujetas a derechos de autor; conviene revisarlas
 * antes de publicarlas.
 *
 * Reanudable: si el archivo ya está en disco, no vuelve a buscarlo.
 * El avance queda en build/imagenes-descarga-estado.json.
 *
 *   node scripts/descargar-imagenes-faltantes.mjs
 *   node scripts/descargar-imagenes-faltantes.mjs --limit 20 --catalogo jesus
 *   node scripts/descargar-imagenes-faltantes.mjs --out build/catalogo.json
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const EXTS = ["jpg", "jpeg", "png", "webp", "gif"];
const MIN_BYTES = 8 * 1024;
const MAX_BYTES = 15 * 1024 * 1024;

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

function integer(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function hasImage(product) {
  return Boolean(product?.imagen && String(product.imagen).trim());
}

function safePart(value) {
  return String(value ?? "")
    .trim()
    .replace(/[\\/]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function fileIdentity(product) {
  const catalogo = String(product.catalogo || "sin-catalogo").trim() || "sin-catalogo";
  const codigo = String(product.codigo || product.id || "sin-codigo").trim() || "sin-codigo";
  const dirName = safePart(catalogo) || "sin-catalogo";
  const base = `${dirName}-${safePart(codigo) || "sin-codigo"}`;
  return { dirName, base };
}

function buildQuery(product) {
  const nombre = String(product.nombre || "").replace(/\s+/g, " ").trim();
  const marca = String(product.marca || "").replace(/\s+/g, " ").trim();
  const parts = [];
  if (nombre) parts.push(nombre);
  if (marca && !nombre.toUpperCase().includes(marca.toUpperCase())) parts.push(marca);
  const query = parts.join(" ").replace(/["“”]+/g, " ").replace(/\s+/g, " ").trim();
  return query.slice(0, 180);
}

function decodeUrl(raw) {
  let url = String(raw)
    .replace(/&amp;/g, "&")
    .replace(/\\u002f/gi, "/")
    .replace(/\\u0026/gi, "&")
    .replace(/\\\//g, "/")
    .replace(/\\"/g, '"')
    .trim();
  try {
    url = decodeURIComponent(url);
  } catch {
    // La URL ya venía decodificada.
  }
  if (url.startsWith("//")) url = `https:${url}`;
  return url;
}

function keepImageUrl(url) {
  if (!/^https?:\/\//i.test(url)) return false;
  return !/(bing\.net|bing\.com|yandex\.|yastatic\.|gstatic\.com|favicon|sprite|1x1|pixel\.gif)/i.test(url);
}

function uniqueUrls(urls) {
  return [...new Set(urls.filter(keepImageUrl))];
}

function extractBingUrls(html) {
  const urls = [];
  const re = /murl&quot;:&quot;(.*?)&quot;/g;
  let match;
  while ((match = re.exec(html))) urls.push(decodeUrl(match[1]));
  return uniqueUrls(urls);
}

function extractYandexUrls(html) {
  const urls = [];
  const re = /img_url=(https?[^&"\s]+)/g;
  let match;
  while ((match = re.exec(html))) urls.push(decodeUrl(match[1]));
  return uniqueUrls(urls);
}

async function fetchSearch(url, timeoutMs) {
  return fetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept-Language": "es-MX,es;q=0.9,en;q=0.5",
      Accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function searchBing(query, timeoutMs) {
  const endpoint =
    "https://www.bing.com/images/async?q=" +
    encodeURIComponent(query) +
    "&first=0&count=10&adlt=moderate";
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetchSearch(endpoint, timeoutMs);
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`búsqueda HTTP ${response.status}`);
        await sleep(1500 * attempt);
        continue;
      }
      if (!response.ok) throw new Error(`búsqueda HTTP ${response.status}`);
      return extractBingUrls(await response.text());
    } catch (error) {
      lastError = error;
      await sleep(800 * attempt);
    }
  }
  throw lastError || new Error("búsqueda fallida");
}

async function searchYandex(query, timeoutMs) {
  const endpoint = "https://yandex.com/images/search?text=" + encodeURIComponent(query);
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetchSearch(endpoint, timeoutMs);
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`Yandex HTTP ${response.status}`);
        await sleep(1500 * attempt);
        continue;
      }
      if (!response.ok) throw new Error(`Yandex HTTP ${response.status}`);
      return extractYandexUrls(await response.text());
    } catch (error) {
      lastError = error;
      await sleep(800 * attempt);
    }
  }
  throw lastError || new Error("búsqueda fallida");
}

async function searchImages(query, timeoutMs) {
  let lastError;
  try {
    const bing = await searchBing(query, timeoutMs);
    if (bing.length) return bing;
    lastError = new Error("sin resultados");
  } catch (error) {
    lastError = error;
  }
  try {
    const yandex = await searchYandex(query, timeoutMs);
    if (yandex.length) return yandex;
  } catch (error) {
    lastError = error;
  }
  throw lastError || new Error("sin resultados");
}

function sniff(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "png";
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  if (buffer.length >= 6) {
    const head = buffer.toString("ascii", 0, 6);
    if (head === "GIF87a" || head === "GIF89a") return "gif";
  }
  return null;
}

function findExisting(dir, base) {
  for (const ext of EXTS) {
    const abs = path.join(dir, `${base}.${ext}`);
    if (!fs.existsSync(abs)) continue;
    const size = fs.statSync(abs).size;
    if (size >= MIN_BYTES && size <= MAX_BYTES) return { abs, ext, bytes: size };
  }
  return null;
}

async function downloadCandidate(url, timeoutMs) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      Referer: new URL(url).origin + "/",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`descarga HTTP ${response.status}`);
  const type = response.headers.get("content-type") || "";
  if (type && !/image\//i.test(type) && !/octet-stream/i.test(type)) {
    throw new Error(`no es imagen (${type.split(";")[0]})`);
  }
  const length = Number(response.headers.get("content-length") || 0);
  if (length > MAX_BYTES) throw new Error("imagen demasiado grande");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < MIN_BYTES) throw new Error(`imagen pequeña (${buffer.length} B)`);
  if (buffer.length > MAX_BYTES) throw new Error("imagen demasiado grande");
  const ext = sniff(buffer);
  if (!ext) throw new Error("formato no reconocido");
  return { buffer, ext, bytes: buffer.length };
}

function relativeImage(dirName, base, ext) {
  return `img/${dirName}/${base}.${ext}`;
}

function loadState(file) {
  if (!fs.existsSync(file)) return { version: 1, items: {} };
  try {
    const data = loadJson(file);
    if (!data || typeof data.items !== "object" || Array.isArray(data.items)) {
      return { version: 1, items: {} };
    }
    return { version: 1, items: data.items };
  } catch {
    return { version: 1, items: {} };
  }
}

function catalogFrom(source, state) {
  const productos = source.productos.map((product) => {
    if (hasImage(product)) return product;
    const saved = state.items[product.id];
    if (saved?.status === "ok" && saved.imagen) {
      if (saved.manual) return { ...product, imagen: saved.imagen, imagen_manual: true };
      return { ...product, imagen: saved.imagen, imagen_download: true };
    }
    return product;
  });
  return { ...source, productos };
}

function configFromArgs(args) {
  return {
    catalogPath: path.resolve(ROOT, argValue(args, "catalog") || "build/catalogo.json"),
    outPath: path.resolve(ROOT, argValue(args, "out") || "build/catalogo.con-imagenes.json"),
    statePath: path.resolve(ROOT, argValue(args, "estado") || "build/imagenes-descarga-estado.json"),
    imgRoot: path.resolve(ROOT, argValue(args, "img-dir") || "build/img"),
    limit: Math.max(0, integer(argValue(args, "limit"), 0)),
    delayMs: Math.max(0, integer(argValue(args, "delay"), 1200)),
    timeoutMs: Math.max(3000, integer(argValue(args, "timeout"), 20000)),
    candidates: Math.min(10, Math.max(1, integer(argValue(args, "candidatos"), 6))),
    catalogo: (argValue(args, "catalogo") || "").trim(),
    proveedor: (argValue(args, "proveedor") || "").trim(),
    dryRun: flag(args, "dry-run"),
    retryFailed: flag(args, "reintentar-fallos"),
    saveEvery: Math.max(1, integer(argValue(args, "guardar-cada"), 25)),
  };
}

function selectPending(products, cfg, state) {
  const pending = [];
  let reused = 0;
  for (const product of products) {
    if (hasImage(product)) continue;
    if (cfg.catalogo && product.catalogo !== cfg.catalogo) continue;
    if (cfg.proveedor && product.proveedor !== cfg.proveedor) continue;
    const { dirName, base } = fileIdentity(product);
    const dir = path.join(cfg.imgRoot, dirName);
    const existing = findExisting(dir, base);
    const previous = state.items[product.id];
    if (existing && previous?.status !== "fail") {
      state.items[product.id] = {
        status: "ok",
        imagen: relativeImage(dirName, base, existing.ext === "jpeg" ? "jpg" : existing.ext),
        bytes: existing.bytes,
        query: previous?.query || buildQuery(product),
        sourceUrl: previous?.sourceUrl || "",
        at: previous?.at || new Date().toISOString(),
        reused: true,
        ...(previous?.manual ? { manual: true } : {}),
      };
      if (existing.ext === "jpeg") {
        const from = existing.abs;
        const to = path.join(dir, `${base}.jpg`);
        if (from !== to) fs.renameSync(from, to);
        state.items[product.id].imagen = relativeImage(dirName, base, "jpg");
      }
      reused++;
      continue;
    }
    if (previous?.status === "fail" && !cfg.retryFailed) continue;
    if (!buildQuery(product)) {
      state.items[product.id] = {
        status: "fail",
        error: "sin nombre",
        at: new Date().toISOString(),
      };
      continue;
    }
    pending.push(product);
  }
  return { pending, reused };
}

async function downloadForProduct(product, cfg) {
  const query = buildQuery(product);
  const { dirName, base } = fileIdentity(product);
  const dir = path.join(cfg.imgRoot, dirName);
  const urls = await searchImages(query, cfg.timeoutMs);
  if (!urls.length) throw new Error("sin resultados");
  let lastError = "sin candidatos válidos";
  for (const url of urls.slice(0, cfg.candidates)) {
    try {
      const image = await downloadCandidate(url, cfg.timeoutMs);
      fs.mkdirSync(dir, { recursive: true });
      const abs = path.join(dir, `${base}.${image.ext}`);
      fs.writeFileSync(abs, image.buffer);
      return {
        status: "ok",
        imagen: relativeImage(dirName, base, image.ext),
        bytes: image.bytes,
        query,
        sourceUrl: url,
        at: new Date().toISOString(),
      };
    } catch (error) {
      lastError = error.message || String(error);
    }
  }
  throw new Error(lastError);
}

async function main() {
  const cfg = configFromArgs(process.argv.slice(2));
  if (!fs.existsSync(cfg.catalogPath)) {
    throw new Error(`No existe el catálogo: ${cfg.catalogPath}`);
  }
  const source = loadJson(cfg.catalogPath);
  if (!Array.isArray(source.productos)) {
    throw new Error("El catálogo no tiene un arreglo productos.");
  }

  const state = loadState(cfg.statePath);
  const { pending, reused } = selectPending(source.productos, cfg, state);
  const queue = cfg.limit > 0 ? pending.slice(0, cfg.limit) : pending;
  const withImage = source.productos.filter(hasImage).length;

  console.log(`Productos: ${source.productos.length}`);
  console.log(`Con imagen original: ${withImage}`);
  console.log(`Ya descargadas en disco: ${reused}`);
  console.log(`Pendientes de buscar: ${pending.length}`);
  console.log(`Esta corrida: ${queue.length}`);
  console.log(`Salida: ${path.relative(ROOT, cfg.outPath)}`);

  if (cfg.dryRun) {
    for (const product of queue.slice(0, 8)) {
      console.log(`  ${product.id} → ${buildQuery(product)}`);
    }
    writeJsonAtomic(cfg.outPath, catalogFrom(source, state));
    writeJsonAtomic(cfg.statePath, state);
    console.log("Simulación lista. No se descargó ninguna imagen.");
    return;
  }

  let ok = 0;
  let fail = 0;
  let sinceSave = 0;

  const persist = () => {
    writeJsonAtomic(cfg.statePath, state);
    writeJsonAtomic(cfg.outPath, catalogFrom(source, state));
  };

  const onStop = () => {
    persist();
    console.log("\nAvance guardado.");
    process.exit(130);
  };
  process.once("SIGINT", onStop);
  process.once("SIGTERM", onStop);

  for (let i = 0; i < queue.length; i++) {
    const product = queue[i];
    const label = `[${i + 1}/${queue.length}] ${product.id}`;
    try {
      const saved = await downloadForProduct(product, cfg);
      state.items[product.id] = saved;
      ok++;
      sinceSave++;
      console.log(`${label} OK ${saved.imagen} (${Math.round(saved.bytes / 1024)} KB)`);
    } catch (error) {
      const message = error?.name === "TimeoutError" ? "tiempo agotado" : error.message || String(error);
      state.items[product.id] = {
        status: "fail",
        error: message,
        query: buildQuery(product),
        at: new Date().toISOString(),
      };
      fail++;
      sinceSave++;
      console.log(`${label} FALLO ${message}`);
    }
    if (sinceSave >= cfg.saveEvery) {
      persist();
      sinceSave = 0;
    }
    if (i < queue.length - 1 && cfg.delayMs > 0) await sleep(cfg.delayMs);
  }

  persist();
  const catalog = catalogFrom(source, state);
  const downloaded = catalog.productos.filter((product) => product.imagen_download === true).length;
  console.log(`Descargadas en esta corrida: ${ok}`);
  console.log(`Fallos en esta corrida: ${fail}`);
  console.log(`Con imagen_download: ${downloaded}`);
  console.log(`Catálogo: ${path.relative(ROOT, cfg.outPath)}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
