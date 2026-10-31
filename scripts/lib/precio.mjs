/**
 * Costo y precio de venta compartidos por el inventario, el índice y el cotizador.
 *
 * El costo es precioFinal cuando el producto trae el descuento del catálogo;
 * si no, es precio. Los dos son costo sin IVA.
 *
 * precioVenta = costo × (1 + margenMin / 100), redondeado en centavos.
 */

export function costoDe(producto) {
  const final = Number(producto.precioFinal);
  if (Number.isFinite(final) && producto.precioFinal !== "" && producto.precioFinal != null) {
    return final;
  }
  const lista = Number(producto.precio);
  if (Number.isFinite(lista) && producto.precio !== "" && producto.precio != null) {
    return lista;
  }
  return null;
}

export function precioVentaDe(costo, margenMin) {
  const costoCentavos = Math.round(Number(costo) * 100);
  const ventaCentavos = Math.round((costoCentavos * (100 + Number(margenMin))) / 100);
  return ventaCentavos / 100;
}

export function precioVentaProducto(producto, margenMin) {
  const costo = costoDe(producto);
  if (costo == null || !Number.isFinite(Number(margenMin))) return null;
  return precioVentaDe(costo, margenMin);
}
