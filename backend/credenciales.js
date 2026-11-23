const { createHash, randomBytes, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');

const derivar = promisify(scrypt);
const formatoHash = /^scrypt\$([a-f0-9]{32})\$([a-f0-9]{128})$/;

function huella(valor) {
  return createHash('sha256').update(valor).digest('hex');
}

async function protegerClave(clave) {
  const sal = randomBytes(16).toString('hex');
  const hash = await derivar(clave, sal, 64);
  return `scrypt$${sal}$${hash.toString('hex')}`;
}

async function verificarClave(clave, almacenada) {
  const partes = formatoHash.exec(almacenada);
  if (!partes) {
    // Las cuentas existentes guardaban literalmente el valor que enviaba el cliente.
    return {
      valida: timingSafeEqual(Buffer.from(huella(clave)), Buffer.from(huella(almacenada))),
      anterior: true
    };
  }
  const [, sal, hash] = partes;
  const calculado = await derivar(clave, sal, 64);
  return { valida: timingSafeEqual(calculado, Buffer.from(hash, 'hex')), anterior: false };
}

module.exports = { huella, protegerClave, verificarClave };
