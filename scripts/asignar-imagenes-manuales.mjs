#!/usr/bin/env node
/**
 * Asigna las fotos de build/img-manuales al producto cuyo nombre de archivo
 * es <catalogo>-<codigo>. Copia cada archivo a build/img/<catalogo>/ con el
 * nombre limpio y escribe la ruta en el catálogo.
 *
 * Un archivo "la-occidental-5-1762 .webp" o "abrasivos-fes-131webp" igual
 * encuentra el producto. Solo respeta una imagen ya puesta si el archivo existe
 * en build/ más la ruta del JSON. Si la ruta está escrita y el archivo no, lo copia.
 *
 *   node scripts/asignar-imagenes-manuales.mjs
 *   node scripts/asignar-imagenes-manuales.mjs --dry-run
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXTS = ["jpg", "jpeg", "png", "webp", "gif"];

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

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function norm(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\\/]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
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

function sniff(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
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

function stemOf(filename) {
  let base = filename.trim();
  const dotted = base.match(new RegExp(`^(.*)\\.(${EXTS.join("|")})$`, "i"));
  if (dotted) return dotted[1].trim();
  const stuck = base.match(new RegExp(`^(.*)(${EXTS.join("|")})$`, "i"));
  if (stuck) return stuck[1].trim();
  return base;
}

function matchProduct(stem, productos, catalogos) {
  const cleaned = norm(stem);
  const catalogo = catalogos.find((id) => cleaned.startsWith(`${norm(id)}-`));
  if (!catalogo) return [];
  const codigo = cleaned.slice(norm(catalogo).length + 1);
  return productos.filter((product) => {
    if (product.catalogo !== catalogo) return false;
    return norm(product.codigo) === codigo || norm(product.id) === cleaned;
  });
}

function imageOnDisk(catalogDir, relative) {
  const rel = String(relative || "").trim().replace(/^[/\\]+/, "");
  if (!rel || rel.includes("\0")) return null;
  const root = path.resolve(catalogDir);
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size < 1) return null;
    return abs;
  } catch {
    return null;
  }
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

function main() {
  const args = process.argv.slice(2);
  const manualDir = path.resolve(ROOT, argValue(args, "dir") || "build/img-manuales");
  const catalogPath = path.resolve(ROOT, argValue(args, "catalog") || "build/catalogo.con-imagenes.json");
  const statePath = path.resolve(ROOT, argValue(args, "estado") || "build/imagenes-descarga-estado.json");
  const imgRoot = path.resolve(ROOT, argValue(args, "img-dir") || "build/img");
  const dryRun = flag(args, "dry-run");
  const replace = flag(args, "reemplazar");

  if (!fs.existsSync(manualDir)) throw new Error(`No existe la carpeta: ${manualDir}`);
  if (!fs.existsSync(catalogPath)) throw new Error(`No existe el catálogo: ${catalogPath}`);

  const catalogDir = path.dirname(catalogPath);
  const catalog = loadJson(catalogPath);
  if (!Array.isArray(catalog.productos)) throw new Error("El catálogo no tiene un arreglo productos.");
  const state = loadState(statePath);
  const catalogos = [...new Set(catalog.productos.map((product) => product.catalogo).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );

  const files = fs.readdirSync(manualDir).filter((name) => {
    if (name.startsWith(".")) return false;
    return fs.statSync(path.join(manualDir, name)).isFile();
  });

  let assigned = 0;
  let skipped = 0;
  const usedIds = new Set();

  for (const name of files) {
    const stem = stemOf(name);
    const matches = matchProduct(stem, catalog.productos, catalogos);
    if (matches.length !== 1) {
      skipped++;
      console.log(`${name} SIN ASIGNAR (${matches.length} coincidencias)`);
      continue;
    }
    const product = matches[0];
    if (usedIds.has(product.id)) {
      skipped++;
      console.log(`${name} SIN ASIGNAR (otro archivo ya usó ${product.id})`);
      continue;
    }
    const current = String(product.imagen || "").trim();
    const currentFile = imageOnDisk(catalogDir, current);
    if (current && currentFile && !replace) {
      skipped++;
      console.log(`${name} YA ESTÁ ${path.relative(ROOT, currentFile)}`);
      continue;
    }
    if (current && !currentFile) {
      console.log(`${name} el JSON dice ${current} y el archivo no está`);
    }

    const source = path.join(manualDir, name);
    const buffer = fs.readFileSync(source);
    const ext = sniff(buffer);
    if (!ext) {
      skipped++;
      console.log(`${name} SIN ASIGNAR (no es jpg, png, webp ni gif)`);
      continue;
    }

    const dirName = safePart(product.catalogo);
    const base = `${dirName}-${safePart(product.codigo)}`;
    const relative = `img/${dirName}/${base}.${ext}`;
    const dest = path.join(imgRoot, dirName, `${base}.${ext}`);
    usedIds.add(product.id);

    if (!dryRun) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buffer);
      product.imagen = relative;
      product.imagen_manual = true;
      delete product.imagen_download;
      state.items[product.id] = {
        status: "ok",
        imagen: relative,
        bytes: buffer.length,
        manual: true,
        at: new Date().toISOString(),
      };
    }
    assigned++;
    console.log(`${name} → ${product.id} ${relative} (${Math.round(buffer.length / 1024)} KB)`);
  }

  if (!dryRun) {
    writeJsonAtomic(catalogPath, catalog);
    writeJsonAtomic(statePath, state);
  }
  console.log(`Asignadas: ${assigned}`);
  console.log(`Sin asignar: ${skipped}`);
  console.log(`Catálogo: ${path.relative(ROOT, catalogPath)}`);
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
