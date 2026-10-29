# Catálogo General de Proveedores

Sitio estático para consultar, filtrar, comparar y exportar los catálogos unificados.

## Archivos entregados
- `index.html` - Aplicación web (vanilla JS, sin framework)
- `datos.js` - Datos en formato `window.CATALOGO = {...}` (necesario para abrir con `file://`)
- `catalogo.json` - Mismo contenido en JSON puro (fuente única para regenerar)

## Orígenes
Se generó desde los PDFs en `C:\Users\Tatico\OneDrive\Desktop\catalogo de proveedores\` (14 catálogos, 6 proveedores distintos). El nombre del proveedor se toma del sufijo/contacto del nombre del archivo (ej. `raul`, `jesus`, `marino`, `lorena`, `stefany`, `jennifer heraldo`).

## Esquema `catalogo.json`
```json
{
  "meta": {
    "version": "2.0",
    "generado": "YYYY-MM-DD",
    "fuente": "C:\\...\\catalogo de proveedores",
    "totalProductos": 16510,
    "totalProveedores": 6,
    "totalCatalogos": 14,
    "preciosSinIVA": true,
    "moneda": "MXN"
  },
  "proveedores": [{"id": "...", "nombre": "...", "contacto": "..."}],
  "catalogos": [{"id": "...", "nombre": "...", "proveedor": "...", "archivo": "...", "familia": "...", "columnas": {...}}],
  "productos": [{
    "id": "<catalogo>-<codigo>",
    "proveedor": "...",
    "catalogo": "...",
    "codigo": "...",
    "referencia": "...",
    "nombre": "...",
    "precio": 0.00,
    "precioFinal": 0.00,
    "descuento": 0,
    "unidad": "PZA|CAJA|KG|...",
    "ventaMinima": 1,
    "ventaMaxima": null,
    "marca": "...",
    "marcaOriginal": "...|''",
    "existencia": 0,
    "empaque": "...",
    "bulto": "...",
    "subEmpaque": "...",
    "medida": "...",
    "barra": "...",
    "categoria": "...",
    "subcategoria": "...",
    "rubro": "...",
    "pagina": 1,
    "detalle": "..."
  }],
  "resumen": {"porProveedor": {...}, "porCatalogo": {...}}
}
```

## Comportamiento del sitio
- **Filtros**: Proveedor, Catálogo, Marca, Rubro, Unidad. Rango de precios. Solo con precio / Solo con stock.
- **Búsqueda**: insensible a acentos/espacios/signos, busca en nombre, código, marca, referencia, catálogo y proveedor.
- **Comparar catálogos** (`Comparar catálogos`): muestra precio más barato en otro catálogo.
  - `mejor:` = mismo producto (clave por nombre normalizado).
  - `equivale en:` = producto equivalente (misma familia, sin medidas/marca), puede tener diferente medida.
- **Comparador manual** (`＋` / `Comparar (n)`): selecciona productos para verlos lado a lado.
- **Exportar**: CSV (`sep=;` con BOM UTF-8) y Excel (.XLSX nativo con SheetJS, con fallback HTML .xls).
- **URL compartible**: filtros/orden/página/comparación se guardan en el hash.
- **Tema claro/oscuro**, responsive, paginación.

## Codificación
- Todos los archivos `.json` y `.js` deben conservar **UTF-8 sin BOM** (el sitio carga `datos.js` vía `<script>`).
- CSV exportado incluye **BOM UTF-8** y separador `;` para compatibilidad con Excel en español.
- Los nombres con acentos se muestran correctamente.

## Regenerar
Requiere PowerShell 5.1 (sin Python/Node en este equipo).

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\Build-Catalogo.ps1"
```

El script lee los PDFs desde el escritorio, normaliza unidades/medidas, asigna marca cuando falta (usando el nombre comercial del catálogo), calcula descuentos/precios finales, genera `build\catalogo.json` y `build\datos.js`, y copia el sitio a `build\`.

**Importante:** Al editar scripts `.ps1`, guardarlos con **UTF-8 BOM** (el sistema tiene cultura `es-VE` y PowerShell 5.1 lee sin BOM como ANSI).

## Notas sobre los datos
- **Moneda**: MXN. **Los precios no incluyen IVA** (verificado en FERRE-EXPORT).
- `7,992` productos sin marca declarada en origen → se usa el nombre comercial del catálogo como marca (con `marcaOriginal = ""`).
- Unidades normalizadas (`PZA`, `CAJA`, `KG`, `MT`, `ROLLO`, `JUEGO`, etc.). Columna numérica `u` de WOKIN se mapea a `ventaMinima`.
- Descuentos aplicados según columna `dcto` (cuando existe). `precioFinal` puede diferir de `precio`.
- 4 productos sin precio, 17 con precio 0, 2 sin nombre (se conservan). Se corrigieron 6 pares `(catálogo, código)` duplicados asignando sufijos únicos.
- Los valores de `familia` son identificadores internos de las hojas/tablas originales (conservados para trazabilidad).
