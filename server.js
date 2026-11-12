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
  user_nombre: { type: String, ref: 'Usuario', required: true }, // Aislamiento por usuario
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

// Modelo Meal Prep con restricción de unicidad en patron_predictivo_id
const mealPrepSchema = new mongoose.Schema({
  patron_predictivo_id: { type: String, ref: 'PatronPredictivo', required: true, unique: true },
  ingrediente_nombre: { type: String, ref: 'Ingrediente', required: true },
  nombre_receta: { type: String, required: true }
}, { collection: 'meal_preps', versionKey: false });

const MealPrep = mongoose.models.MealPrep || mongoose.model('MealPrep', mealPrepSchema);

// Nuevo Modelo de Notificaciones
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

// 1. Usuarios (Sin duplicados y validación estricta)
app.post('/api/usuarios', async (req, res, next) => {
  try {
    const { id, nombre, email, password_hash } = req.body;
    
    const usuarioExistente = await Usuario.findOne({ $or: [{ _id: id || nombre }, { nombre }, { email }] });
    if (usuarioExistente) {
      const err = new Error('El nombre de usuario, ID o correo electrónico ya se encuentran registrados.');
      err.statusCode = 400;
      throw err;
    }

    const nuevoUsuario = new Usuario({ 
      _id: id || nombre, 
      nombre, 
      email, 
      password_hash 
    });
    await nuevoUsuario.save();
    res.status(201).json(responseFormat(true, 'Usuario creado exitosamente', nuevoUsuario));
  } catch (error) {
    next(error);
  }
});

app.get('/api/usuarios', async (req, res, next) => {
  try {
    const usuarios = await Usuario.find();
    res.status(200).json(responseFormat(true, 'Lista de usuarios obtenida', usuarios));
  } catch (error) {
    next(error);
  }
});

app.delete('/api/usuarios/:id', async (req, res, next) => {
  try {
    const usuarioEliminado = await Usuario.findByIdAndDelete(req.params.id);
    if (!usuarioEliminado) {
      const err = new Error('Usuario no encontrado');
      err.statusCode = 404;
      throw err;
    }
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
    res.status(201).json(responseFormat(true, 'Categoría creada exitosamente', nuevaCategoria));
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

// 3. Marcas
app.post('/api/marcas', async (req, res, next) => {
  try {
    const nuevaMarca = new Marca(req.body);
    await nuevaMarca.save();
    res.status(201).json(responseFormat(true, 'Marca creada exitosamente', nuevaMarca));
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

app.delete('/api/marcas/:id', async (req, res, next) => {
  try {
    const marcaEliminada = await Marca.findByIdAndDelete(req.params.id);
    if (!marcaEliminada) {
      const err = new Error('Marca no encontrada');
      err.statusCode = 404;
      throw err;
    }
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
    res.status(201).json(responseFormat(true, 'Unidad de medida creada exitosamente', nuevaUnidad));
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

// 5. Productos (Con validación estricta de existencia para Marca y Categoría)
app.post('/api/productos', async (req, res, next) => {
  try {
    const { _id, marca_nombre, categoria_nombre, nombre } = req.body;

    const marcaExiste = await Marca.findById(marca_nombre);
    if (!marcaExiste) {
      const err = new Error(`La marca '${marca_nombre}' no se encuentra registrada. Debe crearla primero.`);
      err.statusCode = 400;
      throw err;
    }

    const categoriaExiste = await Categoria.findById(categoria_nombre);
    if (!categoriaExiste) {
      const err = new Error(`La categoría '${categoria_nombre}' no se encuentra registrada. Debe crearla primero.`);
      err.statusCode = 400;
      throw err;
    }

    const nuevoProducto = new Producto({
      _id,
      marca_nombre,
      categoria_nombre,
      nombre
    });

    await nuevoProducto.save();
    res.status(201).json(responseFormat(true, 'Producto creado exitosamente', nuevoProducto));
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

app.delete('/api/productos/:id', async (req, res, next) => {
  try {
    const productoEliminado = await Producto.findByIdAndDelete(req.params.id);
    if (!productoEliminado) {
      const err = new Error('Producto no encontrado');
      err.statusCode = 404;
      throw err;
    }
    res.status(200).json(responseFormat(true, 'Producto eliminado exitosamente', productoEliminado));
  } catch (error) {
    next(error);
  }
});

// 6. Inventario (Filtrado estricto por usuario y nevera_id)
app.post('/api/inventario', async (req, res, next) => {
  try {
    const nuevoItem = new Inventario(req.body);
    await nuevoItem.save();

    await HistorialInventario.create({
      inventario_id: nuevoItem._id,
      snapshot_datos: nuevoItem.toObject(),
      accion: 'CREADO',
      detalles: `Se agregó el alimento a la nevera ${nuevoItem.nevera_id} del usuario ${nuevoItem.user_nombre}`
    });

    res.status(201).json(responseFormat(true, 'Alimento agregado al inventario', nuevoItem));
  } catch (error) {
    next(error);
  }
});

app.get('/api/inventario', async (req, res, next) => {
  try {
    const filtro = {};
    if (req.query.user_nombre) filtro.user_nombre = req.query.user_nombre;
    if (req.query.nevera_id) filtro.nevera_id = req.query.nevera_id;

    const inventarios = await Inventario.find(filtro).lean();

    const inventariosCompletos = await Promise.all(inventarios.map(async (item) => {
      const usuario = await Usuario.findById(item.user_nombre).lean();
      let producto = await Producto.findById(item.producto_id).lean();
      if (producto) {
        const marca = await Marca.findById(producto.marca_nombre).lean();
        const categoria = await Categoria.findById(producto.categoria_nombre).lean();
        producto.marca_nombre = marca || producto.marca_nombre;
        producto.categoria_nombre = categoria || producto.categoria_nombre;
      }
      const unidadMedida = await UnidadMedida.findById(item.unidad_medida_nombre).lean();

      return {
        ...item,
        user_nombre: usuario || item.user_nombre,
        producto_id: producto || item.producto_id,
        unidad_medida_nombre: unidadMedida || item.unidad_medida_nombre
      };
    }));

    res.status(200).json(responseFormat(true, 'Lista de alimentos en inventario', inventariosCompletos));
  } catch (error) {
    next(error);
  }
});

app.get('/api/inventario/:itemId', async (req, res, next) => {
  try {
    const item = await Inventario.findById(req.params.itemId).lean();
    if (!item) {
      const err = new Error('Alimento no encontrado');
      err.statusCode = 404;
      throw err;
    }
    res.status(200).json(responseFormat(true, 'Detalle del alimento obtenido', item));
  } catch (error) {
    next(error);
  }
});

app.put('/api/inventario/:itemId', async (req, res, next) => {
  try {
    const itemActualizado = await Inventario.findByIdAndUpdate(req.params.itemId, req.body, { new: true });
    if (!itemActualizado) {
      const err = new Error('Alimento no encontrado');
      err.statusCode = 404;
      throw err;
    }

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
    const itemEliminado = await Inventario.findByIdAndDelete(req.params.itemId);
    if (!itemEliminado) {
      const err = new Error('Alimento no encontrado');
      err.statusCode = 404;
      throw err;
    }

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
    res.status(200).json(responseFormat(true, 'Historial de inventario obtenido exitosamente', historial));
  } catch (error) {
    next(error);
  }
});

// 8. Patrones Predictivos (Seguro: sin exponer datos sensibles del usuario)
app.post('/api/patrones_predictivos', async (req, res, next) => {
  try {
    const nuevoPatron = new PatronPredictivo(req.body);
    await nuevoPatron.save();
    res.status(201).json(responseFormat(true, 'Patrón predictivo creado exitosamente', nuevoPatron));
  } catch (error) {
    next(error);
  }
});

app.get('/api/patrones_predictivos', async (req, res, next) => {
  try {
    const filtro = req.query.user_nombre ? { user_nombre: req.query.user_nombre } : {};
    const patrones = await PatronPredictivo.find(filtro).lean();
    res.status(200).json(responseFormat(true, 'Patrones predictivos obtenidos', patrones));
  } catch (error) {
    next(error);
  }
});

// 9. Ingredientes
app.post('/api/ingredientes', async (req, res, next) => {
  try {
    const nuevoIngrediente = new Ingrediente(req.body);
    await nuevoIngrediente.save();
    res.status(201).json(responseFormat(true, 'Ingrediente creado exitosamente', nuevoIngrediente));
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

app.delete('/api/ingredientes/:id', async (req, res, next) => {
  try {
    const ingredienteEliminado = await Ingrediente.findByIdAndDelete(req.params.id);
    if (!ingredienteEliminado) {
      const err = new Error('Ingrediente no encontrado');
      err.statusCode = 404;
      throw err;
    }
    res.status(200).json(responseFormat(true, 'Ingrediente eliminado exitosamente', ingredienteEliminado));
  } catch (error) {
    next(error);
  }
});

// 10. Meal Preps (Con validación estricta, unicidad y método DELETE)
app.post('/api/meal_preps', async (req, res, next) => {
  try {
    const { patron_predictivo_id, ingrediente_nombre, nombre_receta } = req.body;

    const patronExiste = await PatronPredictivo.findById(patron_predictivo_id);
    if (!patronExiste) {
      const err = new Error(`El patrón predictivo '${patron_predictivo_id}' no se encuentra registrado. Debe crearlo primero.`);
      err.statusCode = 400;
      throw err;
    }

    const ingredienteExiste = await Ingrediente.findById(ingrediente_nombre);
    if (!ingredienteExiste) {
      const err = new Error(`El ingrediente '${ingrediente_nombre}' no se encuentra registrado. Debe crearlo primero.`);
      err.statusCode = 400;
      throw err;
    }

    const nuevoMealPrep = new MealPrep({
      patron_predictivo_id,
      ingrediente_nombre,
      nombre_receta
    });

    await nuevoMealPrep.save();
    res.status(201).json(responseFormat(true, 'Plan de comidas creado exitosamente', nuevoMealPrep));
  } catch (error) {
    if (error.code === 11000) {
      error.message = 'Ya existe un plan de comidas asociado a este ID de patrón predictivo. No se permiten duplicados.';
      error.statusCode = 400;
    }
    next(error);
  }
});

app.get('/api/meal_preps', async (req, res, next) => {
  try {
    const mealPreps = await MealPrep.find().lean();
    res.status(200).json(responseFormat(true, 'Lista de planes de comida obtenida', mealPreps));
  } catch (error) {
    next(error);
  }
});

app.delete('/api/meal_preps/:id', async (req, res, next) => {
  try {
    const mealPrepEliminado = await MealPrep.findByIdAndDelete(req.params.id);
    if (!mealPrepEliminado) {
      const err = new Error('Plan de comidas no encontrado');
      err.statusCode = 404;
      throw err;
    }
    res.status(200).json(responseFormat(true, 'Plan de comidas eliminado exitosamente', mealPrepEliminado));
  } catch (error) {
    next(error);
  }
});

// 11. Notificaciones (Con validación estricta de existencia del usuario)
app.post('/api/notificaciones', async (req, res, next) => {
  try {
    const { user_nombre, mensaje, tipo, leida } = req.body;

    // Validar que el usuario exista antes de crear la notificación
    const usuarioExiste = await Usuario.findById(user_nombre);
    if (!usuarioExiste) {
      const err = new Error(`El usuario '${user_nombre}' no se encuentra registrado. Debe crearlo primero.`);
      err.statusCode = 400;
      throw err;
    }

    const nuevaNoti = new Notificacion({
      user_nombre,
      mensaje,
      tipo,
      leida
    });

    await nuevaNoti.save();
    res.status(201).json(responseFormat(true, 'Notificación creada exitosamente', nuevaNoti));
  } catch (error) {
    next(error);
  }
});

app.get('/api/notificaciones', async (req, res, next) => {
  try {
    const filtro = req.query.user_nombre ? { user_nombre: req.query.user_nombre } : {};
    const notificaciones = await Notificacion.find(filtro).lean();
    res.status(200).json(responseFormat(true, 'Notificaciones obtenidas exitosamente', notificaciones));
  } catch (error) {
    next(error);
  }
});

app.delete('/api/notificaciones/:id', async (req, res, next) => {
  try {
    const notiEliminada = await Notificacion.findByIdAndDelete(req.params.id);
    if (!notiEliminada) {
      const err = new Error('Notificación no encontrada');
      err.statusCode = 404;
      throw err;
    }
    res.status(200).json(responseFormat(true, 'Notificación eliminada exitosamente', notiEliminada));
  } catch (error) {
    next(error);
  }
});

// ==========================================
// MIDDLEWARE GLOBAL DE MANEJO DE ERRORES
// ==========================================
app.use((err, req, res, next) => {
  console.error("Error detectado:", err.message);
  const statusCode = err.statusCode || 500;
  const message = err.message || 'Error interno del servidor';

  res.status(statusCode).json({
    success: false,
    message: message,
    data: null
  });
});

// Inicialización del Servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
  console.log(`Documentación interactiva disponible en http://localhost:${PORT}/api-docs`);
});