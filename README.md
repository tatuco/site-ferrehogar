# site-ferrehogar

Catálogo de ferretería: descarga de imágenes, subida a Cloudflare R2 y alta en el catálogo de Meta para WhatsApp.

Requiere Node.js 18 o superior. Los scripts no instalan dependencias.

## Convenciones

Los scripts que leen `.env` son `subir-imagenes-r2.mjs` y `subir-catalogo-meta.mjs`. El archivo está en la raíz del proyecto. Una variable ya definida en la terminal tiene prioridad sobre `.env`.

Los booleanos aceptan `1`, `true`, `yes`, `si` y `sí`. Cualquier otro valor cuenta como falso.

Los argumentos con valor aceptan `--nombre valor` y `--nombre=valor`. En `npm run`, los argumentos del script van después de `--`.

`CATALOG_PATH`, `DRY_RUN`, `LIMIT` e `IMAGENES_R2_PATH` las comparten la subida a R2 y la subida a Meta. Definirlas en `.env` cambia los dos comandos. Para un solo comando, pásalas en la terminal.

| Script npm | Comando |
|---|---|
| `npm run subir-imagenes` | `node scripts/subir-imagenes-r2.mjs` |
| `npm run subir-imagenes:dry` | `node scripts/subir-imagenes-r2.mjs --dry-run` |
| `npm run subir-catalogo` | `node scripts/subir-catalogo-meta.mjs` |
| `npm run subir-catalogo:dry` | `node scripts/subir-catalogo-meta.mjs --dry-run` |
| `npm run descargar-imagenes` | `node scripts/descargar-imagenes-faltantes.mjs` |
| `npm run asignar-imagenes-manuales` | `node scripts/asignar-imagenes-manuales.mjs` |

`exportar-inventario.mjs` y `llenar-plantilla-meta.mjs` no tienen script npm.

## Subir imágenes a R2

Sube las fotos referenciadas en el catálogo y escribe el mapa `id` → URL en `build/imagenes-r2.json`. La clave del objeto es `R2_PREFIX` más la ruta de `imagen`, por ejemplo `products/img/angel-light/angel-light-14071.jpg`.

```bash
node scripts/subir-imagenes-r2.mjs [--verificar | --solo-nuevas] [--dry-run] [--limit N]
npm run subir-imagenes -- --solo-nuevas
```

`--help` y `-h` muestran la ayuda. `--verificar` y `--solo-nuevas` no se usan juntos. Lo mismo vale para `VERIFICAR` y `SOLO_NUEVAS` en el entorno. Un flag de la terminal gana sobre esas dos variables.

| Flag | Efecto |
|---|---|
| `--verificar` | Consulta R2 con `HEAD`. Si el objeto existe y el tamaño coincide, no lo vuelve a subir. Si el tamaño cambió, hace `PUT`. Es el modo por defecto. |
| `--solo-nuevas` | No consulta los `id` que ya están en el JSON de salida. Solo procesa los que faltan. `--limit` cuenta solo esas pendientes. Si no hay ninguna, termina sin reescribir el mapa. Las que sí entran siguen haciendo `HEAD` antes del `PUT`. |
| `--dry-run` | Arma el JSON de enlaces sin llamar a R2. |
| `--limit N` | Procesa solo las primeras N imágenes del modo elegido. `0` procesa todas. |

El `PUT` envía `Content-Type: image/jpeg` aunque el archivo sea `.png`, `.webp` o `.gif`.

Si el JSON de salida existe y su `baseUrl` no coincide con `R2_PUBLIC_BASE_URL`, el mapa anterior se descarta.

Obligatorias siempre:

| Variable | Default |
|---|---|
| `R2_BUCKET` | — |
| `R2_PUBLIC_BASE_URL` | URL `http://` o `https://`, sin barra final |

Obligatorias salvo `--dry-run` o `DRY_RUN=true`:

| Variable | Default |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | — |
| `R2_ACCESS_KEY_ID` | — |
| `R2_SECRET_ACCESS_KEY` | — |

Opcionales:

| Variable | Default | Flag equivalente |
|---|---|---|
| `R2_PREFIX` | vacío | — |
| `DRY_RUN` | `false` | `--dry-run` |
| `LIMIT` | `0` | `--limit` |
| `R2_CONCURRENCY` | `6` (entre 1 y 16) | — |
| `CATALOG_PATH` | `build/catalogo.json` | — |
| `IMAGENES_R2_PATH` | `build/imagenes-r2.json` | — |
| `SOLO_NUEVAS` | `false` | `--solo-nuevas` |
| `VERIFICAR` | `false` | `--verificar` |

El catálogo con todas las fotos descargadas se pasa así, sin cambiar `.env`:

```bash
CATALOG_PATH=build/catalogo.con-imagenes.json node scripts/subir-imagenes-r2.mjs --solo-nuevas
```

## Subir catálogo a Meta

Lee el catálogo local y lo envía a Meta con `items_batch`. Si existe el mapa de R2, `image_link` sale de ahí. Si el `id` no está en el mapa, usa `imagen` cuando ya es una URL, o `IMAGE_BASE_URL` más la ruta relativa. Sin imagen, el producto se omite mientras `SKIP_WITHOUT_IMAGE` sea verdadero.

```bash
node scripts/subir-catalogo-meta.mjs [--dry-run] [--link] [--limit N] [--imagenes RUTA]
npm run subir-catalogo -- --limit 20
```

`--help` y `-h` muestran la ayuda.

| Flag | Efecto |
|---|---|
| `--dry-run` | Valida el JSON y escribe el reporte, sin llamar a Graph API. |
| `--link` | Asocia el catálogo a `WHATSAPP_BUSINESS_ACCOUNT_ID`. |
| `--limit N` | Procesa solo los primeros N productos. `0` procesa todos. |
| `--imagenes RUTA` | JSON `id` → URL. Default `build/imagenes-r2.json`. |

Obligatorias para una subida real:

| Variable | Default | Notas |
|---|---|---|
| `META_ACCESS_TOKEN` | — | Permiso `catalog_management`. |
| `META_CATALOG_ID` | — | O `CREATE_CATALOG_IF_MISSING=true` junto con `META_BUSINESS_ID`. |
| `STORE_BASE_URL` | — | `http://` o `https://`. Acepta `{id}`, `{codigo}` y `{catalogo}`. No puede quedar en `ejemplo.com`. |

Con `--link`, también hace falta `WHATSAPP_BUSINESS_ACCOUNT_ID`.

Opcionales:

| Variable | Default | Flag equivalente |
|---|---|---|
| `GRAPH_API_VERSION` | `v25.0` | — |
| `CREATE_CATALOG_IF_MISSING` | `false` | — |
| `META_BUSINESS_ID` | — | — |
| `META_PAGE_ID` | — | — |
| `CATALOG_NAME` | `Ferreteria` | — |
| `LINK_WHATSAPP_CATALOG` | `false` | `--link` |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | — | — |
| `CATALOG_PATH` | `build/catalogo.json` | — |
| `CURRENCY` | `meta.moneda` del JSON | Código ISO 4217. |
| `INCLUDE_IVA` | `false` | Con `true`, envía precio × (1 + `IVA_RATE`). |
| `IVA_RATE` | `0.16` | Número ≥ 0. |
| `IMAGE_BASE_URL` | — | Prefijo público de las rutas relativas. |
| `IMAGENES_R2_PATH` | `build/imagenes-r2.json` | `--imagenes` |
| `PLACEHOLDER_IMAGE_URL` | — | Solo si `SKIP_WITHOUT_IMAGE=false`. |
| `SKIP_WITHOUT_IMAGE` | `true` | — |
| `DEFAULT_AVAILABILITY` | `available for order` | `in stock`, `out of stock`, `available for order`, `discontinued`. |
| `DEFAULT_CONDITION` | `new` | `new`, `refurbished`, `used`. |
| `PRESERVE_CASE` | `false` | `true` conserva las mayúsculas del catálogo. |
| `BATCH_METHOD` | `UPDATE` | `CREATE` o `UPDATE`. |
| `ALLOW_UPSERT` | `true` | Con `UPDATE`, crea el producto si no existe. |
| `BATCH_SIZE` | `2000` | Entre 1 y 5000. Meta recomienda menos de 3000. |
| `BATCH_DELAY_MS` | `1000` | Pausa entre lotes. |
| `DRY_RUN` | `false` | `--dry-run` |
| `LIMIT` | `0` | `--limit` |
| `FILTER_PROVEEDOR` | — | Solo ese `proveedor`. |
| `FILTER_CATALOGO` | — | Solo ese `catalogo`. |
| `POLL_INTERVAL_MS` | `5000` | Mínimo 1000. |
| `POLL_TIMEOUT_MS` | `600000` | Mínimo 5000. |
| `REPORT_PATH` | `build/meta-upload-report.json` | — |

La plantilla de estas variables está en `.env.example`.

## Descargar imágenes faltantes

Busca una imagen para cada producto sin `imagen`, la guarda en `build/img/<catalogo>/` y escribe un catálogo nuevo. El avance queda en `build/imagenes-descarga-estado.json`. Si el archivo ya está en disco, no vuelve a buscarlo. No lee `.env`.

```bash
node scripts/descargar-imagenes-faltantes.mjs
npm run descargar-imagenes -- --limit 20 --catalogo jesus
```

| Flag | Default | Efecto |
|---|---|---|
| `--catalog` | `build/catalogo.json` | Catálogo de entrada. |
| `--out` | `build/catalogo.con-imagenes.json` | Catálogo de salida. |
| `--estado` | `build/imagenes-descarga-estado.json` | Avance reanudable. |
| `--img-dir` | `build/img` | Carpeta de las fotos. |
| `--limit` | `0` | Máximo de búsquedas nuevas. `0` recorre todas las pendientes. |
| `--delay` | `1200` | Milisegundos entre búsquedas. |
| `--timeout` | `20000` | Milisegundos por descarga. Mínimo 3000. |
| `--candidatos` | `6` | Candidatas por producto, entre 1 y 10. |
| `--catalogo` | — | Solo ese id de catálogo. |
| `--proveedor` | — | Solo ese proveedor. |
| `--dry-run` | apagado | No descarga imágenes. Igual escribe el catálogo de salida y el archivo de estado. |
| `--reintentar-fallos` | apagado | Vuelve a buscar los `id` marcados como fallo. |
| `--guardar-cada` | `25` | Persiste el estado cada N productos. Mínimo 1. |

## Asignar imágenes manuales

Copia fotos desde `build/img-manuales` al producto cuyo nombre de archivo es `<catalogo>-<codigo>`. Escribe la ruta en el catálogo y el estado de descarga. No lee `.env`.

```bash
node scripts/asignar-imagenes-manuales.mjs
npm run asignar-imagenes-manuales -- --dry-run
```

| Flag | Default | Efecto |
|---|---|---|
| `--dir` | `build/img-manuales` | Carpeta de origen. Tiene que existir. |
| `--catalog` | `build/catalogo.con-imagenes.json` | Catálogo que se actualiza. |
| `--estado` | `build/imagenes-descarga-estado.json` | Estado que se actualiza. |
| `--img-dir` | `build/img` | Destino de las copias. |
| `--dry-run` | apagado | Informa las asignaciones sin copiar ni escribir. |
| `--reemplazar` | apagado | Sustituye una imagen cuyo archivo ya existe. Sin este flag, ese archivo se deja como está. |

Acepta `.jpg`, `.jpeg`, `.png`, `.webp` y `.gif`. Un nombre con espacios o sin punto antes de la extensión también puede coincidir. Si el nombre corresponde a cero productos o a más de uno, no se asigna.

## Actualizar las fotos del sitio

`build/index.html` no lee `imagenes-r2.json`. Carga `build/datos.js` y muestra `imagen` de cada producto. Esas rutas son locales (`img/...`), relativas a `build/`.

Este comando regenera `datos.js` desde el catálogo que ya tiene todas las fotos:

```bash
node --input-type=module -e '
import fs from "node:fs";
const raw = fs.readFileSync("build/catalogo.con-imagenes.json", "utf8").trim();
JSON.parse(raw);
fs.writeFileSync("build/datos.js", `window.CATALOGO = ${raw};\n`);
'
```

Después recarga `build/index.html`.

## Exportar inventario

Sin flags. Lee `build/catalogo.json` y escribe `build/inventario.csv`.

```bash
node scripts/exportar-inventario.mjs
```

El CSV sale en UTF-8 con BOM, separador `;` y una primera fila `sep=;` para Excel. Las columnas siguen `meta.campos`. Un campo extra de algún producto, como `imagen`, se agrega al final.

## Llenar plantilla de Meta

Sin flags. Lee `build/catalogo.json` y `build/imagenes-r2.json`, y escribe `build/catalog_products.csv`.

```bash
node scripts/llenar-plantilla-meta.mjs
```

Incluye solo productos que tienen URL en el mapa de R2. `image_link` es esa URL. El precio y el enlace de WhatsApp están fijos en el script.
