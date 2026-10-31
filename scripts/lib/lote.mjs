/**
 * CSV de ingreso (sep=;). Una celda vacía no pisa el valor anterior.
 * Si alguna fila está mal, el archivo entero se rechaza.
 *
 * El id nuevo es catalogo-codigo. Un producto que ya existe se busca por
 * catalogo y codigo guardados: el id histórico a veces está en minúsculas,
 * sin el guion final o con un sufijo, y no se vuelve a calcular.
 */

export const COLUMNAS = [
  "proveedor",
  "catalogo",
  "codigo",
  "nombre",
  "precio",
  "unidad",
  "referencia",
  "marca",
  "existencia",
  "descuento",
  "precioFinal",
  "categoria",
  "subcategoria",
  "rubro",
  "detalle",
  "empaque",
  "medida",
  "barra",
];

const REQUERIDAS = ["proveedor", "catalogo", "codigo", "nombre", "precio", "unidad"];
const NUMERICAS = new Set(["precio", "existencia", "descuento", "precioFinal"]);

export function numeroCelda(raw) {
  let text = String(raw).trim().replace(/\s/g, "");
  if (/^[+-]?\d{1,3}(\.\d{3})+(,\d+)?$/.test(text)) {
    text = text.replace(/\./g, "").replace(",", ".");
  } else if (text.includes(",") && !text.includes(".")) {
    text = text.replace(",", ".");
  }
  if (!/^[+-]?\d+(\.\d+)?$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

export function crearIndice(productos) {
  const porId = new Map();
  const porClave = new Map();
  for (const producto of productos) {
    registrar(porId, porClave, producto.id, producto.catalogo, producto.codigo);
  }
  return { porId, porClave };
}

function registrar(porId, porClave, id, catalogo, codigo) {
  porId.set(id, id);
  const clave = `${catalogo}\t${codigo}`;
  const lista = porClave.get(clave) || [];
  if (!lista.includes(id)) lista.push(id);
  porClave.set(clave, lista);
}

export function reservarFilas(indice, filas) {
  for (const fila of filas) {
    if (!fila.alta) continue;
    registrar(indice.porId, indice.porClave, fila.id, fila.campos.catalogo, fila.campos.codigo);
  }
}

export function partirCsv(text) {
  let source = String(text);
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  const filas = [];
  let celdas = [];
  let campo = "";
  let entreComillas = false;
  let linea = 1;
  let lineaFila = 1;

  function cerrarFila() {
    celdas.push(campo);
    filas.push({ linea: lineaFila, celdas });
    celdas = [];
    campo = "";
    linea += 1;
    lineaFila = linea;
  }

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (entreComillas) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          campo += '"';
          i += 1;
        } else {
          entreComillas = false;
        }
      } else {
        if (char === "\n") linea += 1;
        campo += char;
      }
      continue;
    }
    if (char === '"') {
      entreComillas = true;
    } else if (char === ";") {
      celdas.push(campo);
      campo = "";
    } else if (char === "\n") {
      cerrarFila();
    } else if (char !== "\r") {
      campo += char;
    }
  }
  if (campo.length || celdas.length) cerrarFila();
  return filas.filter((fila) => !(fila.celdas.length === 1 && fila.celdas[0].trim() === ""));
}

function esSep(fila) {
  return /^sep\s*=/i.test(fila.celdas.join(";").trim());
}

/**
 * @param {string} text
 * @param {{ porId: Map<string, string>, porClave: Map<string, string[]> }} indice
 */
export function validarLote(text, indice) {
  const errores = [];
  const crudas = partirCsv(text);
  let header = null;
  const datos = [];

  for (const fila of crudas) {
    if (esSep(fila)) continue;
    if (!header) {
      header = fila.celdas.map((celda) => celda.trim().toLowerCase());
      continue;
    }
    datos.push(fila);
  }

  if (!header) {
    return { errores: ["El CSV no tiene fila de columnas."], filas: [] };
  }

  const nombres = header.filter(Boolean);
  const repetidas = nombres.filter((nombre, index) => nombres.indexOf(nombre) !== index);
  if (repetidas.length) {
    errores.push(`Columnas repetidas: ${[...new Set(repetidas)].join(", ")}.`);
  }
  const desconocidas = [...new Set(nombres.filter((nombre) => !COLUMNAS.includes(nombre)))];
  if (desconocidas.length) {
    errores.push(`Columnas desconocidas: ${desconocidas.join(", ")}.`);
  }
  const faltan = REQUERIDAS.filter((nombre) => !nombres.includes(nombre));
  if (faltan.length) {
    errores.push(`Faltan columnas: ${faltan.join(", ")}.`);
  }
  if (errores.length) return { errores, filas: [] };

  const columnas = new Map();
  header.forEach((nombre, index) => {
    if (nombre && !columnas.has(nombre)) columnas.set(nombre, index);
  });

  const vistos = new Map();
  const filas = [];

  for (const fila of datos) {
    const leer = (columna) => {
      const index = columnas.get(columna);
      if (index === undefined) return "";
      return String(fila.celdas[index] ?? "").trim();
    };
    if (COLUMNAS.every((columna) => leer(columna) === "")) continue;

    const catalogo = leer("catalogo");
    const codigo = leer("codigo");
    if (!catalogo || !codigo) {
      errores.push(`Fila ${fila.linea}: hacen falta catalogo y codigo.`);
      continue;
    }

    const clave = `${catalogo}\t${codigo}`;
    if (vistos.has(clave)) {
      errores.push(
        `Fila ${fila.linea}, campo codigo: ${catalogo}-${codigo} ya está en la fila ${vistos.get(clave)}.`,
      );
      continue;
    }
    vistos.set(clave, fila.linea);

    const coincidencias = indice.porClave.get(clave) || [];
    const idNuevo = `${catalogo}-${codigo}`;
    let id = idNuevo;
    let alta = false;
    if (coincidencias.length > 1) {
      errores.push(
        `Fila ${fila.linea}: ${catalogo} / ${codigo} coincide con más de un producto (${coincidencias.join(", ")}).`,
      );
      continue;
    }
    if (coincidencias.length === 1) {
      id = coincidencias[0];
    } else if (indice.porId.has(idNuevo)) {
      errores.push(
        `Fila ${fila.linea}: el id ${idNuevo} ya pertenece a otro producto y el codigo no coincide.`,
      );
      continue;
    } else {
      alta = true;
    }

    const campos = {};
    let filaRota = false;
    for (const columna of COLUMNAS) {
      if (!columnas.has(columna)) continue;
      const raw = leer(columna);
      if (raw === "") continue;
      if (NUMERICAS.has(columna)) {
        const valor = numeroCelda(raw);
        if (valor === null || valor < 0) {
          errores.push(`Fila ${fila.linea}, campo ${columna}: no es un número válido.`);
          filaRota = true;
          continue;
        }
        campos[columna] = valor;
      } else {
        campos[columna] = raw;
      }
    }

    if (alta) {
      for (const columna of ["proveedor", "nombre", "unidad"]) {
        if (!campos[columna]) {
          errores.push(`Fila ${fila.linea}: alta de ${id} sin campo ${columna}.`);
          filaRota = true;
        }
      }
      if (campos.precio === undefined && leer("precio") === "") {
        errores.push(`Fila ${fila.linea}: alta de ${id} sin campo precio.`);
        filaRota = true;
      }
    }

    if (!filaRota) filas.push({ linea: fila.linea, id, alta, campos });
  }

  if (errores.length) return { errores, filas: [] };
  return { errores: [], filas };
}

export function aplicarFilas(db, filas) {
  const porId = new Map(db.productos.map((producto) => [producto.id, producto]));
  let altas = 0;
  let actualizaciones = 0;

  for (const fila of filas) {
    if (fila.alta || !porId.has(fila.id)) {
      const producto = { id: fila.id, ...fila.campos };
      db.productos.push(producto);
      porId.set(fila.id, producto);
      altas += 1;
      continue;
    }
    const producto = porId.get(fila.id);
    let cambio = false;
    for (const [campo, valor] of Object.entries(fila.campos)) {
      if (producto[campo] !== valor) cambio = true;
      producto[campo] = valor;
    }
    if (cambio) actualizaciones += 1;
  }

  return { altas, actualizaciones };
}
