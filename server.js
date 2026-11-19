const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// Redirección automática de la raíz al Swagger
app.get('/', (req, res) => {
  res.redirect('/api-docs');
});

// Configuración de Swagger UI
const swaggerDocument = YAML.load('./swagger.yaml');
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// Conexión a MongoDB Atlas
mongoose.connect(process.env.MONGO_URI)
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
const MSG_EN_USO = 'No se puede eliminar el recurso porque está siendo utilizado por otros registros';

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

// Busca un documento por su _id en tiempo real; si no existe responde 404
const obtenerOFallar = async (Model, id) => {
  const doc = idCompatible(Model, id) ? await Model.findById(id).lean() : null;
  if (!doc) {
    throw new ApiError(404, MSG_NO_ENCONTRADO, { recurso: Model.modelName, id });
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
      throw new ApiError(404, MSG_NO_ENCONTRADO, { campo, valor, recurso: modeloRef });
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

// Elimina por _id: 404 si no existe, 409 (vía plugin) si está referenciado
const eliminarPorId = async (Model, id) => {
  await obtenerOFallar(Model, id);
  return Model.findByIdAndDelete(id);
};

// ==========================================
// MODELOS DE MONGOOSE
// ==========================================

const Usuario = mongoose.model('Usuario', new mongoose.Schema({
  _id: { type: String, required: true },
  nombre: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  password_hash: { type: String, required: true }
}, { collection: 'usuarios', _id: false, versionKey: false }));

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
  nevera_id: { type: String, required: true, default: 'NEVERA-01' },
  producto_id: { type: String, ref: 'Producto', required: true },
  unidad_medida_nombre: { type: String, ref: 'UnidadMedida', required: true },
  cantidad: { type: Number, required: true },
  fecha_vencimiento: { type: Date, default: null },
  estado: { type: String, enum: ['EN_NEVERA', 'CONSUMIDO', 'DESPERDICIADO'], default: 'EN_NEVERA' }
}, { collection: 'inventario', versionKey: false }));

const HistorialInventario = mongoose.model('HistorialInventario', new mongoose.Schema({
  inventario_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Inventario' },
  snapshot_datos: { type: Object, default: null },
  accion: { type: String, enum: ['CREADO', 'ACTUALIZADO', 'ELIMINADO'], required: true },
  detalles: { type: String, required: true },
  fecha: { type: Date, default: Date.now }
}, { collection: 'historial_inventario', versionKey: false }));

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
  leida: { type: Boolean, default: false },
  fecha: { type: Date, default: Date.now }
}, { collection: 'notificaciones', versionKey: false }));

// ==========================================
// RUTAS DE LA API RESTful
// ==========================================

// 1. Usuarios
app.post('/api/usuarios', async (req, res, next) => {
  try {
    const { id, nombre, email, password_hash } = req.body;
    const idAValidar = id || nombre;

    if (!/^\d+$/.test(idAValidar)) {
      return res.status(200).json(responseFormat(false, 'El ID del usuario debe ser un valor numérico.', null));
    }

    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\W_]).{12,}$/;
    if (!passwordRegex.test(password_hash)) {
      return res.status(200).json(responseFormat(false, 'La contraseña no cumple con los requisitos de seguridad (mínimo 12 caracteres, mayúsculas, minúsculas, números y símbolos).', null));
    }

    const usuarioExistente = await Usuario.findOne({ $or: [{ _id: idAValidar }, { nombre }, { email }] });
    if (usuarioExistente) {
      return res.status(200).json(responseFormat(false, 'El ID, nombre de usuario o correo electrónico ya se encuentran registrados.', null));
    }

    const nuevoUsuario = new Usuario({ _id: idAValidar, nombre, email, password_hash });
    await nuevoUsuario.save();
    res.status(200).json(responseFormat(true, 'Usuario creado exitosamente', nuevoUsuario));
  } catch (error) {
    next(error);
  }
});

app.get('/api/usuarios', async (req, res, next) => {
  try {
    const { busqueda } = req.query;
    let filtro = {};

    if (busqueda && busqueda.trim() !== '') {
      filtro = {
        $or: [
          { _id: { $regex: busqueda, $options: 'i' } },
          { nombre: { $regex: busqueda, $options: 'i' } },
          { email: { $regex: busqueda, $options: 'i' } }
        ]
      };
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
    const usuario = await obtenerOFallar(Usuario, req.params.id);
    res.status(200).json(responseFormat(true, 'Usuario obtenido exitosamente', usuario));
  } catch (error) {
    next(error);
  }
});

app.put('/api/usuarios/:id', async (req, res, next) => {
  try {
    const usuarioId = req.params.id;
    const { nombre, email, password_hash } = req.body;

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

    if (password_hash) {
      const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\W_]).{12,}$/;
      if (!passwordRegex.test(password_hash)) {
        return res.status(200).json(responseFormat(false, 'La nueva contraseña no cumple con los requisitos de seguridad.', null));
      }
    }

    const datosActualizados = {};
    if (nombre) datosActualizados.nombre = nombre;
    if (email) datosActualizados.email = email;
    if (password_hash) datosActualizados.password_hash = password_hash;

    const usuarioActualizado = await Usuario.findByIdAndUpdate(usuarioId, datosActualizados, { new: true, runValidators: true });
    res.status(200).json(responseFormat(true, 'Usuario actualizado exitosamente', usuarioActualizado));
  } catch (error) {
    next(error);
  }
});

// Eliminación restringida: bloqueada (409) si el usuario tiene inventario, patrones o notificaciones
app.delete('/api/usuarios/:id', async (req, res, next) => {
  try {
    const usuarioEliminado = await eliminarPorId(Usuario, req.params.id);
    res.status(200).json(responseFormat(true, 'Usuario eliminado exitosamente', usuarioEliminado));
  } catch (error) {
    next(error);
  }
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

app.delete('/api/categorias/:id', async (req, res, next) => {
  try {
    const categoriaEliminada = await eliminarPorId(Categoria, req.params.id);
    res.status(200).json(responseFormat(true, 'Categoría eliminada exitosamente', categoriaEliminada));
  } catch (error) {
    next(error);
  }
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

app.delete('/api/marcas/:id', async (req, res, next) => {
  try {
    const marcaEliminada = await eliminarPorId(Marca, req.params.id);
    res.status(200).json(responseFormat(true, 'Marca eliminada exitosamente', marcaEliminada));
  } catch (error) {
    next(error);
  }
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

app.delete('/api/unidades_medida/:id', async (req, res, next) => {
  try {
    const unidadEliminada = await eliminarPorId(UnidadMedida, req.params.id);
    res.status(200).json(responseFormat(true, 'Unidad de medida eliminada exitosamente', unidadEliminada));
  } catch (error) {
    next(error);
  }
});

// 5. Productos
app.post('/api/productos', async (req, res, next) => {
  try {
    const { _id, marca_nombre, categoria_nombre, nombre } = req.body;
    await validarReferencias(Producto, { marca_nombre, categoria_nombre });
    const nuevoProducto = new Producto({ _id, marca_nombre, categoria_nombre, nombre });
    await nuevoProducto.save();
    res.status(200).json(responseFormat(true, 'Producto creado exitosamente', nuevoProducto));
  } catch (error) {
    next(error);
  }
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

app.delete('/api/productos/:id', async (req, res, next) => {
  try {
    const productoEliminado = await eliminarPorId(Producto, req.params.id);
    res.status(200).json(responseFormat(true, 'Producto eliminado exitosamente', productoEliminado));
  } catch (error) {
    next(error);
  }
});

// 6. Inventario (Con acumulación inteligente si ya existe)
app.post('/api/inventario', async (req, res, next) => {
  try {
    const { user_nombre, nevera_id, producto_id, unidad_medida_nombre, cantidad, fecha_vencimiento, estado } = req.body;

    await validarReferencias(Inventario, { user_nombre, producto_id, unidad_medida_nombre });

    let itemInventario = await Inventario.findOne({
      user_nombre,
      nevera_id,
      producto_id,
      estado: estado || 'EN_NEVERA'
    });

    if (itemInventario) {
      itemInventario.cantidad += Number(cantidad);
      await itemInventario.save();

      await HistorialInventario.create({
        inventario_id: itemInventario._id,
        snapshot_datos: itemInventario.toObject(),
        accion: 'ACTUALIZADO',
        detalles: `Se sumaron ${cantidad} unidades al producto existente en la nevera ${nevera_id}`
      });

      return res.status(200).json(responseFormat(true, 'El producto ya existía en la nevera; se actualizó la cantidad acumulada.', itemInventario));
    }

    const nuevoItem = new Inventario({ user_nombre, nevera_id, producto_id, unidad_medida_nombre, cantidad, fecha_vencimiento, estado });
    await nuevoItem.save();

    await HistorialInventario.create({
      inventario_id: nuevoItem._id,
      snapshot_datos: nuevoItem.toObject(),
      accion: 'CREADO',
      detalles: `Se agregó el alimento a la nevera ${nuevoItem.nevera_id} del usuario ${nuevoItem.user_nombre}`
    });

    res.status(200).json(responseFormat(true, 'Alimento agregado al inventario', nuevoItem));
  } catch (error) {
    next(error);
  }
});

app.get('/api/inventario', async (req, res, next) => {
  try {
    const filtro = {};
    if (req.query.user_nombre) filtro.user_nombre = req.query.user_nombre;
    if (req.query.nevera_id) filtro.nevera_id = req.query.nevera_id;

    await validarReferencias(Inventario, filtro);

    const inventarios = await Inventario.find(filtro).lean();
    res.status(200).json(responseFormat(true, 'Lista de inventario obtenida', inventarios));
  } catch (error) {
    next(error);
  }
});

app.get('/api/inventario/:itemId', async (req, res, next) => {
  try {
    const item = await obtenerOFallar(Inventario, req.params.itemId);
    res.status(200).json(responseFormat(true, 'Detalle del alimento obtenido', item));
  } catch (error) {
    next(error);
  }
});

app.put('/api/inventario/:itemId', async (req, res, next) => {
  try {
    const { _id, ...cambios } = req.body;

    await obtenerOFallar(Inventario, req.params.itemId);
    await validarReferencias(Inventario, cambios);

    const itemActualizado = await Inventario.findByIdAndUpdate(req.params.itemId, cambios, { new: true, runValidators: true });

    await HistorialInventario.create({
      inventario_id: itemActualizado._id,
      snapshot_datos: itemActualizado.toObject(),
      accion: 'ACTUALIZADO',
      detalles: `Se actualizó el alimento del usuario ${itemActualizado.user_nombre}`
    });

    res.status(200).json(responseFormat(true, 'Alimento actualizado exitosamente', itemActualizado));
  } catch (error) {
    next(error);
  }
});

app.delete('/api/inventario/:itemId', async (req, res, next) => {
  try {
    const itemEliminado = await eliminarPorId(Inventario, req.params.itemId);

    await HistorialInventario.create({
      inventario_id: itemEliminado._id,
      snapshot_datos: itemEliminado.toObject(),
      accion: 'ELIMINADO',
      detalles: `Se eliminó físicamente el alimento del inventario`
    });

    res.status(200).json(responseFormat(true, 'Alimento eliminado exitosamente', itemEliminado));
  } catch (error) {
    next(error);
  }
});

// 7. Historial de Inventario
app.get('/api/historial_inventario', async (req, res, next) => {
  try {
    const historial = await HistorialInventario.find().lean();
    res.status(200).json(responseFormat(true, 'Historial de inventario obtenido', historial));
  } catch (error) {
    next(error);
  }
});

app.get('/api/historial_inventario/:id', async (req, res, next) => {
  try {
    const registro = await obtenerOFallar(HistorialInventario, req.params.id);
    res.status(200).json(responseFormat(true, 'Registro de historial obtenido', registro));
  } catch (error) {
    next(error);
  }
});

// 8. Patrones Predictivos
app.post('/api/patrones_predictivos', async (req, res, next) => {
  try {
    const { _id, user_nombre, frecuencia_compra_dias, probabilidad_desperdicio } = req.body;
    await validarReferencias(PatronPredictivo, { user_nombre });
    const nuevoPatron = new PatronPredictivo({ _id, user_nombre, frecuencia_compra_dias, probabilidad_desperdicio });
    await nuevoPatron.save();
    res.status(200).json(responseFormat(true, 'Patrón predictivo creado exitosamente', nuevoPatron));
  } catch (error) {
    next(error);
  }
});

app.get('/api/patrones_predictivos', async (req, res, next) => {
  try {
    const filtro = {};
    if (req.query.user_nombre) filtro.user_nombre = req.query.user_nombre;
    await validarReferencias(PatronPredictivo, filtro);
    const patrones = await PatronPredictivo.find(filtro).lean();
    res.status(200).json(responseFormat(true, 'Patrones predictivos obtenidos', patrones));
  } catch (error) {
    next(error);
  }
});

app.get('/api/patrones_predictivos/:id', async (req, res, next) => {
  try {
    const patron = await obtenerOFallar(PatronPredictivo, req.params.id);
    res.status(200).json(responseFormat(true, 'Patrón predictivo obtenido', patron));
  } catch (error) {
    next(error);
  }
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

app.delete('/api/ingredientes/:id', async (req, res, next) => {
  try {
    const ingredienteEliminado = await eliminarPorId(Ingrediente, req.params.id);
    res.status(200).json(responseFormat(true, 'Ingrediente eliminado exitosamente', ingredienteEliminado));
  } catch (error) {
    next(error);
  }
});

// 10. Meal Preps
app.post('/api/meal_preps', async (req, res, next) => {
  try {
    const { patron_predictivo_id, ingrediente_nombre, nombre_receta } = req.body;
    await validarReferencias(MealPrep, { patron_predictivo_id, ingrediente_nombre });
    const nuevoMealPrep = new MealPrep({ patron_predictivo_id, ingrediente_nombre, nombre_receta });
    await nuevoMealPrep.save();
    res.status(200).json(responseFormat(true, 'Plan de comidas creado exitosamente', nuevoMealPrep));
  } catch (error) {
    if (error.code === 11000) {
      return res.status(200).json(responseFormat(false, 'Ya existe un plan de comidas asociado a este patrón predictivo.', null));
    }
    next(error);
  }
});

app.get('/api/meal_preps', async (req, res, next) => {
  try {
    const mealPreps = await MealPrep.find().lean();
    res.status(200).json(responseFormat(true, 'Lista de planes obtenida', mealPreps));
  } catch (error) {
    next(error);
  }
});

app.get('/api/meal_preps/:id', async (req, res, next) => {
  try {
    const mealPrep = await obtenerOFallar(MealPrep, req.params.id);
    res.status(200).json(responseFormat(true, 'Plan obtenido', mealPrep));
  } catch (error) {
    next(error);
  }
});

app.delete('/api/meal_preps/:id', async (req, res, next) => {
  try {
    const mealPrepEliminado = await eliminarPorId(MealPrep, req.params.id);
    res.status(200).json(responseFormat(true, 'Plan eliminado exitosamente', mealPrepEliminado));
  } catch (error) {
    next(error);
  }
});

// 11. Notificaciones
app.post('/api/notificaciones', async (req, res, next) => {
  try {
    const { user_nombre, mensaje, tipo, leida } = req.body;
    await validarReferencias(Notificacion, { user_nombre });
    const nuevaNoti = new Notificacion({ user_nombre, mensaje, tipo, leida });
    await nuevaNoti.save();
    res.status(200).json(responseFormat(true, 'Notificación creada exitosamente', nuevaNoti));
  } catch (error) {
    next(error);
  }
});

app.get('/api/notificaciones', async (req, res, next) => {
  try {
    const filtro = {};
    if (req.query.user_nombre) filtro.user_nombre = req.query.user_nombre;
    await validarReferencias(Notificacion, filtro);
    const notificaciones = await Notificacion.find(filtro).lean();
    res.status(200).json(responseFormat(true, 'Notificaciones obtenidas', notificaciones));
  } catch (error) {
    next(error);
  }
});

app.get('/api/notificaciones/:id', async (req, res, next) => {
  try {
    const notificacion = await obtenerOFallar(Notificacion, req.params.id);
    res.status(200).json(responseFormat(true, 'Notificación obtenida', notificacion));
  } catch (error) {
    next(error);
  }
});

app.delete('/api/notificaciones/:id', async (req, res, next) => {
  try {
    const notiEliminada = await eliminarPorId(Notificacion, req.params.id);
    res.status(200).json(responseFormat(true, 'Notificación eliminada', notiEliminada));
  } catch (error) {
    next(error);
  }
});

// ==========================================
// MIDDLEWARE GLOBAL DE MANEJO DE ERRORES
// ==========================================
app.use((err, req, res, next) => {
  console.error("Error detectado:", err.message);
  // 404 (ID no encontrado) y 409 (eliminación bloqueada) llevan su código; el resto conserva el formato previo
  const status = err instanceof ApiError ? err.status : 200;
  res.status(status).json({
    success: false,
    message: err.message || 'Error interno del servidor',
    data: err instanceof ApiError ? err.data : null
  });
});

// Inicialización del Servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
  console.log(`Documentación interactiva disponible en http://localhost:${PORT}/api-docs`);
});
