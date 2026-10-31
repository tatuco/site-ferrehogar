const fs = require('fs');
const path = require('path');

const records = JSON.parse(fs.readFileSync(path.join(__dirname, '../database.json'), 'utf8'));

 //console.log(records.productos.filter(p => p.nombre == null || p.nombre == '' || p.nombre == undefined))


const data = records.productos.filter(p => p.precio == null || p.precio == '' || p.precio == undefined).map(p => {
    return `${p.codigo} - ${p.proveedor} - ${p.nombre}`
 })

//console.log(data.join('\n'))