const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');
const { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { huella, protegerClave, verificarClave } = require('./credenciales');
const { configurarCorreo, enviarCorreoRecuperacion, enviarCodigoEliminacion } = require('./correo-recuperacion');

const raizProyecto = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(raizProyecto, '.env') });

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer'
  });
  next();
});
app.use(cors());

const limitesPublicos = new Map([
  ['/api/usuarios', { maximo: 60 }],
  ['/api/usuarios/login', { maximo: 120 }],
  ['/api/usuarios/recuperar-contrasena', { maximo: 60 }],
  ['/api/usuarios/restablecer-contrasena', { maximo: 120 }]
]);
app.use((req, res, next) => {
  const limite = req.method === 'POST' && limitesPublicos.get(req.path.toLowerCase().replace(/\/$/, ''));
  if (!limite) return next();
  const ahora = Date.now();
  if (!limite.vence || limite.vence <= ahora) {
    limite.vence = ahora + 60_000;
    limite.total = 0;
  }
  if (limite.total >= limite.maximo) {
    res.set({ 'Retry-After': String(Math.ceil((limite.vence - ahora) / 1000)), 'Cache-Control': 'no-store' });
    return res.status(429).json(responseFormat(false, 'El servicio está recibiendo demasiadas solicitudes. Inténtalo más tarde.'));
  }
  limite.total++;
  next();
});
app.use(express.json());

app.use('/app', (req, res, next) => {
  res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  next();
}, express.static(path.join(raizProyecto, 'frontend', 'dist')));

// Redirección automática de la raíz al Swagger
app.get('/', (req, res) => {
  res.redirect('/api-docs');
});

// Configuración de Swagger UI
// `customJs` inyecta el script que valida los IDs mientras se escriben (sin presionar "Execute")
const directorioSwagger = path.join(__dirname, 'swagger');
app.use('/swagger-assets', express.static(path.join(directorioSwagger, 'assets')));
const swaggerDocument = YAML.load(path.join(directorioSwagger, 'swagger.yaml'));
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument, {
  customJs: '/swagger-assets/validacion-tiempo-real.js',
  customCssUrl: '/swagger-assets/validacion-tiempo-real.css'
}));

// Conexión a MongoDB Atlas
mongoose.set('transactionAsyncLocalStorage', true);
const conexion = mongoose.connect(process.env.MONGO_URI);
conexion
  .then(() => console.log('Base de datos conectada exitosamente a MongoDB Atlas: nevera_inteligente'))
  .catch((err) => console.error('Error al conectar a MongoDB:', err));

// Estructura unificada de respuesta de la API (Single Return)
const responseFormat = (success, message, data = null) => ({
  success,
  message,
  data
});

app.get('/api/salud', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (mongoose.connection.readyState === 1) {
    try {
      await mongoose.connection.db.command({ ping: 1 }, { timeoutMS: 1500 });
      return res.status(200).json(responseFormat(true, 'API y base de datos disponibles'));
    } catch {
      // Un ping fallido también indica que la aplicación no está lista.
    }
  }
  res.status(503).json(responseFormat(false, 'Base de datos no disponible'));
});

// ==========================================
// INTEGRIDAD REFERENCIAL (Llaves foráneas)
// ==========================================
// Las relaciones se derivan automáticamente de la opción `ref` de cada esquema,
// por lo que cualquier modelo nuevo con `ref` queda cubierto sin código adicional.

const MSG_NO_ENCONTRADO = 'El recurso con el ID proporcionado no fue encontrado';
const MSG_EN_USO = 'No se puede eliminar el registro porque está siendo utilizado en otros registros del sistema';

// Colecciones de auditoría: conservan snapshots aunque el registro original se elimine,
// por eso no bloquean la eliminación.
const MODELOS_SIN_RESTRICCION = new Set(['HistorialInventario']);

class ApiError extends Error {
  constructor(status, message, data = null) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

// Verifica que el valor tenga el formato del _id del modelo (evita CastError e inyección de operadores)
const idCompatible = (Model, id) => {
  if (typeof id !== 'string' && typeof id !== 'number') return false;
  const valor = String(id).trim();
  if (valor === '') return false;
  if (Model.schema.path('_id').instance === 'ObjectId') return /^[a-f\d]{24}$/i.test(valor);
  return true;
};

// Campos de un modelo que apuntan a otra colección: [{ campo, modeloRef }]
const camposReferencia = (Model) => {
  const campos = [];
  Model.schema.eachPath((ruta, tipo) => {
    if (ruta !== '_id' && tipo.options && tipo.options.ref) {
      campos.push({ campo: ruta, modeloRef: tipo.options.ref });
    }
  });
  return campos;
};

// Busca por _id y devuelve HTTP 200 con success:false cuando falta el recurso
const obtenerOFallar = async (Model, id, filtro = {}) => {
  const doc = idCompatible(Model, id) ? await Model.findOne({ ...filtro, _id: id }).lean() : null;
  if (!doc) {
    throw new ApiError(200, MSG_NO_ENCONTRADO, { recurso: Model.modelName, id });
  }
  return doc;
};

// Valida en tiempo real que cada ID foráneo recibido (body o query) exista en su colección
const validarReferencias = async (Model, datos = {}) => {
  for (const { campo, modeloRef } of camposReferencia(Model)) {
    const valor = datos[campo];
    if (valor === undefined || valor === null || valor === '') continue; // `required` lo valida Mongoose
    const ModeloRef = mongoose.model(modeloRef);
    const existe = idCompatible(ModeloRef, valor) && await ModeloRef.exists({ _id: valor });
    if (!existe) {
      throw new ApiError(200, MSG_NO_ENCONTRADO, { campo, valor, recurso: modeloRef });
    }
  }
};

// Busca en todas las colecciones los registros que referencian al _id; si hay alguno responde 409
const verificarSinReferencias = async (Model, id) => {
  const dependencias = [];
  for (const nombre of mongoose.modelNames()) {
    if (MODELOS_SIN_RESTRICCION.has(nombre)) continue;
    const Dependiente = mongoose.model(nombre);
    for (const { campo, modeloRef } of camposReferencia(Dependiente)) {
      if (modeloRef !== Model.modelName) continue;
      const registros = await Dependiente.countDocuments({ [campo]: id });
      if (registros > 0) {
        dependencias.push({ coleccion: Dependiente.collection.collectionName, campo, registros });
      }
    }
  }
  if (dependencias.length > 0) {
    throw new ApiError(409, MSG_EN_USO, { recurso: Model.modelName, id, dependencias });
  }
};

// Plugin global: protege toda eliminación por _id a nivel de modelo (no solo desde las rutas).
// Debe registrarse antes de compilar los modelos.
mongoose.plugin((schema) => {
  schema.pre(['findOneAndDelete', 'deleteOne'], { document: false, query: true }, async function () {
    const id = this.getFilter()._id;
    if (id !== undefined && id !== null && typeof id !== 'object') {
      await verificarSinReferencias(this.model, id);
    }
  });
  schema.pre('deleteMany', async function () {
    const ids = await this.model.find(this.getFilter()).distinct('_id');
    for (const id of ids) await verificarSinReferencias(this.model, id);
  });
});

// Elimina por _id: HTTP 200 con success:false si falta y 409 si hay dependencias
const eliminarPorId = async (Model, id, filtro = {}) => {
  await obtenerOFallar(Model, id, filtro);
  return Model.findOneAndDelete({ ...filtro, _id: id });
};

// ==========================================
// MODELOS DE MONGOOSE
// ==========================================

const Usuario = mongoose.model('Usuario', new mongoose.Schema({
  _id: { type: String, required: true },
  nombre: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  password_hash: { type: String, required: true, select: false },
  recuperacion_hash: { type: String, select: false, unique: true, sparse: true },
  recuperacion_codigo_hash: { type: String, select: false },
  recuperacion_codigo_intentos: { type: Number, select: false },
  recuperacion_vence: { type: Date, select: false },
  recuperacion_solicitada: { type: Date, select: false },
  recuperacion_pendiente: { type: String, select: false },
  eliminacion_codigo: { type: mongoose.Schema.Types.Mixed, select: false },
  eliminacion_pendiente: { type: mongoose.Schema.Types.Mixed, select: false },
  eliminacion_intentos: { type: Number, select: false },
  eliminacion_intentos_vence: { type: Date, select: false },
  revision_notificaciones: { type: Number, select: false },
  nombre_editable_desde: { type: Date, select: false }
}, { collection: 'usuarios', _id: false, versionKey: false }));

const IdUsuarioRetirado = mongoose.model('IdUsuarioRetirado', new mongoose.Schema({
  _id: { type: String, required: true }
}, { collection: 'usuarios_ids_retirados', _id: false, versionKey: false }));

const Sesion = mongoose.model('Sesion', new mongoose.Schema({
  _id: String,
  usuario: { type: String, required: true },
  credencial: { type: String, required: true },
  web: Boolean,
  actividad_hasta: { type: Date, required: true, expires: 0 },
  vence: { type: Date, required: true, expires: 0 }
}, { collection: 'sesiones', versionKey: false }));
Sesion.schema.index({ usuario: 1, credencial: 1, vence: -1, _id: 1 });

const IntentoIngreso = mongoose.model('IntentoIngreso', new mongoose.Schema({
  _id: String,
  intentos: Number,
  fallidos: Number,
  ventana: String,
  vence: { type: Date, expires: 0 },
  bloqueado_hasta: Date,
  ultimo_intento_vence: Date,
  requiere_recuperacion: Boolean
}, { collection: 'intentos_ingreso', versionKey: false }));

const BloqueoMutaciones = mongoose.model('BloqueoMutaciones', new mongoose.Schema({
  _id: String,
  revision: Number
}, { collection: 'bloqueos_mutaciones', versionKey: false }));

const NEVERA_PREDETERMINADA = 'NEVERA-01';
const ESTADOS_INVENTARIO = ['EN_NEVERA', 'CONSUMIDO', 'DESPERDICIADO'];

const Categoria = mongoose.model('Categoria', new mongoose.Schema({
  _id: { type: String, required: true }
}, { collection: 'categorias', _id: false, versionKey: false }));

const UnidadMedida = mongoose.model('UnidadMedida', new mongoose.Schema({
  _id: { type: String, required: true },
  abreviatura: { type: String, required: true }
}, { collection: 'unidades_medida', _id: false, versionKey: false }));

const Marca = mongoose.model('Marca', new mongoose.Schema({
  _id: { type: String, required: true }
}, { collection: 'marcas', _id: false, versionKey: false }));

const Producto = mongoose.model('Producto', new mongoose.Schema({
  _id: { type: String, required: true },
  marca_nombre: { type: String, ref: 'Marca', required: true },
  categoria_nombre: { type: String, ref: 'Categoria', required: true },
  nombre: { type: String, required: true }
}, { collection: 'productos', _id: false, versionKey: false }));

const Inventario = mongoose.model('Inventario', new mongoose.Schema({
  user_nombre: { type: String, ref: 'Usuario', required: true },
  nevera_id: { type: String, required: true, default: NEVERA_PREDETERMINADA },
  producto_id: { type: String, ref: 'Producto', required: true },
  ingrediente_nombre: { type: String, ref: 'Ingrediente', default: null },
  unidad_medida_nombre: { type: String, ref: 'UnidadMedida', required: true },
  cantidad: { type: Number, required: true, min: 0, validate: Number.isFinite },
  fecha_vencimiento: { type: Date, default: null },
  estado: { type: String, enum: ESTADOS_INVENTARIO, default: 'EN_NEVERA' },
  version: { type: Number, default: 0 },
  alerta_vencimiento_generada: { type: Date, select: false }
}, { collection: 'inventario', versionKey: false }));
Inventario.schema.index({ user_nombre: 1, nevera_id: 1, producto_id: 1, estado: 1, unidad_medida_nombre: 1, fecha_vencimiento: 1 });
Inventario.schema.index({ estado: 1, fecha_vencimiento: 1 });

const HistorialInventario = mongoose.model('HistorialInventario', new mongoose.Schema({
  inventario_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Inventario' },
  snapshot_datos: { type: Object, default: null },
  accion: { type: String, enum: ['CREADO', 'ACTUALIZADO', 'ELIMINADO'], required: true },
  detalles: { type: String, required: true },
  fecha: { type: Date, default: Date.now }
}, { collection: 'historial_inventario', versionKey: false }));
HistorialInventario.schema.index({ 'snapshot_datos.user_nombre': 1, fecha: -1 });

const PatronPredictivo = mongoose.model('PatronPredictivo', new mongoose.Schema({
  _id: { type: String, required: true },
  user_nombre: { type: String, ref: 'Usuario', required: true },
  frecuencia_compra_dias: { type: Number, min: 1, validate: Number.isInteger },
  probabilidad_desperdicio: { type: Number, min: 0, max: 1 }
}, { collection: 'patrones_predictivos', _id: false, versionKey: false }));

const Ingrediente = mongoose.model('Ingrediente', new mongoose.Schema({
  _id: { type: String, required: true }
}, { collection: 'ingredientes', _id: false, versionKey: false }));

const mealPrepSchema = new mongoose.Schema({
  patron_predictivo_id: { type: String, ref: 'PatronPredictivo', required: true, unique: true },
  ingrediente_nombre: { type: String, ref: 'Ingrediente', required: true },
  nombre_receta: { type: String, required: true }
}, { collection: 'meal_preps', versionKey: false });

const MealPrep = mongoose.models.MealPrep || mongoose.model('MealPrep', mealPrepSchema);

const TIPOS_NOTIFICACION = ['VENCIMIENTO', 'STOCK_BAJO', 'SUGERENCIA'];
const Notificacion = mongoose.model('Notificacion', new mongoose.Schema({
  user_nombre: { type: String, ref: 'Usuario', required: true },
  mensaje: { type: String, required: true },
  tipo: { type: String, enum: TIPOS_NOTIFICACION, default: 'SUGERENCIA' },
  nevera_id: String,
  inventario_id: mongoose.Schema.Types.ObjectId,
  fecha_vencimiento: Date,
  desactualizada: { type: Boolean, default: false },
  leida: { type: Boolean, default: false },
  fecha: { type: Date, default: Date.now }
}, { collection: 'notificaciones', versionKey: false }));
Notificacion.schema.index({ user_nombre: 1, fecha: -1, _id: -1 });
Notificacion.schema.index({ user_nombre: 1, leida: 1, desactualizada: 1 });
Notificacion.schema.index({ user_nombre: 1, inventario_id: 1 });

const DURACION_SESION_MS = 24 * 60 * 60 * 1000;
const DURACION_SESION_WEB_MS = 30 * DURACION_SESION_MS;
const INACTIVIDAD_SESION_MS = 7 * 60 * 1000;
const LIMITE_INTENTOS_INGRESO = 5;
const VENTANA_INGRESO_MS = 5 * 60 * 1000;
const BLOQUEO_INGRESO_MS = 5 * 60 * 1000;
const RESERVA_ULTIMO_INTENTO_MS = 30 * 1000;
const MENSAJE_SESION_ACTIVA = 'Esta cuenta ya tiene una sesión activa. Cierra esa sesión para iniciar otra.';
const CLAVE_SEGURA = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\W_]).{12,1024}$/;
const NOMBRE_COOKIE = 'nevera_session';
const ADMINISTRADORES_CATALOGO = new Set(
  (process.env.CATALOG_ADMIN_IDS ?? '').split(',').map(id => id.trim()).filter(Boolean)
);

function opcionesCookieSesion(req) {
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(req.hostname);
  return { httpOnly: true, secure: !local, sameSite: 'strict', path: '/api' };
}

function escribirCookieSesion(req, res, token, vence) {
  res.cookie(NOMBRE_COOKIE, token, { ...opcionesCookieSesion(req), expires: vence });
}

function exigirOrigenWeb(req) {
  const protocolo = opcionesCookieSesion(req).secure ? 'https' : 'http';
  const origen = `${protocolo}://${req.get('host')}`;
  if (!URL.canParse(origen) || req.get('origin') !== new URL(origen).origin) {
    throw new ApiError(403, 'Abre la aplicación desde su dirección habitual e inténtalo de nuevo.');
  }
}

function tokenCookie(req) {
  const cookies = req.get('cookie') ?? '';
  for (const cookie of cookies.split(';')) {
    const coincidencia = /^nevera_session=([a-f0-9]{64})$/.exec(cookie.trim());
    if (coincidencia) return coincidencia[1];
  }
  return null;
}

let migracionSesiones;
function prepararInactividad() {
  if (!migracionSesiones) {
    const ahora = new Date();
    migracionSesiones = Sesion.updateMany(
      { actividad_hasta: { $exists: false }, vence: { $gt: ahora } },
      { $set: { actividad_hasta: new Date(ahora.getTime() + INACTIVIDAD_SESION_MS) } }
    ).exec().catch(error => {
      migracionSesiones = undefined;
      throw error;
    });
  }
  return migracionSesiones;
}

function filtroSesionVigente(ahora) {
  return { vence: { $gt: ahora }, actividad_hasta: { $gt: ahora } };
}

function buscarSesionActiva(usuario, credencial, ahora) {
  // Las cuentas que ya tenían varias sesiones conservan la que vence más tarde.
  return Sesion.findOne({ usuario, credencial, ...filtroSesionVigente(ahora) }).sort({ vence: -1, _id: 1 }).lean();
}

function extenderActividad(sesion, ahora, transcurridoMs = 0) {
  const fechas = { actividad_hasta: new Date(ahora.getTime() + INACTIVIDAD_SESION_MS - transcurridoMs) };
  if (sesion.web === true && sesion.vence - ahora <= DURACION_SESION_WEB_MS - DURACION_SESION_MS) {
    fechas.vence = new Date(ahora.getTime() + DURACION_SESION_WEB_MS);
  }
  return Sesion.findOneAndUpdate(
    { _id: sesion._id, ...filtroSesionVigente(ahora) },
    { $max: fechas },
    { returnDocument: 'after' }
  ).lean();
}

function tiempoRestanteSesion(sesion) {
  return Math.max(0, Math.min(sesion.vence.getTime(), sesion.actividad_hasta.getTime()) - Date.now());
}

function rechazarSesion(req, res) {
  if (req.sesionWeb) res.clearCookie(NOMBRE_COOKIE, opcionesCookieSesion(req));
  res.set('WWW-Authenticate', 'Bearer');
  throw new ApiError(401, 'Inicia sesión y proporciona un token válido');
}

async function autenticar(req, res, next) {
  res.set('Cache-Control', 'no-store');
  const autorizacion = req.get('authorization');
  const token = autorizacion === undefined ? tokenCookie(req) : /^Bearer ([a-f0-9]{64})$/i.exec(autorizacion)?.[1];
  req.sesionWeb = autorizacion === undefined && !!token;
  if (!token) rechazarSesion(req, res);
  if (req.sesionWeb && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) exigirOrigenWeb(req);
  await prepararInactividad();
  const ahora = new Date();
  const sesion = await Sesion.findOne({ _id: huella(token), ...filtroSesionVigente(ahora) }).lean();
  const [usuario, activa] = typeof sesion?.credencial === 'string' ? await Promise.all([
    Usuario.findById(sesion.usuario).select('+password_hash +revision_notificaciones +nombre_editable_desde').lean(),
    buscarSesionActiva(sesion.usuario, sesion.credencial, ahora)
  ]) : [];
  const credencialValida = typeof usuario?.password_hash === 'string' && huella(usuario.password_hash) === sesion.credencial;
  if (!credencialValida || activa?._id !== sesion._id) rechazarSesion(req, res);

  req.usuarioId = usuario._id;
  req.usuario = usuario;
  req.sesion = activa;
  const operacionSesion = req.method === 'POST' && /^\/usuarios\/(?:actividad|logout)\/?$/i.test(req.path);
  if (!req.sesionWeb && activa.web !== true && !operacionSesion) {
    req.sesion = await extenderActividad(activa, new Date());
    if (!req.sesion) rechazarSesion(req, res);
  }
  next();
}

function exigirPropietario(usuarioId, solicitado) {
  if (solicitado !== undefined && solicitado !== usuarioId) {
    throw new ApiError(403, 'El usuario solicitado no corresponde a la sesión');
  }
}

async function filtroPropietario(Model, usuarioId) {
  switch (Model) {
    case Usuario: return { _id: usuarioId };
    case Inventario:
    case PatronPredictivo:
    case Notificacion: return { user_nombre: usuarioId };
    case HistorialInventario: return { 'snapshot_datos.user_nombre': usuarioId };
    case MealPrep:
      return { patron_predictivo_id: { $in: await PatronPredictivo.distinct('_id', { user_nombre: usuarioId }) } };
    default: return {};
  }
}

let bloqueoListo;
async function enTransaccion(operacion) {
  if (!bloqueoListo) {
    bloqueoListo = BloqueoMutaciones.updateOne(
      { _id: 'referencias' }, { $setOnInsert: { revision: 0 } }, { upsert: true }
    ).catch(error => {
      if (error.code === 11000) return;
      bloqueoListo = undefined;
      throw error;
    });
  }
  await bloqueoListo;
  return mongoose.connection.transaction(async () => {
    // Serializa las operaciones de integridad entre instancias de la API.
    await BloqueoMutaciones.updateOne({ _id: 'referencias' }, { $inc: { revision: 1 } });
    return operacion();
  });
}

function mutacion(metodo, ruta, handler) {
  app[metodo](ruta, async (req, res) => {
    const respuesta = await enTransaccion(() => handler(req));
    res.status(200).json(respuesta);
  });
}

function cuerpoConCampos(cuerpo, campos) {
  if (!cuerpo || typeof cuerpo !== 'object' || Array.isArray(cuerpo)) {
    throw new ApiError(400, 'Envía los campos requeridos en un objeto JSON.');
  }
  const faltantes = campos.filter(campo => cuerpo[campo] == null ||
    (typeof cuerpo[campo] === 'string' && !cuerpo[campo].trim()));
  if (faltantes.length) throw new ApiError(400, `Completa los campos ${faltantes.join(', ')}.`);
  return cuerpo;
}

function llaveIngreso(usuario) {
  return huella(`${usuario._id}:${usuario.password_hash}`);
}

function exigirRecuperacionIngreso() {
  throw new ApiError(423, 'La cuenta está bloqueada. Usa «¿Olvidaste tu contraseña?» para recuperarla.');
}

function rechazarIngreso(res, bloqueadoHasta) {
  const segundos = bloqueadoHasta ? Math.max(1, Math.ceil((bloqueadoHasta - Date.now()) / 1000)) : 1;
  const motivo = bloqueadoHasta ? 'Demasiados intentos fallidos.' : 'Hay intentos de inicio de sesión en curso.';
  const unidad = segundos === 1 ? 'segundo' : 'segundos';
  res.set('Retry-After', String(segundos));
  throw new ApiError(429, `${motivo} Inténtalo nuevamente en ${segundos} ${unidad}.`,
    bloqueadoHasta ? { ultimo_intento: true } : null);
}

async function reservarIntentoIngreso(llave, res) {
  const ahora = new Date();
  const ventana = randomUUID();
  const intentos = { $ifNull: ['$intentos', 0] };
  const fallidos = { $ifNull: ['$fallidos', intentos] };
  const ingresoNormal = { $eq: [{ $ifNull: ['$bloqueado_hasta', null] }, null] };
  const nuevaVentana = { $and: [ingresoNormal, { $lte: [{ $ifNull: ['$vence', new Date(0)] }, ahora] }] };
  const bloqueoAnterior = { $and: [ingresoNormal, { $gt: ['$vence', ahora] }, { $gte: [fallidos, LIMITE_INTENTOS_INGRESO] }] };
  const siguienteIntento = { $min: [{ $add: [intentos, 1] }, LIMITE_INTENTOS_INGRESO + 1] };
  const cambios = [
    // Conserva las esperas que estaban vigentes antes de incorporar el último intento.
    { $set: {
      bloqueado_hasta: { $cond: [bloqueoAnterior, '$vence', '$bloqueado_hasta'] },
      vence: { $cond: [bloqueoAnterior, '$$REMOVE', '$vence'] }
    } },
    { $set: {
      ventana: { $cond: [nuevaVentana, ventana, { $ifNull: ['$ventana', ventana] }] },
      vence: { $cond: [nuevaVentana, new Date(ahora.getTime() + VENTANA_INGRESO_MS), '$vence'] },
      intentos: { $cond: [ingresoNormal, { $cond: [nuevaVentana, 1, siguienteIntento] }, '$intentos'] },
      fallidos: { $cond: [nuevaVentana, 0, fallidos] }
    } }
  ];
  const guardar = () => IntentoIngreso.findOneAndUpdate({ _id: llave }, cambios, {
    upsert: true, returnDocument: 'after', updatePipeline: true
  }).lean();
  const intento = await guardar().catch(error => {
    if (error.code === 11000) return guardar();
    throw error;
  });
  if (intento.requiere_recuperacion) exigirRecuperacionIngreso();
  if (intento.bloqueado_hasta) {
    if (intento.bloqueado_hasta > ahora) rechazarIngreso(res, intento.bloqueado_hasta);
    const ultimo = await IntentoIngreso.findOneAndUpdate({
      _id: llave,
      ventana: intento.ventana,
      requiere_recuperacion: { $ne: true },
      $or: [{ ultimo_intento_vence: { $exists: false } }, { ultimo_intento_vence: { $lte: ahora } }]
    }, { $set: { ventana, ultimo_intento_vence: new Date(ahora.getTime() + RESERVA_ULTIMO_INTENTO_MS) } }, {
      returnDocument: 'after'
    }).lean();
    if (!ultimo) rechazarIngreso(res);
    return ultimo;
  }
  if (intento.intentos > LIMITE_INTENTOS_INGRESO) rechazarIngreso(res);
  return intento;
}

async function registrarFalloIngreso(res, registro, ultimo) {
  if (ultimo) {
    const cambio = await IntentoIngreso.updateOne(registro, {
      $set: { requiere_recuperacion: true }, $unset: { ultimo_intento_vence: 1 }
    });
    if (cambio.matchedCount) exigirRecuperacionIngreso();
  } else {
    const limiteAlcanzado = { $gte: ['$fallidos', LIMITE_INTENTOS_INGRESO] };
    const intento = await IntentoIngreso.findOneAndUpdate(registro, [
      { $set: { fallidos: { $add: ['$fallidos', 1] } } },
      { $set: {
        bloqueado_hasta: { $cond: [limiteAlcanzado, new Date(Date.now() + BLOQUEO_INGRESO_MS), '$bloqueado_hasta'] },
        vence: { $cond: [limiteAlcanzado, '$$REMOVE', '$vence'] }
      } }
    ], { returnDocument: 'after', updatePipeline: true }).lean();
    if (intento?.bloqueado_hasta) rechazarIngreso(res, intento.bloqueado_hasta);
  }
  throw new ApiError(401, 'Credenciales inválidas');
}

// ==========================================
// VALIDACIÓN DE IDs EN TIEMPO REAL (usada por Swagger UI)
// ==========================================
// Nombre legible de cada modelo y su género gramatical para el mensaje "encontrado/a"
const ETIQUETAS = {
  Usuario: ['Usuario', 'o'],
  Categoria: ['Categoría', 'a'],
  UnidadMedida: ['Unidad de medida', 'a'],
  Marca: ['Marca', 'a'],
  Producto: ['Producto', 'o'],
  Inventario: ['Ítem de inventario', 'o'],
  HistorialInventario: ['Registro de historial', 'o'],
  PatronPredictivo: ['Patrón predictivo', 'o'],
  Ingrediente: ['Ingrediente', 'o'],
  MealPrep: ['Plan de comidas', 'o'],
  Notificacion: ['Notificación', 'a']
};

// Mapa derivado de los esquemas: colección → modelo y campo foráneo → colección
const mapaValidacion = () => {
  const colecciones = {};
  const campos = {};
  for (const nombre of Object.keys(ETIQUETAS)) {
    const Model = mongoose.model(nombre);
    colecciones[Model.collection.collectionName] = nombre;
  }
  for (const nombre of Object.keys(ETIQUETAS)) {
    for (const { campo, modeloRef } of camposReferencia(mongoose.model(nombre))) {
      campos[campo] = mongoose.model(modeloRef).collection.collectionName;
    }
  }
  return { colecciones, campos };
};

app.get('/api/validaciones/mapa', (req, res) => {
  res.status(200).json(responseFormat(true, 'Mapa de validación de IDs', mapaValidacion()));
});

// Comprueba si un ID existe sin ejecutar la operación real: GET /api/validaciones/usuarios/2
app.get('/api/validaciones/:coleccion/:id', async (req, res, next) => {
  try {
    const { coleccion, id } = req.params;
    const { colecciones } = mapaValidacion();
    if (!Object.hasOwn(colecciones, coleccion)) {
      throw new ApiError(400, `La colección '${coleccion}' no admite validación`);
    }
    const nombreModelo = colecciones[coleccion];
    const Model = mongoose.model(nombreModelo);
    const privado = [Usuario, Inventario, HistorialInventario, PatronPredictivo, MealPrep, Notificacion].includes(Model);
    let filtro = {};
    if (privado) {
      await autenticar(req, res, () => {});
      filtro = await filtroPropietario(Model, req.usuarioId);
    }
    const existe = idCompatible(Model, id) && (filtro._id === undefined || filtro._id === id)
      && !!(await Model.exists({ ...filtro, _id: id }));
    const [etiqueta, genero] = ETIQUETAS[nombreModelo] || [nombreModelo, 'o'];
    const mensaje = existe
      ? `ID válido - ${etiqueta} encontrad${genero}`
      : 'Error: El ID no existe en la base de datos';
    res.status(200).json(responseFormat(existe, mensaje, { existe, coleccion, recurso: nombreModelo, id }));
  } catch (error) {
    next(error);
  }
});

// ==========================================
// RUTAS DE LA API RESTful
// ==========================================

app.post('/api/usuarios/login', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { id, nombre, password, password_hash, sesion_web } = req.body ?? {};
  if (sesion_web === true) exigirOrigenWeb(req);
  const clave = password ?? password_hash;
  const filtro = idCompatible(Usuario, id) ? { _id: id }
    : typeof nombre === 'string' && nombre.trim() ? { nombre }
    : null;
  const usuario = filtro && typeof clave === 'string' && clave.length <= 1024
    ? await Usuario.findOne(filtro).select('+password_hash +nombre_editable_desde')
    : null;
  if (typeof usuario?.password_hash !== 'string') throw new ApiError(401, 'Credenciales inválidas');
  const llaveIntento = llaveIngreso(usuario);
  const intento = await reservarIntentoIngreso(llaveIntento, res);
  const registroIntento = { _id: llaveIntento, ventana: intento.ventana };
  const resultado = await verificarClave(clave, usuario.password_hash);
  if (!resultado.valida) return registrarFalloIngreso(res, registroIntento, Boolean(intento.bloqueado_hasta));
  const reinicio = await IntentoIngreso.deleteOne(registroIntento);
  if (intento.bloqueado_hasta && !reinicio.deletedCount) throw new ApiError(401, 'Vuelve a iniciar sesión');

  if (resultado.anterior) {
    const hash = await protegerClave(clave);
    const migracion = await Usuario.updateOne(
      { _id: usuario._id, password_hash: usuario.password_hash },
      { $set: { password_hash: hash } }
    );
    if (!migracion.matchedCount) throw new ApiError(401, 'Vuelve a iniciar sesión');
    usuario.password_hash = hash;
  }

  const web = sesion_web === true;
  const tokenActual = web ? tokenCookie(req) : null;
  const credencial = huella(usuario.password_hash);
  await prepararInactividad();
  const { token, sesion } = await enTransaccion(async () => {
    const ahora = new Date();
    const usuarioVigente = await Usuario.exists({ _id: usuario._id, password_hash: usuario.password_hash });
    if (!usuarioVigente) throw new ApiError(401, 'Vuelve a iniciar sesión');
    const activa = await buscarSesionActiva(usuario._id, credencial, ahora);
    if (activa) {
      if (activa.web === true && tokenActual && huella(tokenActual) === activa._id) {
        return { token: tokenActual, sesion: await extenderActividad(activa, ahora) };
      }
      throw new ApiError(409, MENSAJE_SESION_ACTIVA);
    }
    // Una renovación que llegue tarde no debe reactivar una sesión anterior.
    await Sesion.deleteMany({ usuario: usuario._id });
    const nuevoToken = randomBytes(32).toString('hex');
    const duracion = web ? DURACION_SESION_WEB_MS : DURACION_SESION_MS;
    const nueva = await Sesion.create({
      _id: huella(nuevoToken), usuario: usuario._id, credencial, web,
      vence: new Date(ahora.getTime() + duracion),
      actividad_hasta: new Date(ahora.getTime() + INACTIVIDAD_SESION_MS)
    });
    return { token: nuevoToken, sesion: nueva };
  });
  if (!sesion) throw new ApiError(401, 'Vuelve a iniciar sesión');
  const datos = { vence: sesion.vence, inactividad_restante_ms: tiempoRestanteSesion(sesion) };
  if (web) {
    escribirCookieSesion(req, res, token, sesion.vence);
    return res.status(200).json(responseFormat(true, 'Sesión iniciada', { perfil: perfilWeb(usuario), ...datos }));
  }
  res.status(200).json(responseFormat(true, 'Sesión iniciada', { token, ...datos }));
});

const RECUPERACION_DURACION_MS = 30 * 60 * 1000;
const RECUPERACION_ESPERA_MS = 2 * 60 * 1000;
const LIMITE_INTENTOS_CODIGO = 5;
const CAMPOS_RECUPERACION = {
  recuperacion_hash: 1, recuperacion_vence: 1, recuperacion_codigo_hash: 1,
  recuperacion_codigo_intentos: 1, recuperacion_pendiente: 1, eliminacion_codigo: 1, eliminacion_pendiente: 1
};
const correoValido = email => typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

function huellaCodigoRecuperacion(configuracion, solicitud, codigo) {
  const secreto = configuracion.oauth?.refresh_token ?? configuracion.clave;
  return createHmac('sha256', secreto).update(`nevera-codigo-recuperacion:${solicitud}:${codigo}`).digest();
}

async function enviarRecuperacion(email, configuracion) {
  const token = randomBytes(32).toString('hex');
  const hash = huella(token);
  const codigo = String(randomInt(1_000_000)).padStart(6, '0');
  const ahora = Date.now();
  const usuario = await Usuario.findOneAndUpdate({
    email,
    $or: [
      { recuperacion_solicitada: { $exists: false } },
      { recuperacion_solicitada: { $lte: new Date(ahora - RECUPERACION_ESPERA_MS) } }
    ]
  }, { $set: {
    recuperacion_pendiente: hash,
    recuperacion_solicitada: new Date(ahora)
  } }).select('email').lean();
  if (!usuario) return;

  const reserva = { _id: usuario._id, email: usuario.email, recuperacion_pendiente: hash };
  const retirarReserva = { recuperacion_pendiente: 1 };
  configuracion.enlace.hash = new URLSearchParams({ restablecer: token }).toString();
  try {
    await enviarCorreoRecuperacion(configuracion, usuario.email, configuracion.enlace.href, codigo);
  } catch (error) {
    await Usuario.updateOne(reserva, { $unset: retirarReserva });
    throw error;
  }

  // Mantiene el correo anterior vigente hasta la aceptación del nuevo.
  await Usuario.updateOne(reserva, {
    $set: {
      recuperacion_hash: hash,
      recuperacion_codigo_hash: huellaCodigoRecuperacion(configuracion, hash, codigo).toString('hex'),
      recuperacion_codigo_intentos: 0,
      recuperacion_vence: new Date(Date.now() + RECUPERACION_DURACION_MS)
    },
    $unset: retirarReserva
  });
}

app.post('/api/usuarios/recuperar-contrasena', (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  if (!correoValido(email)) {
    throw new ApiError(400, 'Ingresa un correo electrónico válido.');
  }
  const configuracion = configurarCorreo();
  if (!configuracion) throw new ApiError(503, 'La recuperación por correo todavía no está disponible.');
  const solicitud = randomUUID();
  void enviarRecuperacion(email, configuracion).catch(error => {
    const categoria = /^GMAIL_(?:TOKEN|ENVIO)_[1-5][0-9]{2}$/.test(error.code)
      ? error.code : 'correo_recuperacion';
    registrarErrorApi(solicitud, categoria, 500);
  });
  res.set({ 'Cache-Control': 'no-store', 'X-Request-Id': solicitud });
  res.status(202).json(responseFormat(true, 'Si el correo está registrado, recibirás un enlace y un código de recuperación.'));
});

app.post('/api/usuarios/restablecer-contrasena', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { token, codigo, password } = req.body ?? {};
  const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  const porEnlace = token !== undefined;
  const mensaje = porEnlace ? 'El enlace venció o ya fue usado. Solicita uno nuevo.'
    : 'El código es incorrecto, venció o agotó sus intentos. Usa el enlace del correo o solicita uno nuevo.';
  if (porEnlace && codigo !== undefined) throw new ApiError(400, 'Usa el enlace o el código de recuperación.');
  if (porEnlace && (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token))) throw new ApiError(400, mensaje);
  if (!porEnlace && (!correoValido(email) || typeof codigo !== 'string' || !/^[0-9]{6}$/.test(codigo))) {
    throw new ApiError(400, 'Ingresa el correo de tu cuenta y el código de 6 dígitos.');
  }
  if (typeof password !== 'string' || !CLAVE_SEGURA.test(password)) {
    throw new ApiError(400, 'Usa entre 12 y 1024 caracteres, con mayúsculas, minúsculas, números y símbolos.');
  }

  const vigente = { recuperacion_vence: { $gt: new Date() } };
  const seleccion = '+password_hash +recuperacion_hash +recuperacion_codigo_hash';
  const configuracion = porEnlace ? null : configurarCorreo();
  if (!porEnlace && !configuracion) throw new ApiError(503, 'La recuperación por código no está disponible. Usa el enlace del correo.');
  const usuario = porEnlace
    ? await Usuario.findOne({ ...vigente, recuperacion_hash: huella(token) }).select(seleccion).lean()
    : await Usuario.findOneAndUpdate({
      ...vigente, email, recuperacion_codigo_hash: { $type: 'string' },
      recuperacion_codigo_intentos: { $lt: LIMITE_INTENTOS_CODIGO }
    }, { $inc: { recuperacion_codigo_intentos: 1 } }).select(seleccion).lean();
  if (!usuario) throw new ApiError(400, mensaje);
  if (!porEnlace) {
    const guardada = Buffer.from(usuario.recuperacion_codigo_hash, 'hex');
    const ingresada = huellaCodigoRecuperacion(configuracion, usuario.recuperacion_hash, codigo);
    if (guardada.length !== ingresada.length || !timingSafeEqual(guardada, ingresada)) throw new ApiError(400, mensaje);
  }

  const passwordHash = await protegerClave(password);
  await mongoose.connection.transaction(async () => {
    const cambio = await Usuario.updateOne({
      _id: usuario._id,
      password_hash: usuario.password_hash,
      recuperacion_hash: usuario.recuperacion_hash,
      recuperacion_vence: { $gt: new Date() }
    }, { $set: { password_hash: passwordHash }, $unset: CAMPOS_RECUPERACION });
    if (!cambio.matchedCount) throw new ApiError(400, mensaje);
    await IntentoIngreso.deleteOne({ _id: llaveIngreso(usuario) });
  });

  res.status(200).json(responseFormat(true, 'Contraseña actualizada. Ya puedes iniciar sesión.'));
});

app.use('/api', (req, res, next) => {
  const [, recurso, id] = req.path.toLowerCase().split('/');
  const privados = ['usuarios', 'inventario', 'historial_inventario', 'patrones_predictivos', 'meal_preps', 'notificaciones'];
  const catalogos = ['categorias', 'marcas', 'unidades_medida', 'productos', 'ingredientes'];
  const altaUsuario = recurso === 'usuarios' && !id && req.method === 'POST';
  const modificaCatalogo = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && catalogos.includes(recurso);
  if (altaUsuario || (!privados.includes(recurso) && !modificaCatalogo)) return next();
  return autenticar(req, res, () => {
    if (modificaCatalogo && !ADMINISTRADORES_CATALOGO.has(req.usuarioId)) {
      throw new ApiError(403, 'Solo los administradores pueden modificar el catálogo compartido.');
    }
    next();
  });
});

function usuarioPublico(usuario) {
  const { _id, nombre, email } = usuario;
  return { _id, nombre, email };
}

function perfilWeb(usuario) {
  return { ...perfilEditable(usuario), catalogo_admin: ADMINISTRADORES_CATALOGO.has(usuario._id) };
}

const ESPERA_CAMBIO_NOMBRE_MS = 30 * 24 * 60 * 60 * 1000;

function perfilEditable(usuario) {
  return { ...usuarioPublico(usuario), nombre_editable_desde: usuario.nombre_editable_desde ?? null };
}

function exigirNombreEditable(usuario, ahora) {
  if (usuario?.nombre_editable_desde > ahora) {
    throw new ApiError(409, 'Solo puedes cambiar el usuario una vez cada 30 días.', {
      nombre_editable_desde: usuario.nombre_editable_desde, nombre: usuario.nombre
    });
  }
}

app.get('/api/usuarios/me', (req, res) => {
  res.status(200).json({
    ...responseFormat(true, 'Perfil obtenido', perfilWeb(req.usuario)),
    inactividad_restante_ms: tiempoRestanteSesion(req.sesion)
  });
});

app.post('/api/usuarios/actividad', async (req, res) => {
  const { transcurrido_ms: transcurridoMs = 0 } = req.body ?? {};
  if (!Number.isSafeInteger(transcurridoMs) || transcurridoMs < 0 || transcurridoMs >= INACTIVIDAD_SESION_MS) {
    throw new ApiError(400, 'Envía el tiempo transcurrido desde la última interacción en milisegundos.');
  }
  const sesion = await extenderActividad(req.sesion, new Date(), transcurridoMs);
  if (!sesion) rechazarSesion(req, res);
  if (req.sesionWeb && sesion.vence > req.sesion.vence) escribirCookieSesion(req, res, tokenCookie(req), sesion.vence);
  res.status(200).json(responseFormat(true, 'Actividad registrada', { inactividad_restante_ms: tiempoRestanteSesion(sesion) }));
});

app.post('/api/usuarios/logout', async (req, res) => {
  await enTransaccion(async () => {
    const credencial = huella(req.usuario.password_hash);
    const activa = await buscarSesionActiva(req.usuarioId, credencial, new Date());
    if (activa?._id === req.sesion._id) {
      await Sesion.deleteMany({ usuario: req.usuarioId, credencial });
    }
  });
  res.clearCookie(NOMBRE_COOKIE, opcionesCookieSesion(req));
  res.status(200).json(responseFormat(true, 'Sesión cerrada'));
});

async function idUsuarioRetirado(id) {
  return await IdUsuarioRetirado.exists({ _id: id })
    || await HistorialInventario.exists({ 'snapshot_datos.user_nombre': id });
}

async function generarIdUsuario() {
  for (let intento = 0; intento < 5; intento++) {
    const id = String(randomInt(100_000_000_000_000, 200_000_000_000_000));
    if (!ADMINISTRADORES_CATALOGO.has(id) && !await Usuario.exists({ _id: id }) && !await idUsuarioRetirado(id)) return id;
  }
  throw new ApiError(503, 'No se pudo asignar un ID. Intenta nuevamente.');
}

// 1. Usuarios
app.post('/api/usuarios', async (req, res, next) => {
  try {
    const { id, nombre: nombreEnviado, email: emailEnviado, password, password_hash } = req.body ?? {};
    const nombre = typeof nombreEnviado === 'string' ? nombreEnviado.trim() : '';
    const email = typeof emailEnviado === 'string' ? emailEnviado.trim() : '';
    const clave = password ?? password_hash;
    const idManual = id === undefined ? null : String(id);

    if (idManual !== null && (!idCompatible(Usuario, id) || !/^\d+$/.test(idManual))) {
      return res.status(200).json(responseFormat(false, 'El ID del usuario debe ser un valor numérico.', null));
    }
    if (idManual !== null && ADMINISTRADORES_CATALOGO.has(idManual)) {
      throw new ApiError(403, 'Ese identificador está reservado. Puedes crear la cuenta con un ID automático.');
    }

    if (!nombre || !correoValido(email)) {
      return res.status(200).json(responseFormat(false, 'Ingresa el nombre de usuario y el correo electrónico.', null));
    }

    if (typeof clave !== 'string' || !CLAVE_SEGURA.test(clave)) {
      return res.status(200).json(responseFormat(false, 'La contraseña no cumple con los requisitos de seguridad (mínimo 12 caracteres, mayúsculas, minúsculas, números y símbolos).', null));
    }

    const passwordProtegida = await protegerClave(clave);
    const respuesta = await enTransaccion(async () => {
      const coincidencias = [{ nombre }, { email }];
      if (idManual !== null) coincidencias.push({ _id: idManual });
      const usuarioExistente = await Usuario.exists({ $or: coincidencias });
      if (usuarioExistente) {
        return responseFormat(false, 'El ID, nombre de usuario o correo electrónico ya se encuentran registrados.');
      }

      // Los snapshots también reservan los IDs de cuentas eliminadas antes de este cambio.
      if (idManual !== null && await idUsuarioRetirado(idManual)) {
        return responseFormat(false, 'El ID pertenece a una cuenta anterior y no se puede reutilizar.');
      }

      const idUsuario = idManual ?? await generarIdUsuario();
      const nuevoUsuario = await Usuario.create({ _id: idUsuario, nombre, email, password_hash: passwordProtegida });
      return responseFormat(true, 'Usuario creado exitosamente', usuarioPublico(nuevoUsuario));
    });
    res.status(200).json(respuesta);
  } catch (error) {
    next(error);
  }
});

app.get('/api/usuarios', async (req, res, next) => {
  try {
    const { busqueda } = req.query;
    const filtro = { _id: req.usuarioId };

    if (busqueda && busqueda.trim() !== '') {
      const patron = busqueda.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filtro.$or = ['_id', 'nombre', 'email'].map(campo => ({ [campo]: { $regex: patron, $options: 'i' } }));
    }

    const usuarios = await Usuario.find(filtro);

    if (busqueda && usuarios.length === 0) {
      return res.status(200).json(responseFormat(false, `No se encontró ningún usuario que coincida con '${busqueda}'`, []));
    }

    res.status(200).json(responseFormat(true, 'Consulta de usuarios procesada exitosamente', usuarios));
  } catch (error) {
    next(error);
  }
});

app.get('/api/usuarios/:id', async (req, res, next) => {
  try {
    exigirPropietario(req.usuarioId, req.params.id);
    const usuario = await obtenerOFallar(Usuario, req.params.id);
    res.status(200).json(responseFormat(true, 'Usuario obtenido exitosamente', usuario));
  } catch (error) {
    next(error);
  }
});

app.put('/api/usuarios/:id', async (req, res, next) => {
  try {
    const usuarioId = req.params.id;
    const { nombre, email, password, password_hash, password_actual } = req.body ?? {};
    const clave = password ?? password_hash;
    exigirPropietario(req.usuarioId, usuarioId);

    await obtenerOFallar(Usuario, usuarioId);

    if (nombre !== undefined && (typeof nombre !== 'string' || !nombre.trim())) {
      throw new ApiError(400, 'Ingresa un nombre de usuario válido.');
    }
    if (email !== undefined && !correoValido(typeof email === 'string' ? email.trim() : email)) {
      throw new ApiError(400, 'Ingresa un correo electrónico válido.');
    }

    const datosActualizados = {};
    const cambiaNombre = nombre !== undefined && nombre.trim() !== req.usuario.nombre;
    if (cambiaNombre) {
      exigirNombreEditable(req.usuario, new Date());
      datosActualizados.nombre = nombre.trim();
    }
    if (email !== undefined && email.trim() !== req.usuario.email) datosActualizados.email = email.trim();
    const cambiaCredenciales = datosActualizados.email !== undefined || clave !== undefined;
    if (cambiaCredenciales) {
      const actualValida = typeof password_actual === 'string' && password_actual.length <= 1024
        && (await verificarClave(password_actual, req.usuario.password_hash)).valida;
      if (!actualValida) throw new ApiError(403, 'Confirma tu contraseña actual para guardar este cambio.');
    }

    if (datosActualizados.nombre !== undefined || datosActualizados.email !== undefined) {
      const conflicto = await Usuario.findOne({
        _id: { $ne: usuarioId },
        $or: [
          ...(datosActualizados.nombre !== undefined ? [{ nombre: datosActualizados.nombre }] : []),
          ...(datosActualizados.email !== undefined ? [{ email: datosActualizados.email }] : [])
        ]
      });
      if (conflicto) {
        return res.status(200).json(responseFormat(false, 'El nombre de usuario o el correo ya están en uso por otro registro.', null));
      }
    }

    if (clave !== undefined) {
      if (typeof clave !== 'string' || !CLAVE_SEGURA.test(clave)) {
        return res.status(200).json(responseFormat(false, 'La nueva contraseña no cumple con los requisitos de seguridad.', null));
      }
    }

    if (clave !== undefined) datosActualizados.password_hash = await protegerClave(clave);

    if (!Object.keys(datosActualizados).length) {
      return res.status(200).json(responseFormat(true, 'Perfil obtenido', perfilEditable(req.usuario)));
    }
    const cambios = { $set: datosActualizados };
    if (cambiaCredenciales) cambios.$unset = CAMPOS_RECUPERACION;
    const filtro = { _id: usuarioId };
    if (cambiaCredenciales) filtro.password_hash = req.usuario.password_hash;
    const actualizar = async () => {
      const ahora = new Date();
      if (cambiaNombre) {
        filtro.$or = [{ nombre_editable_desde: null }, { nombre_editable_desde: { $lte: ahora } }];
        datosActualizados.nombre_editable_desde = new Date(ahora.getTime() + ESPERA_CAMBIO_NOMBRE_MS);
      }
      const usuario = await Usuario.findOneAndUpdate(filtro, cambios, { returnDocument: 'after', runValidators: true })
        .select('+nombre_editable_desde');
      if (!usuario) {
        if (cambiaNombre) {
          const vigente = await Usuario.findOne({ _id: usuarioId, password_hash: req.usuario.password_hash })
            .select('+nombre_editable_desde').lean();
          exigirNombreEditable(vigente, ahora);
        }
        throw new ApiError(401, 'La sesión cambió. Vuelve a iniciar sesión.');
      }
      return usuario;
    };
    const usuarioActualizado = clave === undefined ? await actualizar() : await mongoose.connection.transaction(async () => {
      const intento = await IntentoIngreso.findOneAndDelete({ _id: llaveIngreso(req.usuario) }).lean();
      if (intento?.requiere_recuperacion) exigirRecuperacionIngreso();
      return actualizar();
    });
    if (req.sesionWeb && clave !== undefined) res.clearCookie(NOMBRE_COOKIE, opcionesCookieSesion(req));
    res.status(200).json(responseFormat(true, 'Usuario actualizado exitosamente', perfilEditable(usuarioActualizado)));
  } catch (error) {
    next(error);
  }
});

function filtroCuentaParaEliminar(req) {
  const { _id, email, password_hash, nombre } = req.usuario;
  return { _id, email, password_hash, nombre };
}

function hashCodigoEliminacion(configuracion, sesion, nonce, codigo) {
  return createHmac('sha256', configuracion.oauth?.refresh_token ?? configuracion.clave)
    .update(`nevera-eliminacion:${sesion}:${nonce}:${codigo}`).digest('hex');
}

app.post('/api/usuarios/:id/codigo-eliminacion', async (req, res) => {
  exigirPropietario(req.usuarioId, req.params.id);
  const configuracion = configurarCorreo();
  if (!configuracion) throw new ApiError(503, 'El envío de códigos todavía no está disponible.');
  const ahora = Date.now();
  const nonce = randomUUID();
  const codigo = String(randomInt(1_000_000)).padStart(6, '0');
  const sesion = req.sesion._id;
  const filtro = filtroCuentaParaEliminar(req);
  const cambio = await Usuario.updateOne({
    ...filtro,
    'eliminacion_codigo.enviar_despues': { $not: { $gt: new Date(ahora) } },
    'eliminacion_pendiente.vence': { $not: { $gt: new Date(ahora) } }
  }, { $set: { eliminacion_pendiente: { nonce, vence: new Date(ahora + 60_000) } } });
  if (!cambio.matchedCount) throw new ApiError(429, 'Espera un minuto antes de solicitar otro código.');
  const reserva = { ...filtro, 'eliminacion_pendiente.nonce': nonce };
  try {
    await enviarCodigoEliminacion(configuracion, req.usuario.email, codigo);
  } catch {
    await Usuario.updateOne(reserva, { $unset: { eliminacion_pendiente: 1 } });
    throw new ApiError(503, 'No se pudo enviar el código. Inténtalo de nuevo.');
  }
  const enviado = Date.now();
  const activado = await Usuario.updateOne(reserva, {
    $set: { eliminacion_codigo: {
      nonce, sesion, hash: hashCodigoEliminacion(configuracion, sesion, nonce, codigo),
      vence: new Date(enviado + 300_000), enviar_despues: new Date(enviado + 60_000),
      intentos: 0, enviado: true
    } },
    $unset: { eliminacion_pendiente: 1 }
  });
  if (!activado.matchedCount) throw new ApiError(409, 'La cuenta cambió. Solicita otro código.');
  res.status(202).json(responseFormat(true, 'Enviamos el código al correo registrado.'));
});

app.delete('/api/usuarios/:id', async (req, res) => {
  exigirPropietario(req.usuarioId, req.params.id);
  const { nombre, acepta_borrado, password_actual, codigo } = req.body ?? {};
  if (acepta_borrado !== true || nombre !== req.usuario.nombre.replace(/\r\n?|\n/g, ' ')) {
    throw new ApiError(400, 'Escribe el nombre de la cuenta y acepta el borrado permanente.');
  }
  if ((password_actual === undefined) === (codigo === undefined)) {
    throw new ApiError(400, 'Confirma con tu contraseña actual o con el código de correo.');
  }
  const filtro = filtroCuentaParaEliminar(req);
  if (codigo !== undefined) {
    if (typeof codigo !== 'string' || !/^[0-9]{6}$/.test(codigo)) throw new ApiError(400, 'Ingresa un código de seis dígitos.');
    const configuracion = configurarCorreo();
    if (!configuracion) throw new ApiError(503, 'La confirmación por correo no está disponible.');
    const intento = await Usuario.findOneAndUpdate({
      ...filtro, 'eliminacion_codigo.sesion': req.sesion._id, 'eliminacion_codigo.enviado': true,
      'eliminacion_codigo.vence': { $gt: new Date() }, 'eliminacion_codigo.intentos': { $lt: 5 }
    }, { $inc: { 'eliminacion_codigo.intentos': 1 } }).select('+eliminacion_codigo').lean();
    const reto = intento?.eliminacion_codigo;
    if (!reto || !timingSafeEqual(Buffer.from(reto.hash, 'hex'),
      Buffer.from(hashCodigoEliminacion(configuracion, req.sesion._id, reto.nonce, codigo), 'hex'))) {
      throw new ApiError(403, 'El código es incorrecto, venció o agotó sus intentos.');
    }
    filtro['eliminacion_codigo.nonce'] = reto.nonce;
    filtro['eliminacion_codigo.vence'] = { $gt: new Date() };
  } else {
    if (typeof password_actual !== 'string' || !password_actual || password_actual.length > 1024) {
      throw new ApiError(400, 'Ingresa tu contraseña actual.');
    }
    const ahora = new Date();
    const nueva = { $lte: [{ $ifNull: ['$eliminacion_intentos_vence', new Date(0)] }, ahora] };
    const intento = await Usuario.findOneAndUpdate(filtro, [{ $set: {
      eliminacion_intentos: { $cond: [nueva, 1, { $min: [6, { $add: ['$eliminacion_intentos', 1] }] }] },
      eliminacion_intentos_vence: { $cond: [nueva, new Date(ahora.getTime() + 300_000), '$eliminacion_intentos_vence'] }
    } }], { updatePipeline: true, returnDocument: 'after' }).select('+eliminacion_intentos').lean();
    if (!intento || intento.eliminacion_intentos > 5) throw new ApiError(429, 'Espera a que termine el límite de cinco minutos o usa el correo.');
    if (!(await verificarClave(password_actual, req.usuario.password_hash)).valida) {
      throw new ApiError(403, 'La contraseña actual es incorrecta.');
    }
    await Usuario.updateOne(filtro, { $unset: { eliminacion_intentos: 1, eliminacion_intentos_vence: 1 } });
  }
  const respuesta = await enTransaccion(async () => {
    if (!await Sesion.exists({ _id: req.sesion._id, ...filtroSesionVigente(new Date()) })) rechazarSesion(req, res);
    const usuarioEliminado = await eliminarPorId(Usuario, req.params.id, filtro);
    await IdUsuarioRetirado.updateOne({ _id: usuarioEliminado._id }, { $setOnInsert: { _id: usuarioEliminado._id } }, { upsert: true });
    await Sesion.deleteMany({ usuario: req.usuarioId });
    await IntentoIngreso.deleteOne({ _id: llaveIngreso(req.usuario) });
    return responseFormat(true, 'Usuario eliminado exitosamente', usuarioEliminado);
  });
  if (req.sesionWeb) res.clearCookie(NOMBRE_COOKIE, opcionesCookieSesion(req));
  res.status(200).json(respuesta);
});

// 2. Categorías
app.post('/api/categorias', async (req, res, next) => {
  try {
    const nuevaCategoria = new Categoria(req.body);
    await nuevaCategoria.save();
    res.status(200).json(responseFormat(true, 'Categoría creada exitosamente', nuevaCategoria));
  } catch (error) {
    next(error);
  }
});

app.get('/api/categorias', async (req, res, next) => {
  try {
    const { datos, extras } = await consultarLista(Categoria, req.query, ['_id']);
    res.json({ ...responseFormat(true, 'Lista de categorías obtenida', datos), ...extras });
  } catch (error) {
    next(error);
  }
});

app.get('/api/categorias/:id', async (req, res, next) => {
  try {
    const categoria = await obtenerOFallar(Categoria, req.params.id);
    res.status(200).json(responseFormat(true, 'Categoría obtenida exitosamente', categoria));
  } catch (error) {
    next(error);
  }
});

mutacion('delete', '/api/categorias/:id', async req => {
  const categoriaEliminada = await eliminarPorId(Categoria, req.params.id);
  return responseFormat(true, 'Categoría eliminada exitosamente', categoriaEliminada);
});

// 3. Marcas
app.post('/api/marcas', async (req, res, next) => {
  try {
    const nuevaMarca = new Marca(req.body);
    await nuevaMarca.save();
    res.status(200).json(responseFormat(true, 'Marca creada exitosamente', nuevaMarca));
  } catch (error) {
    next(error);
  }
});

app.get('/api/marcas', async (req, res, next) => {
  try {
    const { datos, extras } = await consultarLista(Marca, req.query, ['_id']);
    res.json({ ...responseFormat(true, 'Lista de marcas obtenida', datos), ...extras });
  } catch (error) {
    next(error);
  }
});

app.get('/api/marcas/:id', async (req, res, next) => {
  try {
    const marca = await obtenerOFallar(Marca, req.params.id);
    res.status(200).json(responseFormat(true, 'Marca obtenida exitosamente', marca));
  } catch (error) {
    next(error);
  }
});

mutacion('delete', '/api/marcas/:id', async req => {
  const marcaEliminada = await eliminarPorId(Marca, req.params.id);
  return responseFormat(true, 'Marca eliminada exitosamente', marcaEliminada);
});

// 4. Unidades de Medida
app.post('/api/unidades_medida', async (req, res, next) => {
  try {
    const nuevaUnidad = new UnidadMedida(req.body);
    await nuevaUnidad.save();
    res.status(200).json(responseFormat(true, 'Unidad de medida creada exitosamente', nuevaUnidad));
  } catch (error) {
    next(error);
  }
});

app.get('/api/unidades_medida', async (req, res, next) => {
  try {
    const { datos, extras } = await consultarLista(UnidadMedida, req.query, ['_id']);
    res.json({ ...responseFormat(true, 'Lista de unidades de medida obtenida', datos), ...extras });
  } catch (error) {
    next(error);
  }
});

app.get('/api/unidades_medida/:id', async (req, res, next) => {
  try {
    const unidad = await obtenerOFallar(UnidadMedida, req.params.id);
    res.status(200).json(responseFormat(true, 'Unidad de medida obtenida exitosamente', unidad));
  } catch (error) {
    next(error);
  }
});

mutacion('delete', '/api/unidades_medida/:id', async req => {
  const unidadEliminada = await eliminarPorId(UnidadMedida, req.params.id);
  return responseFormat(true, 'Unidad de medida eliminada exitosamente', unidadEliminada);
});

// 5. Productos
mutacion('post', '/api/productos', async req => {
  const { _id, marca_nombre, categoria_nombre, nombre } = cuerpoConCampos(req.body, ['_id', 'marca_nombre', 'categoria_nombre', 'nombre']);
  await validarReferencias(Producto, { marca_nombre, categoria_nombre });
  const nuevoProducto = new Producto({ _id, marca_nombre, categoria_nombre, nombre });
  await nuevoProducto.save();
  return responseFormat(true, 'Producto creado exitosamente', nuevoProducto);
});

app.get('/api/productos', async (req, res, next) => {
  try {
    const filtro = {};
    for (const campo of ['marca_nombre', 'categoria_nombre']) {
      const valor = req.query[campo];
      if (valor === undefined || valor === '') continue;
      if (typeof valor !== 'string' || !valor.trim()) throw new ApiError(400, 'El filtro de catálogo no es válido.');
      filtro[campo] = valor;
    }
    const { datos: productos, extras } = await consultarLista(Producto, req.query, ['nombre', '_id'], filtro);
    const [marcas, categorias] = productos.length ? await Promise.all([
      Marca.find({ _id: { $in: [...new Set(productos.map(producto => producto.marca_nombre))] } }).lean(),
      Categoria.find({ _id: { $in: [...new Set(productos.map(producto => producto.categoria_nombre))] } }).lean()
    ]) : [[], []];
    const marcasPorId = new Map(marcas.map(marca => [marca._id, marca]));
    const categoriasPorId = new Map(categorias.map(categoria => [categoria._id, categoria]));
    const productosCompletos = productos.map(producto => ({
      ...producto,
      marca_nombre: marcasPorId.get(producto.marca_nombre) ?? producto.marca_nombre,
      categoria_nombre: categoriasPorId.get(producto.categoria_nombre) ?? producto.categoria_nombre
    }));
    res.json({ ...responseFormat(true, 'Lista de productos obtenida', productosCompletos), ...extras });
  } catch (error) {
    next(error);
  }
});

app.get('/api/productos/:id', async (req, res, next) => {
  try {
    const producto = await obtenerOFallar(Producto, req.params.id);
    const marca = await Marca.findById(producto.marca_nombre).lean();
    const categoria = await Categoria.findById(producto.categoria_nombre).lean();
    producto.marca_nombre = marca || producto.marca_nombre;
    producto.categoria_nombre = categoria || producto.categoria_nombre;
    res.status(200).json(responseFormat(true, 'Producto obtenido exitosamente', producto));
  } catch (error) {
    next(error);
  }
});

mutacion('delete', '/api/productos/:id', async req => {
  const productoEliminado = await eliminarPorId(Producto, req.params.id);
  return responseFormat(true, 'Producto eliminado exitosamente', productoEliminado);
});

// 6. Inventario (Con acumulación inteligente si ya existe)
const FECHA_INVENTARIO = /^(\d{4}-(?:0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]))T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i;
const HORA_COLOMBIA_MS = 5 * 60 * 60 * 1000;

function fechaInventario(valor, campo) {
  const partes = typeof valor === 'string' && FECHA_INVENTARIO.exec(valor);
  if (partes) {
    const [, diaCalendario, dia] = partes;
    const fecha = new Date(valor);
    if (new Date(`${diaCalendario}T00:00:00Z`).getUTCDate() === Number(dia) && Number.isFinite(fecha.getTime())) {
      return fecha;
    }
  }
  throw new ApiError(400, `Envía una fecha y hora válidas para ${campo}, con zona horaria.`);
}

function fechaAltaInventario(valor) {
  if (valor == null) return null;
  const fecha = fechaInventario(valor, 'fecha_vencimiento');
  const hoy = new Date(Date.now() - HORA_COLOMBIA_MS).toISOString().slice(0, 10);
  if (fecha < new Date(hoy + 'T00:00:00-05:00')) {
    throw new ApiError(400, 'El vencimiento debe ser de hoy en adelante, según la hora de Colombia.');
  }
  return fecha;
}

function cuerpoInventario(cuerpo) {
  if (!cuerpo || typeof cuerpo !== 'object' || Array.isArray(cuerpo)) {
    throw new ApiError(400, 'Envía un cuerpo JSON con los datos del lote.');
  }
  return cuerpo;
}

function exigirEstadoInventario(estado) {
  if (!ESTADOS_INVENTARIO.includes(estado)) throw new ApiError(400, 'Estado de inventario inválido.');
}

function presentarLote(lote) {
  const { alerta_vencimiento_generada, ...datos } = lote;
  return { ...datos, version: datos.version ?? 0 };
}

function identidadLote(lote) {
  const { user_nombre, nevera_id, producto_id, unidad_medida_nombre, estado } = lote;
  return {
    user_nombre, nevera_id, producto_id, unidad_medida_nombre, estado,
    ingrediente_nombre: lote.ingrediente_nombre ?? null,
    fecha_vencimiento: lote.fecha_vencimiento ?? null
  };
}

function opcionesPaginacion({ pagina, limite }) {
  if (pagina === undefined && limite === undefined) return null;
  const numero = Number(pagina ?? 1);
  const cantidad = Number(limite ?? 25);
  const salto = (numero - 1) * cantidad;
  if (!Number.isSafeInteger(numero) || numero < 1 || !Number.isInteger(cantidad) ||
      cantidad < 1 || cantidad > 100 || !Number.isSafeInteger(salto)) {
    throw new ApiError(400, 'La página debe ser positiva y el límite debe estar entre 1 y 100');
  }
  return { pagina: numero, limite: cantidad, salto };
}

async function consultarLista(Modelo, query, campos, base = {}) {
  const filtro = { ...base };
  if (query.busqueda !== undefined) {
    if (typeof query.busqueda !== 'string' || query.busqueda.length > 100) {
      throw new ApiError(400, 'Escribe una búsqueda de hasta 100 caracteres.');
    }
    const texto = query.busqueda.trim().normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
    if (texto) {
      const letras = { a: '[aáàäâã]', e: '[eéèëê]', i: '[iíìïî]', o: '[oóòöôõ]', u: '[uúùüû]', n: '[nñ]' };
      const patron = [...texto].map(letra => letras[letra] ?? letra.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
      const regex = new RegExp(patron, 'i');
      filtro.$or = campos.map(campo => ({ [campo]: regex }));
    }
  }
  const paginacion = opcionesPaginacion(query);
  const consulta = Modelo.find(filtro).lean();
  if (!paginacion) return { datos: await consulta };
  const { pagina, limite, salto } = paginacion;
  const encontrados = await consulta.sort({ _id: 1 }).skip(salto).limit(limite + 1);
  return {
    datos: encontrados.slice(0, limite),
    extras: { paginacion: { pagina, limite, hay_siguiente: encontrados.length > limite } }
  };
}

function registrarHistorial(item, accion, detalles) {
  return HistorialInventario.create({
    inventario_id: item._id, snapshot_datos: presentarLote(item.toObject()), accion, detalles
  });
}

mutacion('post', '/api/inventario', async req => {
  const cuerpo = cuerpoInventario(req.body);
  const {
    user_nombre, nevera_id = NEVERA_PREDETERMINADA, producto_id, unidad_medida_nombre,
    cantidad, fecha_vencimiento, ingrediente_nombre, estado = 'EN_NEVERA'
  } = cuerpo;
  exigirPropietario(req.usuarioId, user_nombre);
  const faltantes = ['producto_id', 'unidad_medida_nombre', 'cantidad']
    .filter(campo => cuerpo[campo] == null || cuerpo[campo] === '');
  if (faltantes.length) throw new ApiError(400, `Completa estos campos del lote: ${faltantes.join(', ')}.`);
  exigirEstadoInventario(estado);
  const lote = {
    user_nombre: req.usuarioId,
    nevera_id,
    producto_id,
    ingrediente_nombre: ingrediente_nombre === '' ? null : ingrediente_nombre ?? null,
    unidad_medida_nombre,
    fecha_vencimiento: fechaAltaInventario(fecha_vencimiento),
    estado
  };
  await validarReferencias(Inventario, lote);
  const entrada = new Inventario({ ...lote, cantidad });
  await entrada.validate();
  const itemInventario = await Inventario.findOne(identidadLote(entrada)).sort({ _id: 1 }).select('+alerta_vencimiento_generada');

  if (itemInventario) {
    itemInventario.cantidad += entrada.cantidad;
    itemInventario.version = (itemInventario.version ?? 0) + 1;
    await itemInventario.save();

    await registrarHistorial(itemInventario, 'ACTUALIZADO',
      `Se sumaron ${entrada.cantidad} unidades al lote de la nevera ${nevera_id}`);
    await revisarVencimientoGuardado(itemInventario);

    return responseFormat(true, 'El producto ya existía en la nevera; se actualizó la cantidad acumulada.', presentarLote(itemInventario.toObject()));
  }

  const nuevoItem = await entrada.save();
  await registrarHistorial(nuevoItem, 'CREADO', `Se agregó el alimento a la nevera ${nevera_id}`);
  await revisarVencimientoGuardado(nuevoItem);

  return responseFormat(true, 'Alimento agregado al inventario', presentarLote(nuevoItem.toObject()));
});

app.get('/api/inventario', async (req, res, next) => {
  try {
    const { user_nombre, nevera_id, estado, vence_desde, vence_hasta, orden, busqueda } = req.query;
    exigirPropietario(req.usuarioId, user_nombre);
    const filtro = { user_nombre: req.usuarioId };
    if (busqueda !== undefined) {
      if (typeof busqueda !== 'string' || busqueda.length > 100) throw new ApiError(400, 'Escribe un nombre de producto válido.');
      const texto = busqueda.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (texto) {
        const patron = new RegExp(texto, 'i');
        filtro.producto_id = { $in: await Producto.distinct('_id', { $or: [{ _id: patron }, { nombre: patron }] }) };
      }
    }
    if (nevera_id !== undefined) {
      if (typeof nevera_id !== 'string' || !nevera_id.trim()) throw new ApiError(400, 'Envía una nevera válida');
      filtro.nevera_id = nevera_id;
    }
    if (estado !== undefined) {
      exigirEstadoInventario(estado);
      filtro.estado = estado;
    }
    if (vence_desde !== undefined || vence_hasta !== undefined) {
      filtro.fecha_vencimiento = {};
      if (vence_desde !== undefined) filtro.fecha_vencimiento.$gte = fechaInventario(vence_desde, 'vence_desde');
      if (vence_hasta !== undefined) filtro.fecha_vencimiento.$lte = fechaInventario(vence_hasta, 'vence_hasta');
      if (filtro.fecha_vencimiento.$gte > filtro.fecha_vencimiento.$lte) {
        throw new ApiError(400, 'El inicio del rango debe ser anterior a su fin');
      }
    }
    if (orden !== undefined && orden !== 'vencimiento') throw new ApiError(400, 'Orden inválido');
    let consulta;
    if (orden === 'vencimiento') {
      consulta = Inventario.aggregate([
        { $match: filtro },
        { $set: { sin_vencimiento: { $eq: [{ $ifNull: ['$fecha_vencimiento', null] }, null] } } },
        { $sort: { sin_vencimiento: 1, fecha_vencimiento: 1, _id: 1 } },
        { $unset: ['sin_vencimiento', 'alerta_vencimiento_generada'] }
      ]);
    } else {
      consulta = Inventario.find(filtro).sort({ _id: 1 }).lean();
    }
    const paginacion = opcionesPaginacion(req.query);
    if (!paginacion) return res.json(responseFormat(true, 'Lista de inventario obtenida', (await consulta).map(presentarLote)));
    const { pagina, limite, salto } = paginacion;
    const inventarios = await consulta.skip(salto).limit(limite + 1);
    res.json({
      ...responseFormat(true, 'Lista de inventario obtenida', inventarios.slice(0, limite).map(presentarLote)),
      paginacion: { pagina, limite, hay_siguiente: inventarios.length > limite }
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/inventario/resumen', async (req, res) => {
  const ahora = new Date();
  const limite = new Date(ahora.getTime() + 72 * HORA_MS);
  const fecha = '$fecha_vencimiento';
  const tieneFecha = { $eq: [{ $type: fecha }, 'date'] };
  const vencido = { $and: [tieneFecha, { $lt: [fecha, ahora] }] };
  const proximo = { $and: [tieneFecha, { $gte: [fecha, ahora] }, { $lte: [fecha, limite] }] };
  const [{ conteos, vencimientos }] = await Inventario.aggregate([
    { $match: { user_nombre: req.usuarioId, estado: 'EN_NEVERA', cantidad: { $gt: 0 } } },
    { $project: { producto_id: 1, nevera_id: 1, fecha_vencimiento: 1 } },
    { $facet: {
      conteos: [{ $group: {
        _id: null,
        total: { $sum: 1 },
        vencidos: { $sum: { $cond: [vencido, 1, 0] } },
        proximos: { $sum: { $cond: [proximo, 1, 0] } }
      } }, { $unset: '_id' }],
      vencimientos: [
        { $match: { $expr: { $and: [tieneFecha, { $lte: [fecha, limite] }] } } },
        { $sort: { fecha_vencimiento: 1, _id: 1 } },
        { $limit: 8 },
        { $lookup: { from: Producto.collection.collectionName, localField: 'producto_id', foreignField: '_id', as: 'producto' } },
        { $project: {
          nevera_id: 1,
          fecha_vencimiento: 1,
          vencido,
          producto_nombre: { $ifNull: [{ $arrayElemAt: ['$producto.nombre', 0] }, '$producto_id'] }
        } }
      ]
    } }
  ]);
  const totales = conteos[0] ?? { total: 0, vencidos: 0, proximos: 0 };
  res.json(responseFormat(true, 'Resumen de inventario obtenido', { ...totales, vencimientos }));
});

app.get('/api/inventario/:itemId', async (req, res, next) => {
  try {
    const item = await obtenerOFallar(Inventario, req.params.itemId, { user_nombre: req.usuarioId });
    res.status(200).json(responseFormat(true, 'Detalle del alimento obtenido', presentarLote(item)));
  } catch (error) {
    next(error);
  }
});

mutacion('put', '/api/inventario/:itemId', async req => {
  const cuerpo = cuerpoInventario(req.body);
  exigirPropietario(req.usuarioId, cuerpo.user_nombre);
  const campos = ['nevera_id', 'producto_id', 'unidad_medida_nombre', 'cantidad', 'fecha_vencimiento', 'estado', 'ingrediente_nombre'];
  const cambios = Object.fromEntries(campos.filter(campo => Object.hasOwn(cuerpo, campo))
    .map(campo => [campo, cuerpo[campo]]));
  if (!Object.keys(cambios).length) throw new ApiError(400, 'Envía al menos un campo del lote para actualizar.');
  if (Object.hasOwn(cambios, 'estado')) exigirEstadoInventario(cambios.estado);
  if (cuerpo.version !== undefined && (!Number.isSafeInteger(cuerpo.version) || cuerpo.version < 0)) {
    throw new ApiError(400, 'La versión del lote debe ser un entero no negativo.');
  }
  if (cambios.fecha_vencimiento != null) {
    cambios.fecha_vencimiento = fechaInventario(cambios.fecha_vencimiento, 'fecha_vencimiento');
  }
  if (cambios.ingrediente_nombre === '') cambios.ingrediente_nombre = null;
  const filtro = { user_nombre: req.usuarioId };
  const anterior = await obtenerOFallar(Inventario, req.params.itemId, filtro);
  const version = anterior.version ?? 0;
  if (cuerpo.version !== undefined && cuerpo.version !== version) {
    throw new ApiError(409, 'El lote cambió desde que lo consultaste. Recárgalo antes de volver a editar.', {
      conflicto: 'VERSION', inventario_id: anterior._id
    });
  }
  await validarReferencias(Inventario, cambios);

  const guardado = await Inventario.findOneAndUpdate(
    { ...filtro, _id: req.params.itemId }, { $set: { ...cambios, version: version + 1 } },
    { returnDocument: 'after', runValidators: true }
  ).select('+alerta_vencimiento_generada').lean();
  // La transacción revierte la edición si el lote pasa a coincidir con otro.
  const identidad = identidadLote(guardado);
  if (!isDeepStrictEqual(identidad, identidadLote(anterior))) {
    const existente = await Inventario.findOne({ ...identidad, _id: { $ne: guardado._id } })
      .sort({ _id: 1 }).select('_id').lean();
    if (existente) {
      throw new ApiError(409, 'Ya existe un lote con esos datos. Puedes ajustar la cantidad en el lote existente.', {
        inventario_id: existente._id
      });
    }
  }

  if (anterior.fecha_vencimiento?.getTime() !== guardado.fecha_vencimiento?.getTime()
      || anterior.nevera_id !== guardado.nevera_id || anterior.producto_id !== guardado.producto_id
      || anterior.estado !== guardado.estado || (anterior.cantidad > 0) !== (guardado.cantidad > 0)) {
    if (guardado.alerta_vencimiento_generada !== undefined) {
      await Inventario.updateOne({ ...filtro, _id: guardado._id }, { $unset: { alerta_vencimiento_generada: 1 } });
      delete guardado.alerta_vencimiento_generada;
    }
    await desactualizarAvisos(req.usuarioId, { inventario_id: guardado._id, tipo: 'VENCIMIENTO' });
  }

  const itemActualizado = Inventario.hydrate(guardado);
  await registrarHistorial(itemActualizado, 'ACTUALIZADO',
    `Se actualizó el alimento de la nevera ${itemActualizado.nevera_id}`);

  await revisarVencimientoGuardado(guardado);

  return responseFormat(true, 'Alimento actualizado exitosamente', presentarLote(itemActualizado.toObject()));
});

mutacion('delete', '/api/inventario/:itemId', async req => {
  const itemEliminado = await eliminarPorId(Inventario, req.params.itemId, { user_nombre: req.usuarioId });

  await desactualizarAvisos(req.usuarioId, { inventario_id: itemEliminado._id });
  await registrarHistorial(itemEliminado, 'ELIMINADO', 'Se eliminó físicamente el alimento del inventario');

  return responseFormat(true, 'Alimento eliminado exitosamente', presentarLote(itemEliminado.toObject()));
});

// 7. Historial de Inventario
app.get('/api/historial_inventario', async (req, res, next) => {
  try {
    const filtro = await filtroPropietario(HistorialInventario, req.usuarioId);
    const consulta = HistorialInventario.find(filtro).sort({ fecha: -1, _id: -1 }).lean();
    const paginacion = opcionesPaginacion(req.query);
    if (paginacion) consulta.skip(paginacion.salto).limit(paginacion.limite);
    const historial = await consulta;
    res.status(200).json(responseFormat(true, 'Historial de inventario obtenido', historial));
  } catch (error) {
    next(error);
  }
});

app.get('/api/historial_inventario/:id', async (req, res, next) => {
  try {
    const registro = await obtenerOFallar(HistorialInventario, req.params.id,
      await filtroPropietario(HistorialInventario, req.usuarioId));
    res.status(200).json(responseFormat(true, 'Registro de historial obtenido', registro));
  } catch (error) {
    next(error);
  }
});

// 8. Patrones Predictivos
mutacion('post', '/api/patrones_predictivos', async req => {
  const { _id, user_nombre, frecuencia_compra_dias, probabilidad_desperdicio } = cuerpoConCampos(req.body, ['_id']);
  exigirPropietario(req.usuarioId, user_nombre);
  await validarReferencias(PatronPredictivo, { user_nombre: req.usuarioId });
  const nuevoPatron = new PatronPredictivo({ _id, user_nombre: req.usuarioId, frecuencia_compra_dias, probabilidad_desperdicio });
  await nuevoPatron.save();
  return responseFormat(true, 'Patrón predictivo creado exitosamente', nuevoPatron);
});

app.get('/api/patrones_predictivos', async (req, res, next) => {
  try {
    exigirPropietario(req.usuarioId, req.query.user_nombre);
    const filtro = { user_nombre: req.usuarioId };
    const patrones = await PatronPredictivo.find(filtro).lean();
    res.status(200).json(responseFormat(true, 'Patrones predictivos obtenidos', patrones));
  } catch (error) {
    next(error);
  }
});

app.get('/api/patrones_predictivos/:id', async (req, res, next) => {
  try {
    const patron = await obtenerOFallar(PatronPredictivo, req.params.id, { user_nombre: req.usuarioId });
    res.status(200).json(responseFormat(true, 'Patrón predictivo obtenido', patron));
  } catch (error) {
    next(error);
  }
});

// Bloqueada (409) si algún plan de comidas usa este patrón
mutacion('delete', '/api/patrones_predictivos/:id', async req => {
  const patronEliminado = await eliminarPorId(PatronPredictivo, req.params.id, { user_nombre: req.usuarioId });
  return responseFormat(true, 'Patrón predictivo eliminado exitosamente', patronEliminado);
});

// 9. Ingredientes
app.post('/api/ingredientes', async (req, res, next) => {
  try {
    const nuevoIngrediente = new Ingrediente(req.body);
    await nuevoIngrediente.save();
    res.status(200).json(responseFormat(true, 'Ingrediente creado exitosamente', nuevoIngrediente));
  } catch (error) {
    next(error);
  }
});

app.get('/api/ingredientes', async (req, res, next) => {
  try {
    const { datos, extras } = await consultarLista(Ingrediente, req.query, ['_id']);
    res.json({ ...responseFormat(true, 'Lista de ingredientes obtenida', datos), ...extras });
  } catch (error) {
    next(error);
  }
});

app.get('/api/ingredientes/:id', async (req, res, next) => {
  try {
    const ingrediente = await obtenerOFallar(Ingrediente, req.params.id);
    res.status(200).json(responseFormat(true, 'Ingrediente obtenido exitosamente', ingrediente));
  } catch (error) {
    next(error);
  }
});

mutacion('delete', '/api/ingredientes/:id', async req => {
  const ingredienteEliminado = await eliminarPorId(Ingrediente, req.params.id);
  return responseFormat(true, 'Ingrediente eliminado exitosamente', ingredienteEliminado);
});

// 10. Meal Preps
async function datosPlan(body, usuarioId, anterior) {
  const { patron, patron_predictivo_id, ingrediente_nombre, nombre_receta } = body ?? {};
  const nombre = nombre_receta ?? anterior?.nombre_receta;
  const ingrediente = ingrediente_nombre ?? anterior?.ingrediente_nombre;
  if (typeof nombre !== 'string' || !nombre.trim() || typeof ingrediente !== 'string' || !ingrediente.trim()) {
    throw new ApiError(400, 'Ingresa el nombre del plan y elige un ingrediente.');
  }
  await validarReferencias(MealPrep, { ingrediente_nombre: ingrediente });

  let patronId = patron_predictivo_id ?? anterior?.patron_predictivo_id;
  if (patron !== undefined) {
    if (!patron || typeof patron !== 'object' || Array.isArray(patron) || patron_predictivo_id != null) {
      throw new ApiError(400, 'Elige un patrón existente o ingresa un patrón nuevo.');
    }
    const { frecuencia_compra_dias, probabilidad_desperdicio } = patron;
    const nuevo = await PatronPredictivo.create({
      _id: `PATRON-${randomUUID()}`,
      user_nombre: usuarioId,
      frecuencia_compra_dias,
      probabilidad_desperdicio
    });
    patronId = nuevo._id;
  } else {
    if (!patronId) throw new ApiError(400, 'Elige un patrón de compra para el plan.');
    await obtenerOFallar(PatronPredictivo, patronId, { user_nombre: usuarioId });
  }
  const filtro = { patron_predictivo_id: patronId };
  if (anterior) filtro._id = { $ne: anterior._id };
  if (await MealPrep.exists(filtro)) {
    throw new ApiError(200, 'Ya existe un plan de comidas asociado a este patrón predictivo.');
  }
  return { patron_predictivo_id: patronId, ingrediente_nombre: ingrediente, nombre_receta: nombre.trim() };
}

mutacion('post', '/api/meal_preps', async req => {
  const datos = await datosPlan(req.body, req.usuarioId);
  const nuevo = await MealPrep.create(datos);
  return responseFormat(true, 'Plan de comidas creado exitosamente', nuevo);
});

app.get('/api/meal_preps', async (req, res, next) => {
  try {
    const filtro = await filtroPropietario(MealPrep, req.usuarioId);
    const { datos, extras } = await consultarLista(MealPrep, req.query, ['nombre_receta', 'ingrediente_nombre'], filtro);
    const patrones_en_uso = extras ? await MealPrep.distinct('patron_predictivo_id', filtro) : undefined;
    res.json({ ...responseFormat(true, 'Lista de planes obtenida', datos), ...extras, patrones_en_uso });
  } catch (error) {
    next(error);
  }
});

const IDEAS_POR_INGREDIENTE = new Map([
  ['leche', 'Café con leche'],
  ['papa', 'Puré de papa'],
  ['huevo', 'Arroz frito con huevo'],
  ['atun', 'Ensalada de atún'],
  ['pollo', 'Arepa rellena de pollo y aguacate'],
  ['salchicha', 'Perro caliente'],
  ['mora', 'Jugo de mora'],
  ['pulpa de mora', 'Jugo de mora']
]);

app.get('/api/meal_preps/sugerencias', async (req, res) => {
  const [lotes, planes] = await Promise.all([
    Inventario.find({
      user_nombre: req.usuarioId,
      estado: 'EN_NEVERA',
      cantidad: { $gt: 0 },
      ingrediente_nombre: { $type: 'string' },
      $or: [{ fecha_vencimiento: null }, { fecha_vencimiento: { $gte: new Date() } }]
    }).select('ingrediente_nombre fecha_vencimiento').lean(),
    filtroPropietario(MealPrep, req.usuarioId).then(filtro => MealPrep.find(filtro).lean())
  ]);
  lotes.sort((a, b) => (a.fecha_vencimiento?.getTime() ?? Number.MAX_SAFE_INTEGER)
    - (b.fecha_vencimiento?.getTime() ?? Number.MAX_SAFE_INTEGER));
  const sugerencias = [];
  const ingredientesVistos = new Set();
  for (const lote of lotes) {
    const ingrediente = lote.ingrediente_nombre;
    if (ingredientesVistos.has(ingrediente)) continue;
    ingredientesVistos.add(ingrediente);
    const plan = planes.find(item => item.ingrediente_nombre === ingrediente);
    const clave = ingrediente.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
    const nombre = plan?.nombre_receta ?? IDEAS_POR_INGREDIENTE.get(clave);
    if (nombre) {
      sugerencias.push({
        nombre_receta: nombre,
        ingrediente_nombre: ingrediente,
        inventario_id: lote._id,
        fecha_vencimiento: lote.fecha_vencimiento ?? null,
        plan_id: plan?._id ?? null
      });
    }
  }
  res.status(200).json(responseFormat(true, 'Sugerencias de comida obtenidas', sugerencias));
});

app.get('/api/meal_preps/:id', async (req, res, next) => {
  try {
    const mealPrep = await obtenerOFallar(MealPrep, req.params.id, await filtroPropietario(MealPrep, req.usuarioId));
    res.status(200).json(responseFormat(true, 'Plan obtenido', mealPrep));
  } catch (error) {
    next(error);
  }
});

mutacion('put', '/api/meal_preps/:id', async req => {
  const filtro = await filtroPropietario(MealPrep, req.usuarioId);
  const anterior = await obtenerOFallar(MealPrep, req.params.id, filtro);
  const cambios = await datosPlan(req.body, req.usuarioId, anterior);
  const actualizado = await MealPrep.findByIdAndUpdate(anterior._id, { $set: cambios }, {
    returnDocument: 'after', runValidators: true
  });
  return responseFormat(true, 'Plan de comidas actualizado', actualizado);
});

mutacion('delete', '/api/meal_preps/:id', async req => {
  const mealPrepEliminado = await eliminarPorId(MealPrep, req.params.id, await filtroPropietario(MealPrep, req.usuarioId));
  return responseFormat(true, 'Plan eliminado exitosamente', mealPrepEliminado);
});

// 11. Notificaciones
const ORDEN_AVISOS = { fecha: -1, _id: -1 };
const AVISOS_SIN_LEER = { leida: { $ne: true }, desactualizada: { $ne: true } };
const formatearVencimiento = new Intl.DateTimeFormat('es-CO', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Bogota', hourCycle: 'h23'
});

function presentarAviso(aviso) {
  const { fecha_vencimiento, inventario_id, mensaje } = aviso;
  const fechaAnterior = inventario_id && typeof mensaje === 'string' && fecha_vencimiento instanceof Date
    && Number.isFinite(fecha_vencimiento.getTime()) ? fecha_vencimiento.toISOString() : null;
  return {
    ...aviso,
    desactualizada: aviso.desactualizada === true,
    mensaje: fechaAnterior ? mensaje.replace(fechaAnterior, formatearVencimiento.format(fecha_vencimiento)) : mensaje
  };
}

function aumentarRevisionAvisos(usuarioId) {
  return Usuario.updateOne({ _id: usuarioId }, { $inc: { revision_notificaciones: 1 } });
}

async function crearAviso(datos) {
  const aviso = await Notificacion.create(datos);
  await aumentarRevisionAvisos(aviso.user_nombre);
  return aviso;
}

async function desactualizarAvisos(usuarioId, filtro) {
  const resultado = await Notificacion.updateMany({ user_nombre: usuarioId, desactualizada: { $ne: true }, ...filtro },
    { $set: { desactualizada: true } });
  if (resultado.modifiedCount) await aumentarRevisionAvisos(usuarioId);
}

async function revisarAvisosLegados() {
  const anteriores = Notificacion.aggregate([
    { $match: { tipo: 'VENCIMIENTO', inventario_id: { $type: 'objectId' }, desactualizada: { $exists: false } } },
    { $lookup: { from: Inventario.collection.name, localField: 'inventario_id', foreignField: '_id', as: 'lote' } },
    { $set: { lote: { $first: '$lote' } } },
    { $match: { $expr: { $not: [{ $and: [
      { $eq: ['$lote.user_nombre', '$user_nombre'] },
      { $eq: ['$lote.fecha_vencimiento', '$fecha_vencimiento'] },
      { $eq: [{ $ifNull: ['$lote.nevera_id', NEVERA_PREDETERMINADA] }, { $ifNull: ['$nevera_id', NEVERA_PREDETERMINADA] }] },
      { $eq: [{ $ifNull: ['$lote.estado', 'EN_NEVERA'] }, 'EN_NEVERA'] },
      { $gt: ['$lote.cantidad', 0] }
    ] }] } } },
    { $project: { user_nombre: 1 } }
  ]).cursor();
  for await (const aviso of anteriores) {
    await enTransaccion(() => desactualizarAvisos(aviso.user_nombre, { _id: aviso._id, desactualizada: { $exists: false } }));
  }
}

let avisosLegadosListos;
function prepararAvisos() {
  if (!avisosLegadosListos) {
    avisosLegadosListos = revisarAvisosLegados().catch(error => {
      avisosLegadosListos = undefined;
      throw error;
    });
  }
  return avisosLegadosListos;
}

mutacion('post', '/api/notificaciones', async req => {
  const { user_nombre, mensaje, tipo, leida } = cuerpoConCampos(req.body, ['mensaje']);
  if (typeof mensaje !== 'string') throw new ApiError(400, 'Envía el mensaje como texto.');
  exigirPropietario(req.usuarioId, user_nombre);
  await validarReferencias(Notificacion, { user_nombre: req.usuarioId });
  const nuevaNoti = await crearAviso({ user_nombre: req.usuarioId, mensaje, tipo, leida });
  return responseFormat(true, 'Notificación creada exitosamente', nuevaNoti);
});

app.get('/api/notificaciones/resumen', async (req, res) => {
  const conocida = req.query.revision;
  if (conocida !== undefined && (typeof conocida !== 'string' || !/^\d+$/.test(conocida) || !Number.isSafeInteger(Number(conocida)))) {
    throw new ApiError(400, 'Envía una revisión de notificaciones válida.');
  }
  await prepararAvisos();
  const revision = req.usuario.revision_notificaciones ?? 0;
  const filtro = { user_nombre: req.usuarioId };
  const [sin_leer, recientes] = await Promise.all([
    Notificacion.countDocuments({ ...filtro, ...AVISOS_SIN_LEER }),
    conocida !== undefined && Number(conocida) === revision
      ? undefined
      : Notificacion.find(filtro).sort(ORDEN_AVISOS).limit(5).lean()
  ]);
  res.json(responseFormat(true, 'Resumen de notificaciones obtenido', {
    revision, sin_leer, ...(recientes && { recientes: recientes.map(presentarAviso) })
  }));
});

app.get('/api/notificaciones', async (req, res) => {
  const { tipo, lectura, user_nombre } = req.query;
  exigirPropietario(req.usuarioId, user_nombre);
  if (tipo !== undefined && !TIPOS_NOTIFICACION.includes(tipo)) throw new ApiError(400, 'Tipo de notificación inválido.');
  if (lectura !== undefined && !['sin_leer', 'leidas'].includes(lectura)) throw new ApiError(400, 'Estado de lectura inválido.');
  const paginacion = opcionesPaginacion(req.query);
  await prepararAvisos();
  const filtro = { user_nombre: req.usuarioId };
  if (tipo !== undefined) filtro.tipo = tipo;
  if (lectura === 'sin_leer') Object.assign(filtro, AVISOS_SIN_LEER);
  if (lectura === 'leidas') filtro.leida = true;
  const consulta = Notificacion.find(filtro).sort(ORDEN_AVISOS).lean();
  if (!paginacion) return res.json(responseFormat(true, 'Notificaciones obtenidas', (await consulta).map(presentarAviso)));
  const { pagina, limite, salto } = paginacion;
  const avisos = await consulta.skip(salto).limit(limite + 1);
  res.json({
    ...responseFormat(true, 'Notificaciones obtenidas', avisos.slice(0, limite).map(presentarAviso)),
    paginacion: { pagina, limite, hay_siguiente: avisos.length > limite }
  });
});

app.get('/api/notificaciones/:id', async (req, res, next) => {
  try {
    await prepararAvisos();
    const notificacion = await obtenerOFallar(Notificacion, req.params.id, { user_nombre: req.usuarioId });
    res.status(200).json(responseFormat(true, 'Notificación obtenida', presentarAviso(notificacion)));
  } catch (error) {
    next(error);
  }
});

mutacion('patch', '/api/notificaciones/:id', async req => {
  const { leida } = req.body ?? {};
  if (typeof leida !== 'boolean') throw new ApiError(400, 'Indica si la notificación está leída.');
  const filtro = { user_nombre: req.usuarioId };
  const anterior = await obtenerOFallar(Notificacion, req.params.id, filtro);
  const actualizada = await Notificacion.findOneAndUpdate({ ...filtro, _id: req.params.id }, { $set: { leida } }, {
    returnDocument: 'after', runValidators: true
  });
  if (anterior.leida !== leida) await aumentarRevisionAvisos(req.usuarioId);
  return responseFormat(true, leida ? 'Notificación marcada como leída' : 'Notificación marcada como pendiente', presentarAviso(actualizada.toObject()));
});

mutacion('delete', '/api/notificaciones/:id', async req => {
  const notiEliminada = await eliminarPorId(Notificacion, req.params.id, { user_nombre: req.usuarioId });
  await aumentarRevisionAvisos(req.usuarioId);
  return responseFormat(true, 'Notificación eliminada', presentarAviso(notiEliminada.toObject()));
});

// ==========================================
// MIDDLEWARE GLOBAL DE MANEJO DE ERRORES
// ==========================================
function registrarErrorApi(solicitud, categoria, estado) {
  const registro = JSON.stringify({ evento: 'error_api', solicitud, categoria, estado });
  if (estado >= 500) console.error(registro);
  else console.warn(registro);
}

const mensajesErrorHttp = {
  400: 'La solicitud no es válida.',
  413: 'El cuerpo de la solicitud supera el tamaño permitido.',
  415: 'El formato del cuerpo de la solicitud no es compatible.'
};

app.use((err, req, res, next) => {
  const solicitud = randomUUID();
  const responder = (estado, categoria, mensaje, datos) => {
    registrarErrorApi(solicitud, categoria, estado);
    return res.status(estado).json(responseFormat(false, mensaje, datos));
  };

  if (res.headersSent) {
    registrarErrorApi(solicitud, 'respuesta_incompleta', 500);
    return next(new Error('No se pudo completar la respuesta.'));
  }
  res.set('X-Request-Id', solicitud);
  if (err instanceof ApiError) return responder(err.status, 'regla_aplicacion', err.message, err.data);

  // Los rechazos de negocio conservan el contrato de respuesta de la API.
  if (err instanceof mongoose.Error.ValidationError) {
    const campos = Object.keys(err.errors).filter(campo => /^[a-z][a-z0-9_.]{0,63}$/i.test(campo));
    const mensaje = campos.length ? 'Revisa los siguientes campos. ' + campos.join(', ') + '.' : 'Revisa los datos ingresados.';
    return responder(200, 'validacion_datos', mensaje);
  }
  if (err.code === 11000) return responder(200, 'registro_duplicado', 'El identificador o alguno de los valores únicos ya existe.');
  if (err.type === 'entity.parse.failed') return responder(400, 'json_invalido', 'Envía un cuerpo JSON válido.');

  const estado = Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (estado === 500) return responder(500, 'error_interno', 'Error interno del servidor');
  return responder(estado, 'solicitud_invalida', mensajesErrorHttp[estado] ?? mensajesErrorHttp[400]);
});

const HORA_MS = 60 * 60 * 1000;

function filtroAlertasVencimiento(ahora) {
  return {
    estado: 'EN_NEVERA',
    cantidad: { $gt: 0 },
    fecha_vencimiento: { $gte: ahora, $lte: new Date(ahora.getTime() + 72 * HORA_MS) },
    $expr: { $ne: [{ $ifNull: ['$alerta_vencimiento_generada', null] }, '$fecha_vencimiento'] }
  };
}

async function crearAlertaVencimiento(_id, filtro) {
  const item = await Inventario.findOneAndUpdate(
    { ...filtro, _id },
    [{ $set: { alerta_vencimiento_generada: '$fecha_vencimiento' } }],
    { returnDocument: 'after', updatePipeline: true }
  ).lean();
  if (!item) return;
  const producto = await Producto.findById(item.producto_id).select('nombre').lean();
  await crearAviso({
    user_nombre: item.user_nombre,
    nevera_id: item.nevera_id,
    inventario_id: item._id,
    fecha_vencimiento: item.fecha_vencimiento,
    tipo: 'VENCIMIENTO',
    mensaje: `${producto?.nombre ?? item.producto_id} vence el ${formatearVencimiento.format(item.fecha_vencimiento)} (hora de Colombia) en la nevera ${item.nevera_id}.`
  });
}

async function revisarVencimientoGuardado(lote) {
  if (lote.estado !== 'EN_NEVERA' || !(lote.cantidad > 0) || !lote.fecha_vencimiento) return;
  if (lote.alerta_vencimiento_generada?.getTime() === lote.fecha_vencimiento.getTime()) return;
  const filtro = filtroAlertasVencimiento(new Date());
  const { $gte, $lte } = filtro.fecha_vencimiento;
  if (lote.fecha_vencimiento >= $gte && lote.fecha_vencimiento <= $lte) {
    await crearAlertaVencimiento(lote._id, filtro);
  }
}

async function generarAlertasVencimiento() {
  const filtro = filtroAlertasVencimiento(new Date());
  const pendientes = Inventario.find(filtro).select('_id').lean().cursor();
  for await (const { _id } of pendientes) {
    await enTransaccion(() => crearAlertaVencimiento(_id, filtro));
  }
}

function iniciarAlertas() {
  async function revisar() {
    try {
      await generarAlertasVencimiento();
    } catch (error) {
      console.error('No se pudieron generar las alertas de vencimiento:', error.message);
    } finally {
      setTimeout(revisar, HORA_MS).unref();
    }
  }
  void revisar();
}

conexion.then(iniciarAlertas).catch(() => {});
conexion.then(prepararInactividad).catch(() => {});
conexion.then(prepararAvisos).catch(error => console.error('No se pudieron revisar los avisos anteriores:', error.message));

// Inicialización del Servidor
const PORT = process.env.PORT || 3000;
const servidor = app.listen(PORT, () => {
  const { port } = servidor.address();
  console.log(`Servidor corriendo en http://localhost:${port}`);
  console.log(`Documentación interactiva disponible en http://localhost:${port}/api-docs`);
});
