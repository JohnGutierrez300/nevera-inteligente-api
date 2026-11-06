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
// MODELOS DE MONGOOSE (IDs Numéricos, Multinevera y sin __v)
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

// Historial mejorado con snapshot para asegurar que la info no se pierda al eliminar
const HistorialInventario = mongoose.model('HistorialInventario', new mongoose.Schema({
  inventario_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Inventario' },
  snapshot_datos: { type: Object, default: null }, // Seguro permanente de los datos
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

const MealPrep = mongoose.model('MealPrep', new mongoose.Schema({
  patron_predictivo_id: { type: String, ref: 'PatronPredictivo', required: true },
  ingrediente_nombre: { type: String, ref: 'Ingrediente', required: true },
  nombre_receta: { type: String, required: true }
}, { collection: 'meal_preps', versionKey: false }));

// ==========================================
// RUTAS DE LA API RESTful
// ==========================================

// 1. Usuarios
app.post('/api/usuarios', async (req, res, next) => {
  try {
    const { id, nombre, email, password_hash } = req.body;
    const nuevoUsuario = new Usuario({ 
      _id: id || nombre, 
      nombre, 
      email, 
      password_hash 
    });
    await nuevoUsuario.save();
    res.status(201).json(responseFormat(true, 'Usuario creado exitosamente', nuevoUsuario));
  } catch (error) {
    if (error.code === 11000) {
      error.statusCode = 400;
      error.message = 'El nombre de usuario o el correo electrónico ya se encuentran registrados.';
    }
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

// 5. Productos
app.post('/api/productos', async (req, res, next) => {
  try {
    const nuevoProducto = new Producto(req.body);
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

// 6. Inventario (Con Historial con Snapshot y Soporte de Multinevera)
app.post('/api/inventario', async (req, res, next) => {
  try {
    const nuevoItem = new Inventario(req.body);
    await nuevoItem.save();

    await HistorialInventario.create({
      inventario_id: nuevoItem._id,
      snapshot_datos: nuevoItem.toObject(),
      accion: 'CREADO',
      detalles: `Se agregó el alimento a la nevera ${nuevoItem.nevera_id} con estado ${nuevoItem.estado}`
    });

    res.status(201).json(responseFormat(true, 'Alimento agregado al inventario', nuevoItem));
  } catch (error) {
    next(error);
  }
});

app.get('/api/inventario', async (req, res, next) => {
  try {
    const filtro = req.query.nevera_id ? { nevera_id: req.query.nevera_id } : {};
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

    const usuario = await Usuario.findById(item.user_nombre).lean();
    const producto = await Producto.findById(item.producto_id).lean();
    const unidad = await UnidadMedida.findById(item.unidad_medida_nombre).lean();

    if (producto) {
      producto.marca_nombre = await Marca.findById(producto.marca_nombre).lean();
      producto.categoria_nombre = await Categoria.findById(producto.categoria_nombre).lean();
    }

    const itemCompleto = {
      ...item,
      user_nombre: usuario || item.user_nombre,
      producto_id: producto || item.producto_id,
      unidad_medida_nombre: unidad || item.unidad_medida_nombre
    };

    res.status(200).json(responseFormat(true, 'Detalle del alimento obtenido', itemCompleto));
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
      detalles: `Se actualizó el alimento en la nevera ${itemActualizado.nevera_id}. Estado: ${itemActualizado.estado}, Cantidad: ${itemActualizado.cantidad}`
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

    // Guarda el snapshot completo antes de eliminar para mantener el historial intacto
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

// 8. Patrones Predictivos
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
    const patrones = await PatronPredictivo.find().populate({ path: 'user_nombre', model: 'Usuario' });
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

// 10. Meal Preps
app.post('/api/meal_preps', async (req, res, next) => {
  try {
    const nuevoMealPrep = new MealPrep(req.body);
    await nuevoMealPrep.save();
    res.status(201).json(responseFormat(true, 'Plan de comidas creado exitosamente', nuevoMealPrep));
  } catch (error) {
    next(error);
  }
});

app.get('/api/meal_preps', async (req, res, next) => {
  try {
    const mealPreps = await MealPrep.find().lean();
    
    const mealPrepsCompletos = await Promise.all(mealPreps.map(async (prep) => {
      let patron = await PatronPredictivo.findById(prep.patron_predictivo_id).lean();
      if (patron) {
        const usuario = await Usuario.findById(patron.user_nombre).lean();
        patron.user_nombre = usuario || patron.user_nombre;
      }

      const ingrediente = await Ingrediente.findById(prep.ingrediente_nombre).lean();

      return {
        ...prep,
        patron_predictivo_id: patron || prep.patron_predictivo_id,
        ingrediente_nombre: ingrediente || prep.ingrediente_nombre
      };
    }));

    res.status(200).json(responseFormat(true, 'Lista de planes de comida obtenida', mealPrepsCompletos));
  } catch (error) {
    next(error);
  }
});

// ==========================================
// MIDDLEWARE GLOBAL DE MANEJO DE ERRORES ("FUERA DE BASE")
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