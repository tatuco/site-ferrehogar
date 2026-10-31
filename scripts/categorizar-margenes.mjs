#!/usr/bin/env node
/**
 * Asigna a cada producto la categoría comercial y el margen de inicio
 * de la tabla de ferretería (obra negra, instalaciones, herramientas,
 * cerrajería/consumibles/pinturas). Lo que no entra en esas familias
 * queda en Otros, con margen 15%–18%.
 *
 * La señal principal es el nombre. La categoría original desempata.
 * El rubro solo se usa cuando el nombre no alcanza, y nunca mete un
 * producto en obra negra: ese rubro del catálogo está mezclado.
 *
 * Uso:
 *   node scripts/categorizar-margenes.mjs --auditar
 *   node scripts/categorizar-margenes.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRADA = path.join(ROOT, "build", "catalogo.con-imagenes.json");
const SALIDA = path.join(ROOT, "build", "catalogo.categorizado.json");

export const CATEGORIAS = {
  "obra-negra-estructural": {
    nombre: "Obra Negra / Estructural",
    margenMin: 8,
    margenMax: 10,
    margenRecomendado: "8% - 10%",
    razon:
      "Son productos de altísimo volumen y precio muy sensible en el mercado.",
    ejemplos: "Cemento, cabilla, bloques, tubos estructurales",
  },
  "griferia-electricidad-plomeria": {
    nombre: "Grifería, Electricidad y Plomería",
    margenMin: 15,
    margenMax: 18,
    margenRecomendado: "15% - 18%",
    razon:
      "Tienen rotación media y las ferreterías de mostrador les aplican hasta un 35%.",
    ejemplos: "Breakers, cables, conexiones PVC/PEX, iluminación",
  },
  herramientas: {
    nombre: "Herramientas (Manuales y Eléctricas)",
    margenMin: 12,
    margenMax: 15,
    margenRecomendado: "12% - 15%",
    razon:
      "Tienen precios de lista conocidos; competir aquí atrae a clientes profesionales.",
    ejemplos: "Taladros, llaves, alicates, dados, medición",
  },
  "cerrajeria-consumibles-pinturas": {
    nombre: "Cerrajería, Consumibles y Pinturas",
    margenMin: 18,
    margenMax: 20,
    margenRecomendado: "18% - 20%",
    razon:
      "Productos menores donde el cliente no compara tanto el precio centavo a centavo.",
    ejemplos:
      "Cerraduras, pinturas, tornillería, discos, mechas, adhesivos, EPP",
  },
  otros: {
    nombre: "Otros",
    margenMin: 15,
    margenMax: 18,
    margenRecomendado: "15% - 18%",
    razon:
      "No encajan en las otras familias. Se les aplica el mismo margen de inicio que a grifería, electricidad y plomería.",
    ejemplos: "Productos sin señal suficiente de rubro, categoría o nombre",
  },
};

const RUBRO_FIABLE = {
  "TUBERÍA, CODOS Y CONEXIONES": "griferia-electricidad-plomeria",
  ELECTRICIDAD: "griferia-electricidad-plomeria",
  "PLOMERÍA Y SANITARIOS": "griferia-electricidad-plomeria",
  "GRIFERÍA Y LAVANDERÍA": "griferia-electricidad-plomeria",
  ILUMINACIÓN: "griferia-electricidad-plomeria",
  "JARDINERÍA, RIEGO Y MANGUERAS": "griferia-electricidad-plomeria",
  "HERRAMIENTAS MANUALES": "herramientas",
  "HERRAMIENTAS ELÉCTRICAS": "herramientas",
  "MEDICIÓN E INSTRUMENTOS": "herramientas",
  "EQUIPOS Y MAQUINARIA": "herramientas",
  "EQUIPOS DE CARGA Y ELEVACIÓN": "herramientas",
  AUTOMOTRIZ: "herramientas",
  "CERRAJERÍA Y HERRAJES": "cerrajeria-consumibles-pinturas",
  "PINTURAS Y ESMALTES": "cerrajeria-consumibles-pinturas",
  "BROCHAS, RODILLOS Y PINTURA": "cerrajeria-consumibles-pinturas",
  "ADHESIVOS, SELLANTES Y SOLDADURA": "cerrajeria-consumibles-pinturas",
  "TORNILLERÍA, CLAVOS Y GRAPAS": "cerrajeria-consumibles-pinturas",
  "ABRASIVOS Y DISCOS": "cerrajeria-consumibles-pinturas",
  "QUÍMICOS, LIMPIEZA Y LUBRICANTES": "cerrajeria-consumibles-pinturas",
  "IMPERMEABILIZACIÓN Y MEMBRANAS": "cerrajeria-consumibles-pinturas",
  "SEGURIDAD INDUSTRIAL": "cerrajeria-consumibles-pinturas",
  "CARPINTERÍA Y MADERA": "cerrajeria-consumibles-pinturas",
  "RUEDAS Y RODAMIENTOS": "cerrajeria-consumibles-pinturas",
  "SEÑALIZACIÓN Y VIALIDAD": "cerrajeria-consumibles-pinturas",
};

function norm(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function decidir(id, criterio, confianza) {
  return { id, criterio, confianza };
}

function esObraNegra(nombre) {
  if (/\b(cabilla|varilla corrugada|alambron)\b/.test(nombre)) return true;
  if (/\bcemento\b/.test(nombre) && !/contacto|pvc|cpvc|pegamento/.test(nombre)) {
    return true;
  }
  if (/\b(ladrillo|adoquin|adoquines)\b/.test(nombre)) return true;
  if (
    /\bbloques?\b/.test(nombre) &&
    /cemento|concreto|arcilla|vibro/.test(nombre) &&
    !/carbon|bloqueo/.test(nombre)
  ) {
    return true;
  }
  if (
    /tubo estructural|perfil estructural|\bptr\b|tubo cuadrado|tubo rectangular/.test(
      nombre,
    )
  ) {
    return true;
  }
  return false;
}

function esConsumible(nombre) {
  if (/\b(mecha|mechas|broca|brocas)\b/.test(nombre)) return true;
  if (/\b(lija|lijas)\b/.test(nombre)) return true;
  if (/\bdisco\b/.test(nombre) || /\bsierra copa\b/.test(nombre)) return true;
  if (/\bcinta\b/.test(nombre) && !/metrica/.test(nombre)) return true;
  if (
    /\b(tornillo|tornillos|tirraje|tirrajes|tirafondo|clavo|clavos|remache|remaches|tuerca|tuercas|arandela|arandelas|ramplug|grapa|grapas|taco|tacos)\b/.test(
      nombre,
    )
  ) {
    return true;
  }
  if (
    /\b(pintura|esmalte|thinner|barniz|brocha|rodillo|impermeabilizante|sellador)\b/.test(
      nombre,
    )
  ) {
    return true;
  }
  if (
    /\b(cerradura|candado|manilla|bisagra|pasador|picaporte|chapa)\b/.test(nombre)
  ) {
    return true;
  }
  if (
    /\b(pegamento|silicona|silicon|adhesivo|cola blanca)\b/.test(nombre) &&
    !/led|lampara|reflector|panel/.test(nombre)
  ) {
    return true;
  }
  if (/\bcemento\b/.test(nombre) && /contacto|pvc|cpvc/.test(nombre)) return true;
  if (/\b(electrodo|electrodos)\b/.test(nombre)) return true;
  if (/\bsoldadura\b/.test(nombre) && !/\bsoldadora\b/.test(nombre)) return true;
  if (/estano para soldar|estaño para soldar/.test(nombre)) return true;
  if (
    /\b(guante|guantes|casco|mascarilla|mascarillas|careta)\b/.test(nombre) ||
    /linea de vida|\barnes\b/.test(nombre) ||
    /\bbotas?\b/.test(nombre) ||
    (/lente/.test(nombre) && /seguridad|proteccion/.test(nombre))
  ) {
    return true;
  }
  if (/nylon/.test(nombre) && /desmalezadora/.test(nombre)) return true;
  if (/grano\s*\d+|rueda c\/eje|rueda abrasiva|piedra de esmeril/.test(nombre)) {
    return true;
  }
  if (
    /cinta aislante|cinta de enmascarar|cinta para paneles|\bteflon\b|\bteflon\b/.test(
      nombre,
    )
  ) {
    return true;
  }
  if (/\b(resorte|resortes|tope para puerta)\b/.test(nombre)) return true;
  if (/\b(rodamiento|rodamientos)\b/.test(nombre)) return true;
  if (/carburador para|cilindro para|cuchilla .{0,20}desmalezadora/.test(nombre)) {
    return true;
  }
  if (
    /\b(aceite|grasa|lubricante|desengrasante|limpiador|shampoo|cera liquida)\b/.test(
      nombre,
    )
  ) {
    return true;
  }
  if (/angulo de canto/.test(nombre)) return true;
  if (/\bangulo\b/.test(nombre) && /\bacero\b/.test(nombre) && /pza/.test(nombre)) {
    return true;
  }
  if (
    /cortinero|cortina|\bguaya\b|alambre de puas|tela mosquitero|mosquitero/.test(nombre)
  ) {
    return true;
  }
  if (/\bcorredera\b|\btensor\b|perro de cuerda|cordon elastico/.test(nombre)) return true;
  if (/\b(cordel|cuerda|soga|lona|zocalo|paño|pano)\b/.test(nombre)) return true;
  if (/perfil anodizado|cruz plastica|brazo neumatico|tope decorativo|tope de puerta|tope para puerta/.test(nombre)) {
    return true;
  }
  if (/\bangulo\b/.test(nombre) && !/llave|broca/.test(nombre)) return true;
  if (/\boxido\b|piedra de pulir|piedra pulir/.test(nombre)) return true;
  if (/escoba|trampa para|trampa p\/|trampa plastica|mata mosca|organizador|escurridor/.test(nombre)) {
    return true;
  }
  if (/piedra p\s*\/\s*pulir|piedra en kit|tope puerta/.test(nombre)) return true;
  if (/soporte extensible|tubo de closet|soportes varios/.test(nombre)) return true;
  if (
    /malla mosquitero|malla gallinero|malla hexagonal|malla pajarera/.test(nombre)
  ) {
    return true;
  }
  if (/rueda neumatic|rueda giratoria|tripa para rueda/.test(nombre)) return true;
  return false;
}

function esHerramienta(nombre) {
  if (
    /\b(taladro|esmeril|pulidora|rotomartillo|demoledor|atornillador|lijadora|caladora|amoladora|motosierra|hidrolavadora|hidrojet|compresor|soldadora)\b/.test(
      nombre,
    )
  ) {
    return true;
  }
  if (/\bdesmalezadora\b/.test(nombre) && !/nylon|cuchilla|carburador|cilindro|repuesto/.test(nombre)) {
    return true;
  }
  if (
    /\b(destornillador|destornilladores|alicate|alicates|martillo|mazo|cincel|palanca|machete|hacha|palustra|serrucho|segueta|formon)\b/.test(
      nombre,
    )
  ) {
    return true;
  }
  if (/\bpinza\b/.test(nombre) && !/tender|ropa/.test(nombre)) return true;
  if (
    /llave de tubo|llave allen|llave combinada|llave inglesa|llave stillson|llave crescent|llave ajustable|llave mixta/.test(
      nombre,
    )
  ) {
    return true;
  }
  if (/\b(dado|dados|ratchet|rachet)\b/.test(nombre)) return true;
  if (/macho/.test(nombre) && /roscar|npt|tubo/.test(nombre)) return true;
  if (
    /cinta metrica|flexometro|\bnivel\b|calibrador|multimetro|pinza amperimetrica/.test(
      nombre,
    )
  ) {
    return true;
  }
  if (
    /\b(pala|pico|carretilla|escalera|gato hidraulico|dobla tubo|cortadora)\b/.test(
      nombre,
    )
  ) {
    return true;
  }
  if (/\b(fumigador|atomizador)\b/.test(nombre)) return true;
  if (/abrazadera con manija/.test(nombre)) return true;
  if (/\b(tijera|tijeras)\b/.test(nombre) && /lamina|poda|podar|jardin|herrero|avia/.test(nombre)) {
    return true;
  }
  if (/soporte para autos|cama banco para mecanico|banco para mecanico/.test(nombre)) {
    return true;
  }
  if (/corta ceramica|cortaceramica|corta vidrio|cortavidrio|pelacable|pela cable/.test(nombre)) {
    return true;
  }
  if (/huinche|senorita|tilfor|pistola gravedad|pistola de gravedad|arrancador de emergencia/.test(nombre)) {
    return true;
  }
  if (/barra\s+"?t\b|flexion de tubo|dobladora de tubo/.test(nombre)) return true;
  if (/kit de accesorios p\s*\/\s*soplar|accesorios p\s*\/\s*soplar/.test(nombre)) return true;
  if (/\bpistola\b|recortadora|transpaleta|sacabocado|posicionador|limpia vidrio/.test(nombre)) {
    return true;
  }
  return false;
}

function esInstalacion(nombre) {
  if (
    /\b(breaker|breakers|interruptor|tomacorriente|enchufe|itoma|socate|bombillo|balastro|balasto)\b/.test(
      nombre,
    )
  ) {
    return true;
  }
  if (
    /panel led|reflector led|tira de luz|tubo led|\blampara\b|\bfoco\b|extractor de aire|downlight|balastro/.test(
      nombre,
    )
  ) {
    return true;
  }
  if (
    /\b(grifo|griferia|mezcladora|monomando|regadera|ducha|lavamanos|fregadero|inodoro|sanitario|fluxometro)\b/.test(
      nombre,
    )
  ) {
    return true;
  }
  if (/llave de paso|llave de chorro|llave de angulo|llave angular/.test(nombre)) {
    return true;
  }
  if (/\b(valvula|flotador|niple|niples)\b/.test(nombre)) return true;
  if (/tubo pvc|tubo cpvc|tubo pex|tuberia pvc|codo pvc|codo hg/.test(nombre)) {
    return true;
  }
  if (/\b(codo|codos|tee)\b/.test(nombre) && /pvc|cpvc|pex|hg|galvaniz|bronce|cobre|sanitar/.test(nombre)) {
    return true;
  }
  if (
    /bomba de agua|\bcalentador\b|regulador de gas|ducto de escape|\bfogon\b|\bfogones\b|\breverbero\b/.test(
      nombre,
    )
  ) {
    return true;
  }
  if (/\bwc\b|w\.c\.|surtidor p|boya para|desague|herraje p\/\s*w|rabo cochino|\btapon\b/.test(nombre)) {
    return true;
  }
  if (/roseta|anillo e\.?m\.?t|rejilla|yee p\/|yee para/.test(nombre)) return true;
  if (/accesorio/.test(nombre) && /bano|ducha|toalla/.test(nombre)) return true;
  if (/colgador|toallero|\basiento\b/.test(nombre) && /bano|toalla|sanitario|inodoro|taza|luxe|lujo|wc/.test(nombre)) {
    return true;
  }
  if (/starled|\bled\b|luces vintage|panel superficial/.test(nombre)) return true;
  if (/balancin|press control|presostato/.test(nombre)) return true;
  if (/\b(manguera|mangueras|aspersor)\b/.test(nombre)) return true;
  if (/abrazadera/.test(nombre) && /mikalor|sin fin|manguera/.test(nombre)) return true;
  if (/\b(conexion|conexiones)\b/.test(nombre)) return true;
  if (/\bcable\b/.test(nombre) && /thw|thhn|electric|duplex|awg|calibre|conduit|uso rudo/.test(nombre)) {
    return true;
  }
  if (/\b(cajetin|cajetines)\b/.test(nombre)) return true;
  if (
    /jabonera|toallero|gancho para toalla|portarrollo|gancho para bano|accesorio de bano/.test(
      nombre,
    )
  ) {
    return true;
  }
  return false;
}

function desdeCategoria(categoria) {
  if (!categoria) return null;
  if (
    /mecha|broca|lija|abrasiv|tornill|clavo|remache|candado|cerradur|bisagra|pintura|esmalte|pegamento|adhesiv|ramplug|electrodo/.test(
      categoria,
    )
  ) {
    return "cerrajeria-consumibles-pinturas";
  }
  if (/\bdisco/.test(categoria)) return "cerrajeria-consumibles-pinturas";
  if (
    /herram|dado|llave allen|llave combinada|destornill|alicate|macho|palustra|medicion|mecanico/.test(
      categoria,
    )
  ) {
    return "herramientas";
  }
  if (
    /electric|breaker|ilumin|plomer|grifer|bano|conexion|niple|fregadero|lavamanos|enchufe|bombillo|valvula|manguera|ducha|regadera|sanitar/.test(
      categoria,
    )
  ) {
    return "griferia-electricidad-plomeria";
  }
  if (/pintura|rodillo|brocha|cerrajer|herraje|quimic|lubric/.test(categoria)) {
    return "cerrajeria-consumibles-pinturas";
  }
  return null;
}

export function clasificar(producto) {
  const nombre = norm(producto.nombre);
  const categoria = norm(producto.categoria);

  if (esConsumible(nombre)) {
    return decidir("cerrajeria-consumibles-pinturas", "nombre", "alta");
  }
  if (esHerramienta(nombre)) {
    return decidir("herramientas", "nombre", "alta");
  }
  if (esInstalacion(nombre)) {
    return decidir("griferia-electricidad-plomeria", "nombre", "alta");
  }
  if (esObraNegra(nombre)) {
    return decidir("obra-negra-estructural", "nombre", "alta");
  }

  const porCategoria = desdeCategoria(categoria);
  if (porCategoria) return decidir(porCategoria, "categoria", "alta");

  const porRubro = RUBRO_FIABLE[producto.rubro];
  if (porRubro) return decidir(porRubro, "rubro", "media");

  return decidir("otros", "ninguno", "baja");
}

function margenDe(resultado) {
  const definicion = CATEGORIAS[resultado.id];
  return {
    id: resultado.id,
    categoria: definicion.nombre,
    recomendado: definicion.margenRecomendado,
    min: definicion.margenMin,
    max: definicion.margenMax,
    confianza: resultado.confianza,
    criterio: resultado.criterio,
  };
}

function auditar(productos) {
  const conteo = {};
  const criterio = {};
  const porRubro = {};
  const muestras = {};
  const otros = [];

  productos.forEach((producto, index) => {
    const resultado = clasificar(producto);
    conteo[resultado.id] = (conteo[resultado.id] || 0) + 1;
    const ck = `${resultado.id}|${resultado.criterio}`;
    criterio[ck] = (criterio[ck] || 0) + 1;
    const rk = `${producto.rubro || "(vacio)"} -> ${resultado.id}`;
    porRubro[rk] = (porRubro[rk] || 0) + 1;
    if (!muestras[resultado.id]) muestras[resultado.id] = [];
    if ((index * 17 + resultado.id.length) % 97 === 0 && muestras[resultado.id].length < 6) {
      muestras[resultado.id].push(
        `${producto.rubro || "?"} | ${(producto.nombre || "").slice(0, 70)}`,
      );
    }
    if (resultado.id === "otros" && otros.length < 40) {
      otros.push(
        `${producto.rubro || "?"} | ${(producto.categoria || "-").slice(0, 28)} | ${(producto.nombre || "").slice(0, 70)}`,
      );
    }
  });

  console.log("TOTAL", productos.length);
  for (const [id, definicion] of Object.entries(CATEGORIAS)) {
    console.log(`${conteo[id] || 0}\t${definicion.nombre}`);
  }
  console.log("\nCRITERIO");
  for (const [k, v] of Object.entries(criterio).sort((a, b) => b[1] - a[1])) {
    console.log(`${v}\t${k}`);
  }
  console.log("\nMUESTRAS");
  for (const [id, lista] of Object.entries(muestras)) {
    console.log(`-- ${CATEGORIAS[id].nombre}`);
    for (const linea of lista) console.log(`  ${linea}`);
  }
  console.log("\nOTROS");
  for (const linea of otros) console.log(`  ${linea}`);
  console.log("\nRUBRO");
  for (const [k, v] of Object.entries(porRubro).sort((a, b) => b[1] - a[1]).slice(0, 35)) {
    console.log(`${v}\t${k}`);
  }

  const casos = [
    ["BREAKER BHP", "griferia-electricidad-plomeria"],
    ["DADO 12 PUNTAS", "herramientas"],
    ["MECHA 1/2", "cerrajeria-consumibles-pinturas"],
    ["CEMENTO DE CONTACTO", "cerrajeria-consumibles-pinturas"],
    ["CEMENTO PVC", "cerrajeria-consumibles-pinturas"],
    ["LLAVE DE TUBO", "herramientas"],
    ["LLAVE DE PASO", "griferia-electricidad-plomeria"],
    ["PANEL LED", "griferia-electricidad-plomeria"],
    ["TIRA DE LUZ LED CON ADHESIVO", "griferia-electricidad-plomeria"],
    ["CINTA METRICA", "herramientas"],
    ["TORNILLO", "cerrajeria-consumibles-pinturas"],
    ["CERRADURA", "cerrajeria-consumibles-pinturas"],
    ["PINTURA", "cerrajeria-consumibles-pinturas"],
    ["MACHETE", "herramientas"],
    ["NYLON CUADRADO PARA DESMALEZADORA", "cerrajeria-consumibles-pinturas"],
    ["BOTAS DE SEGURIDAD", "cerrajeria-consumibles-pinturas"],
    ["FLOTADOR CON VARILLA", "griferia-electricidad-plomeria"],
    ["ABRAZADERA \"MIKALOR\"", "griferia-electricidad-plomeria"],
    ["ANGULO 1 1/2\" ACERO", "cerrajeria-consumibles-pinturas"],
    ["LLAVE DE ANGULO", "griferia-electricidad-plomeria"],
    ["REGULADOR DE GAS", "griferia-electricidad-plomeria"],
    ["CALENTADOR ELECTRICO", "griferia-electricidad-plomeria"],
    ["CORTA CERAMICA", "herramientas"],
    ["BOTAS T/MILITARES", "cerrajeria-consumibles-pinturas"],
    ["TAPON GALVANIZADO", "griferia-electricidad-plomeria"],
    ["DISCO ULTRA FINO", "cerrajeria-consumibles-pinturas"],
    ["CINTA METRICA", "herramientas"],
  ];

  let fallos = 0;
  for (const [fragmento, esperado] of casos) {
    const producto = productos.find((item) =>
      norm(item.nombre).includes(norm(fragmento)),
    );
    if (!producto) {
      console.log(`FALTA CASO ${fragmento}`);
      fallos += 1;
      continue;
    }
    const resultado = clasificar(producto);
    if (resultado.id !== esperado) {
      fallos += 1;
      console.log(
        `FALLO ${fragmento} -> ${resultado.id} (esperado ${esperado}) | ${producto.nombre}`,
      );
    }
  }
  console.log(fallos === 0 ? "\nCASOS OK" : `\nCASOS CON FALLOS ${fallos}`);
  return fallos;
}

function escribir(catalogo) {
  const conteo = {};
  const confianza = {};
  for (const producto of catalogo.productos) {
    const resultado = clasificar(producto);
    producto.margen = margenDe(resultado);
    conteo[resultado.id] = (conteo[resultado.id] || 0) + 1;
    confianza[resultado.confianza] = (confianza[resultado.confianza] || 0) + 1;
  }

  catalogo.margenes = {
    generado: new Date().toISOString(),
    fuente: "Tabla de margen recomendado (inicio)",
    moneda: catalogo.meta?.moneda || "MXN",
    preciosSinIVA: catalogo.meta?.preciosSinIVA ?? true,
    nota:
      "El margen se aplica sobre el precio de catálogo del proveedor, que está sin IVA. Iluminación quedó en Grifería, Electricidad y Plomería. Mechas, brocas, discos, tornillería, adhesivos, químicos y equipo de protección quedaron en Cerrajería, Consumibles y Pinturas. Obra negra queda definida para cemento, cabilla, bloques y tubos estructurales; este catálogo no trae esos productos. Otros agrupa lo que no entró en esas familias, con margen 15%–18%.",
    categorias: Object.entries(CATEGORIAS).map(([id, definicion]) => ({
      id,
      ...definicion,
      productos: conteo[id] || 0,
    })),
    confianza,
  };

  fs.writeFileSync(SALIDA, JSON.stringify(catalogo));
  console.log(`Escrito ${SALIDA}`);
  console.log(`Productos ${catalogo.productos.length}`);
  for (const [id, total] of Object.entries(conteo)) {
    console.log(`${total}\t${CATEGORIAS[id].nombre}`);
  }
}

const esEntrada =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (esEntrada) {
  const auditarSolo = process.argv.includes("--auditar");
  const catalogo = JSON.parse(fs.readFileSync(ENTRADA, "utf8"));

  if (auditarSolo) {
    const fallos = auditar(catalogo.productos);
    process.exit(fallos === 0 ? 0 : 1);
  }

  escribir(catalogo);
}
