const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');
const { randomBytes } = require('node:crypto');
const { huella, protegerClave, verificarClave } = require('./credenciales');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// Redirección automática de la raíz al Swagger
app.get('/', (req, res) => {
  res.redirect('/api-docs');
});

// Configuración de Swagger UI
// `customJs` inyecta el script que valida los IDs mientras se escriben (sin presionar "Execute")
app.use('/swagger-assets', express.static(path.join(__dirname, 'public')));
const swaggerDocument = YAML.load(path.join(__dirname, 'swagger.yaml'));
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
  password_hash: { type: String, required: true, select: false }
}, { collection: 'usuarios', _id: false, versionKey: false }));

const Sesion = mongoose.model('Sesion', new mongoose.Schema({
  _id: String,
  usuario: { type: String, required: true },
  credencial: { type: String, required: true },
  vence: { type: Date, required: true, expires: 0 }
}, { collection: 'sesiones', versionKey: false }));

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
  unidad_medida_nombre: { type: String, ref: 'UnidadMedida', required: true },
  cantidad: { type: Number, required: true, min: 0, validate: Number.isFinite },
  fecha_vencimiento: { type: Date, default: null },
  estado: { type: String, enum: ESTADOS_INVENTARIO, default: 'EN_NEVERA' },
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
  frecuencia_compra_dias: { type: Number },
  probabilidad_desperdicio: { type: Number }
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

const Notificacion = mongoose.model('Notificacion', new mongoose.Schema({
  user_nombre: { type: String, ref: 'Usuario', required: true },
  mensaje: { type: String, required: true },
  tipo: { type: String, enum: ['VENCIMIENTO', 'STOCK_BAJO', 'SUGERENCIA'], default: 'SUGERENCIA' },
  nevera_id: String,
  inventario_id: mongoose.Schema.Types.ObjectId,
  leida: { type: Boolean, default: false },
  fecha: { type: Date, default: Date.now }
}, { collection: 'notificaciones', versionKey: false }));

const DURACION_SESION_MS = 24 * 60 * 60 * 1000;
const CLAVE_SEGURA = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\W_]).{12,1024}$/;

async function autenticar(req, res, next) {
  const token = /^Bearer ([a-f0-9]{64})$/i.exec(req.get('authorization') || '');
  const sesion = token && await Sesion.findOne({ _id: huella(token[1]), vence: { $gt: new Date() } }).lean();
  const usuario = sesion && await Usuario.findById(sesion.usuario).select('+password_hash').lean();
  if (typeof usuario?.password_hash !== 'string' || huella(usuario.password_hash) !== sesion.credencial) {
    res.set('WWW-Authenticate', 'Bearer');
    throw new ApiError(401, 'Inicia sesión y proporciona un token válido');
  }
  req.usuarioId = usuario._id;
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
    // Serializa las altas de referencias y los borrados entre instancias de la API.
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
  const { id, password, password_hash } = req.body ?? {};
  const clave = password ?? password_hash;
  const usuario = idCompatible(Usuario, id) && typeof clave === 'string' && clave.length <= 1024
    ? await Usuario.findById(id).select('+password_hash')
    : null;
  const resultado = usuario && await verificarClave(clave, usuario.password_hash);
  if (!resultado?.valida) throw new ApiError(401, 'Credenciales inválidas');

  if (resultado.anterior) {
    const hash = await protegerClave(clave);
    const migracion = await Usuario.updateOne(
      { _id: usuario._id, password_hash: usuario.password_hash },
      { $set: { password_hash: hash } }
    );
    if (!migracion.matchedCount) throw new ApiError(401, 'Vuelve a iniciar sesión');
    usuario.password_hash = hash;
  }

  const token = randomBytes(32).toString('hex');
  const vence = new Date(Date.now() + DURACION_SESION_MS);
  await Sesion.create({ _id: huella(token), usuario: usuario._id, credencial: huella(usuario.password_hash), vence });
  res.set('Cache-Control', 'no-store');
  res.status(200).json(responseFormat(true, 'Sesión iniciada', { token, vence }));
});

app.use('/api', (req, res, next) => {
  const [, recurso, id] = req.path.toLowerCase().split('/');
  const privados = ['usuarios', 'inventario', 'historial_inventario', 'patrones_predictivos', 'meal_preps', 'notificaciones'];
  const catalogos = ['categorias', 'marcas', 'unidades_medida', 'productos', 'ingredientes'];
  const altaUsuario = recurso === 'usuarios' && !id && req.method === 'POST';
  const escritura = ['POST', 'PUT', 'DELETE'].includes(req.method);
  if (altaUsuario || (!privados.includes(recurso) && !(escritura && catalogos.includes(recurso)))) return next();
  return autenticar(req, res, next);
});

function usuarioPublico(usuario) {
  const { _id, nombre, email } = usuario;
  return { _id, nombre, email };
}

// 1. Usuarios
app.post('/api/usuarios', async (req, res, next) => {
  try {
    const { id, nombre, email, password, password_hash } = req.body;
    const clave = password ?? password_hash;
    const idAValidar = id || nombre;

    if (!/^\d+$/.test(idAValidar)) {
      return res.status(200).json(responseFormat(false, 'El ID del usuario debe ser un valor numérico.', null));
    }

    if (typeof clave !== 'string' || !CLAVE_SEGURA.test(clave)) {
      return res.status(200).json(responseFormat(false, 'La contraseña no cumple con los requisitos de seguridad (mínimo 12 caracteres, mayúsculas, minúsculas, números y símbolos).', null));
    }

    const usuarioExistente = await Usuario.findOne({ $or: [{ _id: idAValidar }, { nombre }, { email }] });
    if (usuarioExistente) {
      return res.status(200).json(responseFormat(false, 'El ID, nombre de usuario o correo electrónico ya se encuentran registrados.', null));
    }

    const nuevoUsuario = new Usuario({ _id: idAValidar, nombre, email, password_hash: await protegerClave(clave) });
    await nuevoUsuario.save();
    res.status(200).json(responseFormat(true, 'Usuario creado exitosamente', usuarioPublico(nuevoUsuario)));
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
    const { nombre, email, password, password_hash } = req.body;
    const clave = password ?? password_hash;
    exigirPropietario(req.usuarioId, usuarioId);

    await obtenerOFallar(Usuario, usuarioId);

    if (nombre || email) {
      const conflicto = await Usuario.findOne({
        _id: { $ne: usuarioId },
        $or: [
          ...(nombre ? [{ nombre }] : []),
          ...(email ? [{ email }] : [])
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

    const datosActualizados = {};
    if (nombre) datosActualizados.nombre = nombre;
    if (email) datosActualizados.email = email;
    if (clave !== undefined) datosActualizados.password_hash = await protegerClave(clave);

    const usuarioActualizado = await Usuario.findByIdAndUpdate(usuarioId, datosActualizados, { returnDocument: 'after', runValidators: true });
    res.status(200).json(responseFormat(true, 'Usuario actualizado exitosamente', usuarioActualizado));
  } catch (error) {
    next(error);
  }
});

// Eliminación restringida: bloqueada (409) si el usuario tiene inventario, patrones o notificaciones
mutacion('delete', '/api/usuarios/:id', async req => {
  exigirPropietario(req.usuarioId, req.params.id);
  const usuarioEliminado = await eliminarPorId(Usuario, req.params.id);
  await Sesion.deleteMany({ usuario: req.usuarioId });
  return responseFormat(true, 'Usuario eliminado exitosamente', usuarioEliminado);
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
    const categorias = await Categoria.find();
    res.status(200).json(responseFormat(true, 'Lista de categorías obtenida', categorias));
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
    const marcas = await Marca.find();
    res.status(200).json(responseFormat(true, 'Lista de marcas obtenida', marcas));
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
    const unidades = await UnidadMedida.find();
    res.status(200).json(responseFormat(true, 'Lista de unidades de medida obtenida', unidades));
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
  const { _id, marca_nombre, categoria_nombre, nombre } = req.body;
  await validarReferencias(Producto, { marca_nombre, categoria_nombre });
  const nuevoProducto = new Producto({ _id, marca_nombre, categoria_nombre, nombre });
  await nuevoProducto.save();
  return responseFormat(true, 'Producto creado exitosamente', nuevoProducto);
});

app.get('/api/productos', async (req, res, next) => {
  try {
    const productos = await Producto.find().lean();
    const productosCompletos = await Promise.all(productos.map(async (prod) => {
      const marca = await Marca.findById(prod.marca_nombre).lean();
      const categoria = await Categoria.findById(prod.categoria_nombre).lean();
      return {
        ...prod,
        marca_nombre: marca || prod.marca_nombre,
        categoria_nombre: categoria || prod.categoria_nombre
      };
    }));
    res.status(200).json(responseFormat(true, 'Lista de productos obtenida', productosCompletos));
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
function fechaInventario(valor) {
  if (typeof valor !== 'string' || !valor.trim()) throw new ApiError(400, 'Envía una fecha válida');
  const fecha = new Date(valor);
  if (!Number.isFinite(fecha.getTime())) throw new ApiError(400, 'Envía una fecha válida');
  return fecha;
}

function paginar(consulta, { pagina, limite }) {
  if (pagina === undefined && limite === undefined) return consulta;
  const numero = Number(pagina ?? 1);
  const cantidad = Number(limite ?? 25);
  const salto = (numero - 1) * cantidad;
  if (!Number.isSafeInteger(numero) || numero < 1 || !Number.isInteger(cantidad) ||
      cantidad < 1 || cantidad > 100 || !Number.isSafeInteger(salto)) {
    throw new ApiError(400, 'La página debe ser positiva y el límite debe estar entre 1 y 100');
  }
  return consulta.skip(salto).limit(cantidad);
}

function registrarHistorial(item, accion, detalles) {
  const { alerta_vencimiento_generada, ...snapshot } = item.toObject();
  return HistorialInventario.create({
    inventario_id: item._id, snapshot_datos: snapshot, accion, detalles
  });
}

mutacion('post', '/api/inventario', async req => {
  const {
    user_nombre, nevera_id = NEVERA_PREDETERMINADA, producto_id, unidad_medida_nombre,
    cantidad, fecha_vencimiento, estado = 'EN_NEVERA'
  } = req.body;
  exigirPropietario(req.usuarioId, user_nombre);
  const lote = {
    user_nombre: req.usuarioId,
    nevera_id,
    producto_id,
    unidad_medida_nombre,
    fecha_vencimiento: fecha_vencimiento == null ? null : fechaInventario(fecha_vencimiento),
    estado
  };
  await validarReferencias(Inventario, lote);
  const entrada = new Inventario({ ...lote, cantidad });
  await entrada.validate();
  const itemInventario = await Inventario.findOne(lote).sort({ _id: 1 });

  if (itemInventario) {
    itemInventario.cantidad += entrada.cantidad;
    await itemInventario.save();

    await registrarHistorial(itemInventario, 'ACTUALIZADO',
      `Se sumaron ${entrada.cantidad} unidades al lote de la nevera ${nevera_id}`);

    return responseFormat(true, 'El producto ya existía en la nevera; se actualizó la cantidad acumulada.', itemInventario);
  }

  const nuevoItem = await entrada.save();
  await registrarHistorial(nuevoItem, 'CREADO', `Se agregó el alimento a la nevera ${nevera_id}`);

  return responseFormat(true, 'Alimento agregado al inventario', nuevoItem);
});

app.get('/api/inventario', async (req, res, next) => {
  try {
    const { user_nombre, nevera_id, estado, vence_desde, vence_hasta, orden } = req.query;
    exigirPropietario(req.usuarioId, user_nombre);
    const filtro = { user_nombre: req.usuarioId };
    if (nevera_id !== undefined) {
      if (typeof nevera_id !== 'string' || !nevera_id.trim()) throw new ApiError(400, 'Envía una nevera válida');
      filtro.nevera_id = nevera_id;
    }
    if (estado !== undefined) {
      if (!ESTADOS_INVENTARIO.includes(estado)) throw new ApiError(400, 'Estado de inventario inválido');
      filtro.estado = estado;
    }
    if (vence_desde !== undefined || vence_hasta !== undefined) {
      filtro.fecha_vencimiento = {};
      if (vence_desde !== undefined) filtro.fecha_vencimiento.$gte = fechaInventario(vence_desde);
      if (vence_hasta !== undefined) filtro.fecha_vencimiento.$lte = fechaInventario(vence_hasta);
      if (filtro.fecha_vencimiento.$gte > filtro.fecha_vencimiento.$lte) {
        throw new ApiError(400, 'El inicio del rango debe ser anterior a su fin');
      }
    }
    if (orden !== undefined && orden !== 'vencimiento') throw new ApiError(400, 'Orden inválido');
    if (orden === 'vencimiento') {
      const consulta = Inventario.aggregate([
        { $match: filtro },
        { $set: { sin_vencimiento: { $eq: [{ $ifNull: ['$fecha_vencimiento', null] }, null] } } },
        { $sort: { sin_vencimiento: 1, fecha_vencimiento: 1, _id: 1 } },
        { $unset: ['sin_vencimiento', 'alerta_vencimiento_generada'] }
      ]);
      const inventarios = await paginar(consulta, req.query);
      return res.status(200).json(responseFormat(true, 'Lista de inventario obtenida', inventarios));
    }
    const inventarios = await paginar(Inventario.find(filtro).sort({ _id: 1 }).lean(), req.query);
    res.status(200).json(responseFormat(true, 'Lista de inventario obtenida', inventarios));
  } catch (error) {
    next(error);
  }
});

app.get('/api/inventario/:itemId', async (req, res, next) => {
  try {
    const item = await obtenerOFallar(Inventario, req.params.itemId, { user_nombre: req.usuarioId });
    res.status(200).json(responseFormat(true, 'Detalle del alimento obtenido', item));
  } catch (error) {
    next(error);
  }
});

mutacion('put', '/api/inventario/:itemId', async req => {
  exigirPropietario(req.usuarioId, req.body.user_nombre);
  const campos = ['nevera_id', 'producto_id', 'unidad_medida_nombre', 'cantidad', 'fecha_vencimiento', 'estado'];
  const cambios = Object.fromEntries(campos.filter(campo => Object.hasOwn(req.body, campo))
    .map(campo => [campo, req.body[campo]]));
  if (cambios.fecha_vencimiento != null) cambios.fecha_vencimiento = fechaInventario(cambios.fecha_vencimiento);
  const filtro = { user_nombre: req.usuarioId };
  await obtenerOFallar(Inventario, req.params.itemId, filtro);
  await validarReferencias(Inventario, cambios);

  const itemActualizado = await Inventario.findOneAndUpdate(
    { ...filtro, _id: req.params.itemId }, { $set: cambios }, { returnDocument: 'after', runValidators: true }
  );

  await registrarHistorial(itemActualizado, 'ACTUALIZADO',
    `Se actualizó el alimento de la nevera ${itemActualizado.nevera_id}`);

  return responseFormat(true, 'Alimento actualizado exitosamente', itemActualizado);
});

mutacion('delete', '/api/inventario/:itemId', async req => {
  const itemEliminado = await eliminarPorId(Inventario, req.params.itemId, { user_nombre: req.usuarioId });

  await registrarHistorial(itemEliminado, 'ELIMINADO', 'Se eliminó físicamente el alimento del inventario');

  return responseFormat(true, 'Alimento eliminado exitosamente', itemEliminado);
});

// 7. Historial de Inventario
app.get('/api/historial_inventario', async (req, res, next) => {
  try {
    const filtro = await filtroPropietario(HistorialInventario, req.usuarioId);
    const historial = await paginar(HistorialInventario.find(filtro).sort({ fecha: -1, _id: -1 }).lean(), req.query);
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
  const { _id, user_nombre, frecuencia_compra_dias, probabilidad_desperdicio } = req.body;
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
    const ingredientes = await Ingrediente.find();
    res.status(200).json(responseFormat(true, 'Lista de ingredientes obtenida', ingredientes));
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
mutacion('post', '/api/meal_preps', async req => {
  try {
    const { patron_predictivo_id, ingrediente_nombre, nombre_receta } = req.body;
    await validarReferencias(MealPrep, { patron_predictivo_id, ingrediente_nombre });
    await obtenerOFallar(PatronPredictivo, patron_predictivo_id, { user_nombre: req.usuarioId });
    const nuevoMealPrep = new MealPrep({ patron_predictivo_id, ingrediente_nombre, nombre_receta });
    await nuevoMealPrep.save();
    return responseFormat(true, 'Plan de comidas creado exitosamente', nuevoMealPrep);
  } catch (error) {
    if (error.code === 11000) {
      throw new ApiError(200, 'Ya existe un plan de comidas asociado a este patrón predictivo.');
    }
    throw error;
  }
});

app.get('/api/meal_preps', async (req, res, next) => {
  try {
    const mealPreps = await MealPrep.find(await filtroPropietario(MealPrep, req.usuarioId)).lean();
    res.status(200).json(responseFormat(true, 'Lista de planes obtenida', mealPreps));
  } catch (error) {
    next(error);
  }
});

app.get('/api/meal_preps/:id', async (req, res, next) => {
  try {
    const mealPrep = await obtenerOFallar(MealPrep, req.params.id, await filtroPropietario(MealPrep, req.usuarioId));
    res.status(200).json(responseFormat(true, 'Plan obtenido', mealPrep));
  } catch (error) {
    next(error);
  }
});

mutacion('delete', '/api/meal_preps/:id', async req => {
  const mealPrepEliminado = await eliminarPorId(MealPrep, req.params.id, await filtroPropietario(MealPrep, req.usuarioId));
  return responseFormat(true, 'Plan eliminado exitosamente', mealPrepEliminado);
});

// 11. Notificaciones
mutacion('post', '/api/notificaciones', async req => {
  const { user_nombre, mensaje, tipo, leida } = req.body;
  exigirPropietario(req.usuarioId, user_nombre);
  await validarReferencias(Notificacion, { user_nombre: req.usuarioId });
  const nuevaNoti = new Notificacion({ user_nombre: req.usuarioId, mensaje, tipo, leida });
  await nuevaNoti.save();
  return responseFormat(true, 'Notificación creada exitosamente', nuevaNoti);
});

app.get('/api/notificaciones', async (req, res, next) => {
  try {
    exigirPropietario(req.usuarioId, req.query.user_nombre);
    const filtro = { user_nombre: req.usuarioId };
    const notificaciones = await Notificacion.find(filtro).lean();
    res.status(200).json(responseFormat(true, 'Notificaciones obtenidas', notificaciones));
  } catch (error) {
    next(error);
  }
});

app.get('/api/notificaciones/:id', async (req, res, next) => {
  try {
    const notificacion = await obtenerOFallar(Notificacion, req.params.id, { user_nombre: req.usuarioId });
    res.status(200).json(responseFormat(true, 'Notificación obtenida', notificacion));
  } catch (error) {
    next(error);
  }
});

mutacion('delete', '/api/notificaciones/:id', async req => {
  const notiEliminada = await eliminarPorId(Notificacion, req.params.id, { user_nombre: req.usuarioId });
  return responseFormat(true, 'Notificación eliminada', notiEliminada);
});

// ==========================================
// MIDDLEWARE GLOBAL DE MANEJO DE ERRORES
// ==========================================
app.use((err, req, res, next) => {
  console.error("Error detectado:", err.message);
  if (err instanceof ApiError) {
    return res.status(err.status).json(responseFormat(false, err.message, err.data));
  }

  // Los rechazos de negocio conservan el contrato de respuesta de la API.
  if (err instanceof mongoose.Error.ValidationError || err.code === 11000) {
    return res.status(200).json(responseFormat(false, err.message));
  }

  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 500
    ? err.status
    : 500;
  const message = status === 500 ? 'Error interno del servidor' : err.message;
  res.status(status).json(responseFormat(false, message));
});

const HORA_MS = 60 * 60 * 1000;
async function generarAlertasVencimiento() {
  const ahora = new Date();
  const filtro = {
    estado: 'EN_NEVERA',
    cantidad: { $gt: 0 },
    fecha_vencimiento: { $gte: ahora, $lte: new Date(ahora.getTime() + 72 * HORA_MS) },
    $expr: { $ne: [{ $ifNull: ['$alerta_vencimiento_generada', null] }, '$fecha_vencimiento'] }
  };
  const pendientes = Inventario.find(filtro).select('_id').lean().cursor();
  for await (const { _id } of pendientes) {
    await enTransaccion(async () => {
      const item = await Inventario.findOneAndUpdate(
        { ...filtro, _id },
        [{ $set: { alerta_vencimiento_generada: '$fecha_vencimiento' } }],
        { returnDocument: 'after', updatePipeline: true }
      );
      if (!item) return;
      const producto = await Producto.findById(item.producto_id).select('nombre').lean();
      await Notificacion.create({
        user_nombre: item.user_nombre,
        nevera_id: item.nevera_id,
        inventario_id: item._id,
        tipo: 'VENCIMIENTO',
        mensaje: `${producto?.nombre ?? item.producto_id} vence el ${item.fecha_vencimiento.toISOString()} en la nevera ${item.nevera_id}.`
      });
    });
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

// Inicialización del Servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
  console.log(`Documentación interactiva disponible en http://localhost:${PORT}/api-docs`);
});
