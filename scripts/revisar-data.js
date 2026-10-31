const fs = require('fs');
const path = require('path');

const records = JSON.parse(fs.readFileSync(path.join(__dirname, '../build/catalogo.categorizado.json'), 'utf8'));

// console.log(records.productos.filter(p => p.nombre == null || p.nombre == '' || p.nombre == undefined))


 console.log(records.productos.filter(p => p.margen.id != 'sin-clasificar')[0])