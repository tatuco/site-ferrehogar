#!/usr/bin/env node
/**
 * Sube las fotos referenciadas en el catálogo a un bucket de Cloudflare R2
 * y escribe un JSON con la URL pública de cada id de producto.
 *
 * La clave del objeto es R2_PREFIX más la ruta del catálogo, por ejemplo
 * products/img/angel-light/angel-light-14071.jpg. La URL queda en
 * build/imagenes-r2.json para que subir-catalogo-meta.mjs la use como image_link.
 *
 * Requiere Node.js 18 o superior (fetch nativo). Sin dependencias.
 * El bucket tiene que existir y servir lectura pública (r2.dev o dominio propio);
 * si no, Meta no puede descargar la imagen.
 *
 * Variables en .env:
 *   CLOUDFLARE_ACCOUNT_ID
 *   R2_ACCESS_KEY_ID
 *   R2_SECRET_ACCESS_KEY
 *   R2_BUCKET
 *   R2_PUBLIC_BASE_URL
 *
 * Opcionales: R2_PREFIX, DRY_RUN, LIMIT, R2_CONCURRENCY, IMAGENES_R2_PATH, CATALOG_PATH.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EMPTY_PAYLOAD_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const REGION = "auto";
const SERVICE = "s3";

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
  if (!value) throw new Error(`Falta ${name} en .env`);
  return value;
}

function isHttp(url) {
  return /^https?:\/\//i.test(url);
}

function joinUrl(base, relative) {
  return `${String(base).replace(/\/+$/, "")}/${String(relative).replace(/^\/+/, "")}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function help() {
  console.log(`Uso:
  node scripts/subir-imagenes-r2.mjs [--dry-run] [--limit N]

Lee el catálogo, sube cada JPG referenciado a R2 y escribe el mapa id → URL.

  --dry-run   Arma el JSON de enlaces sin llamar a R2.
  --limit N   Procesa solo las primeras N imágenes.

Variables: CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
R2_BUCKET y R2_PUBLIC_BASE_URL. R2_PREFIX es la carpeta dentro del bucket.
`);
}

function readConfig(args) {
  const dryRun = flag(args, "dry-run") || bool(process.env.DRY_RUN, false);
  const limit = integer(argValue(args, "limit") ?? process.env.LIMIT, 0);
  const concurrency = Math.min(16, Math.max(1, integer(process.env.R2_CONCURRENCY, 6)));
  const publicBaseUrl = String(process.env.R2_PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  const cfg = {
    dryRun,
    limit,
    concurrency,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID || "",
    accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
    bucket: process.env.R2_BUCKET || "",
    prefix: String(process.env.R2_PREFIX || "").replace(/^\/+|\/+$/g, ""),
    publicBaseUrl,
    catalogPath: path.resolve(ROOT, process.env.CATALOG_PATH || "build/catalogo.json"),
    outputPath: path.resolve(ROOT, process.env.IMAGENES_R2_PATH || "build/imagenes-r2.json"),
  };

  required("R2_BUCKET", cfg.bucket);
  required("R2_PUBLIC_BASE_URL", cfg.publicBaseUrl);
  if (!isHttp(cfg.publicBaseUrl)) {
    throw new Error("R2_PUBLIC_BASE_URL debe empezar por http:// o https://");
  }
  if (!cfg.dryRun) {
    required("CLOUDFLARE_ACCOUNT_ID", cfg.accountId);
    required("R2_ACCESS_KEY_ID", cfg.accessKeyId);
    required("R2_SECRET_ACCESS_KEY", cfg.secretAccessKey);
  }
  return cfg;
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest();
}

function signingKey(secret, dateStamp) {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  return hmac(kService, "aws4_request");
}

function awsEncode(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodeObjectKey(key) {
  return key.split("/").map(awsEncode).join("/");
}

function amzTimestamp(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function signedRequest(cfg, { method, key, body, contentType }) {
  const host = `${cfg.accountId}.r2.cloudflarestorage.com`.toLowerCase();
  const canonicalUri = `/${awsEncode(cfg.bucket)}/${encodeObjectKey(key)}`;
  const now = new Date();
  const amzDate = amzTimestamp(now);
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = body ? sha256(body) : EMPTY_PAYLOAD_HASH;
  const headers = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (contentType) headers["content-type"] = contentType;

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${String(headers[name]).trim()}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    method,
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256(canonicalRequest),
  ].join("\n");
  const signature = crypto
    .createHmac("sha256", signingKey(cfg.secretAccessKey, dateStamp))
    .update(stringToSign)
    .digest("hex");
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const requestHeaders = {
    Authorization: authorization,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (contentType) requestHeaders["content-type"] = contentType;

  return fetch(`https://${host}${canonicalUri}`, {
    method,
    headers: requestHeaders,
    body: body ?? undefined,
  });
}

async function r2Request(cfg, options, attempt = 0) {
  const response = await signedRequest(cfg, options);
  if (options.method === "HEAD" && response.status === 404) {
    await response.arrayBuffer().catch(() => {});
    return response;
  }
  if (response.ok) return response;

  const retryable = response.status === 429 || response.status >= 500;
  const detail = await response.text().catch(() => "");
  if (retryable && attempt < 5) {
    const wait = Math.min(60000, 1000 * 2 ** attempt);
    console.log(
      `R2 ${options.method} respondió ${response.status}. Reintento ${attempt + 1} en ${Math.round(wait / 1000)} s.`,
    );
    await sleep(wait);
    return r2Request(cfg, options, attempt + 1);
  }
  throw new Error(
    `R2 ${options.method} ${options.key} respondió ${response.status}: ${detail.slice(0, 300)}`,
  );
}

function imageFile(catalogPath, relative) {
  const base = path.resolve(path.dirname(catalogPath));
  const file = path.resolve(base, relative);
  if (file !== base && !file.startsWith(`${base}${path.sep}`)) {
    throw new Error(`Ruta de imagen fuera del catálogo: ${relative}`);
  }
  return file;
}

function collectImages(cfg) {
  const raw = JSON.parse(fs.readFileSync(cfg.catalogPath, "utf8"));
  const products = Array.isArray(raw.productos) ? raw.productos : [];
  const images = [];
  const seen = new Set();
  for (const product of products) {
    const id = product?.id ? String(product.id).trim() : "";
    const relative = product?.imagen ? String(product.imagen).trim() : "";
    if (!id || !relative || seen.has(id)) continue;
    seen.add(id);
    const relativeKey = relative.replace(/^\/+/, "");
    images.push({
      id,
      key: cfg.prefix ? `${cfg.prefix}/${relativeKey}` : relativeKey,
      file: imageFile(cfg.catalogPath, relative),
    });
  }
  return cfg.limit > 0 ? images.slice(0, cfg.limit) : images;
}

function readExisting(file, publicBaseUrl) {
  if (!fs.existsSync(file)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!data || typeof data.imagenes !== "object" || Array.isArray(data.imagenes)) return {};
    if (data.baseUrl && String(data.baseUrl).replace(/\/+$/, "") !== publicBaseUrl) {
      console.log("El JSON anterior usa otra URL pública. Se reemplaza el mapa.");
      return {};
    }
    return { ...data.imagenes };
  } catch {
    console.log("El JSON anterior no se pudo leer. Se escribirá uno nuevo.");
    return {};
  }
}

function writeMap(cfg, imagenes) {
  const doc = {
    generado: new Date().toISOString(),
    bucket: cfg.bucket,
    baseUrl: cfg.publicBaseUrl,
    total: Object.keys(imagenes).length,
    imagenes,
  };
  fs.mkdirSync(path.dirname(cfg.outputPath), { recursive: true });
  const tmp = `${cfg.outputPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  fs.renameSync(tmp, cfg.outputPath);
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
  const workers = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workers }, () => run()));
}

async function uploadOne(cfg, item) {
  const body = fs.readFileSync(item.file);
  const head = await r2Request(cfg, { method: "HEAD", key: item.key });
  if (head.ok) {
    const remoteSize = Number(head.headers.get("content-length"));
    if (remoteSize === body.length) return "existente";
  }
  const put = await r2Request(cfg, {
    method: "PUT",
    key: item.key,
    body,
    contentType: "image/jpeg",
  });
  await put.arrayBuffer().catch(() => {});
  return "subida";
}

async function main() {
  const args = process.argv.slice(2);
  if (flag(args, "help") || flag(args, "h")) {
    help();
    return;
  }

  loadEnv(path.join(ROOT, ".env"));
  const cfg = readConfig(args);
  const images = collectImages(cfg);
  if (!images.length) throw new Error("El catálogo no tiene productos con imagen.");

  const imagenes = readExisting(cfg.outputPath, cfg.publicBaseUrl);
  const stats = { subidas: 0, existentes: 0, simuladas: 0, omitidas: 0, errores: 0 };
  let done = 0;
  let writeChain = Promise.resolve();

  function persist() {
    const task = writeChain.then(() => writeMap(cfg, imagenes));
    writeChain = task.catch(() => {});
    return task;
  }

  console.log(
    `${cfg.dryRun ? "Simulación" : "Subida"}: ${images.length} imágenes hacia ${cfg.bucket}.`,
  );

  await pool(images, cfg.dryRun ? 1 : cfg.concurrency, async (item) => {
    if (!fs.existsSync(item.file)) {
      stats.omitidas += 1;
      console.log(`Sin archivo local: ${item.key}`);
    } else {
      try {
        const outcome = cfg.dryRun ? "simulada" : await uploadOne(cfg, item);
        if (outcome === "existente") stats.existentes += 1;
        else if (outcome === "subida") stats.subidas += 1;
        else stats.simuladas += 1;
        imagenes[item.id] = joinUrl(cfg.publicBaseUrl, item.key);
      } catch (error) {
        stats.errores += 1;
        console.log(`${item.id}: ${error.message}`);
      }
    }

    done += 1;
    if (done % 25 === 0 || done === images.length) await persist();
    if (done % 50 === 0 || done === images.length) {
      console.log(
        `Progreso ${done}/${images.length}: subidas ${stats.subidas}, existentes ${stats.existentes}, simuladas ${stats.simuladas}, omitidas ${stats.omitidas}, errores ${stats.errores}.`,
      );
    }
  });

  await persist();
  console.log(`Mapa: ${path.relative(ROOT, cfg.outputPath)} (${Object.keys(imagenes).length} enlaces).`);
  if (stats.errores) {
    throw new Error(`${stats.errores} imágenes no se pudieron subir. El mapa guarda las que sí quedaron.`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
