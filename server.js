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
// MODELOS DE MONGOOSE (Claves Naturales y Árbol)
// ==========================================

const Usuario = mongoose.model('Usuario', new mongoose.Schema({
  _id: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password_hash: { type: String, required: true }
}, { collection: 'usuarios', _id: false }));

const Categoria = mongoose.model('Categoria', new mongoose.Schema({
  _id: { type: String, required: true }
}, { collection: 'categorias', _id: false }));

const UnidadMedida = mongoose.model('UnidadMedida', new mongoose.Schema({
  _id: { type: String, required: true },
  abreviatura: { type: String, required: true }
}, { collection: 'unidades_medida', _id: false }));

const Marca = mongoose.model('Marca', new mongoose.Schema({
  _id: { type: String, required: true }
}, { collection: 'marcas', _id: false }));

const Producto = mongoose.model('Producto', new mongoose.Schema({
  _id: { type: String, required: true },
  marca_nombre: { type: String, ref: 'Marca', required: true },
  categoria_nombre: { type: String, ref: 'Categoria', required: true },
  nombre: { type: String, required: true }
}, { collection: 'productos', _id: false }));

const Inventario = mongoose.model('Inventario', new mongoose.Schema({
  user_nombre: { type: String, ref: 'Usuario', required: true },
  producto_id: { type: String, ref: 'Producto', required: true },
  unidad_medida_nombre: { type: String, ref: 'UnidadMedida', required: true },
  cantidad: { type: Number, required: true },
  fecha_vencimiento: { type: Date, default: null },
  estado: { type: String, enum: ['EN_NEVERA', 'CONSUMIDO', 'DESPERDICIADO'], default: 'EN_NEVERA' }
}, { collection: 'inventario' }));

const HistorialInventario = mongoose.model('HistorialInventario', new mongoose.Schema({
  inventario_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Inventario', required: true },
  accion: { type: String, enum: ['CREADO', 'ACTUALIZADO', 'ELIMINADO'], required: true },
  detalles: { type: String, required: true },
  fecha: { type: Date, default: Date.now }
}, { collection: 'historial_inventario' }));

const PatronPredictivo = mongoose.model('PatronPredictivo', new mongoose.Schema({
  _id: { type: String, required: true },
  user_nombre: { type: String, ref: 'Usuario', required: true },
  frecuencia_compra_dias: { type: Number },
  probabilidad_desperdicio: { type: Number }
}, { collection: 'patrones_predictivos', _id: false }));

const Ingrediente = mongoose.model('Ingrediente', new mongoose.Schema({
  _id: { type: String, required: true }
}, { collection: 'ingredientes', _id: false }));

const MealPrep = mongoose.model('MealPrep', new mongoose.Schema({
  patron_predictivo_id: { type: String, ref: 'PatronPredictivo', required: true },
  ingrediente_nombre: { type: String, ref: 'Ingrediente', required: true },
  nombre_receta: { type: String, required: true }
}, { collection: 'meal_preps' }));

// ==========================================
// RUTAS DE LA API RESTful (TODAS CON POST Y GET)
// ==========================================

// 1. Usuarios
app.post('/api/usuarios', async (req, res) => {
  try {
    const { nombre, email, password_hash } = req.body;
    const nuevoUsuario = new Usuario({ _id: nombre, email, password_hash });
    await nuevoUsuario.save();
    res.status(201).json(responseFormat(true, 'Usuario creado exitosamente', nuevoUsuario));
  } catch (error) {
    res.status(500).json(responseFormat(false, error.message, null));
  }
});

app.get('/api/usuarios', async (req, res) => {
  try {
    const usuarios = await Usuario.find();
    res.status(200).json(responseFormat(true, 'Lista de usuarios obtenida', usuarios));
  } catch (error) {
    res.status(500).json(responseFormat(false, error.message, null));
  }
});

// 2. Categorías
app.post('/api/categorias', async (req, res) => {
  try {
    const nuevaCategoria = new Categoria(req.body);
    await nuevaCategoria.save();
    res.status(201).json(responseFormat(true, 'Categoría creada exitosamente', nuevaCategoria));
  } catch (error) {
    res.status(500).json(responseFormat(false, error.message, null));
  }
});

app.get('/api/categorias', async (req, res) => {
  try {
    const categorias = await Categoria.find();
    res.status(200).json(responseFormat(true, 'Lista de categorías obtenida', categorias));
  } catch (error) {
    res.status(500).json(responseFormat(false, error.message, null));
  }
});

// 3. Marcas
app.post('/api/marcas', async (req, res) => {
  try {
    const nuevaMarca = new Marca(req.body);
    await nuevaMarca.save();
    res.status(201).json(responseFormat(true, 'Marca creada exitosamente', nuevaMarca));
  } catch (error) {
    res.status(500).json(responseFormat(false, error.message, null));
  }
});

app.get('/api/marcas', async (req, res) => {
  try {
    const marcas = await Marca.find();
    res.status(200).json(responseFormat(true, 'Lista de marcas obtenida', marcas));
  } catch (error) {
    res.status(500).json(responseFormat(false, error.message, null));
  }
});

// 4. Unidades de Medida
app.post('/api/unidades_medida', async (req, res) => {
  try {
    const nuevaUnidad = new UnidadMedida(req.body);
    await nuevaUnidad.save();
    res.status(201).json(responseFormat(true, 'Unidad de medida creada exitosamente', nuevaUnidad));
  } catch (error) {
    res.status(500).json(responseFormat(false, error.message, null));
  }
});

app.get('/api/unidades_medida', async (req, res) => {
  try {
    const unidades = await UnidadMedida.find();
    res.status(200).json(responseFormat(true, 'Lista de unidades de medida obtenida', unidades));
  } catch (error) {
    res.status(500).json(responseFormat(false, error.message, null));
  }
});

// 5. Productos
app.post('/api/productos', async (req, res) => {
  try {
    const nuevoProducto = new Producto(req.body);
    await nuevoProducto.save();
    res.status(201).json(responseFormat(true, 'Producto creado exitosamente', nuevoProducto));
  } catch (error) {
    res.status(500).json(responseFormat(false, error.message, null));
  }
});

app.get('/api/productos', async (req, res) => {
  try {
    const productos = await Producto.find().populate('marca_nombre').populate('categoria_nombre');
    res.status(200).json(responseFormat(true, 'Lista de productos obtenida', productos));
  } catch (error) {
    res.status(500).json(responseFormat(false, error.message, null));
  }
});

// 6. Inventario (Con Historial Automático)
app.post('/api/inventario', async (req, res) => {
  try {
    const nuevoItem = new Inventario(req.body);
    await nuevoItem.save();

    await HistorialInventario.create({
      inventario_id: nuevoItem._id,
      accion: 'CREADO',
      detalles: `Se agregó el alimento al inventario con estado ${nuevoItem.estado}`
    });

    res.status(201).json(responseFormat(true, 'Alimento agregado al inventario', nuevoItem));
  } catch (error) {
    res.status(500).json(responseFormat(false, error.message, null));
  }
});

app.get('/api/inventario', async (req, res) => {
  try {
    const items = await Inventario.find().lean();
    
    // Buscar manualmente los datos relacionados para evitar el null de Mongoose
    const itemsCompletos = await Promise.all(items.map(async (item) => {
      const usuario = await Usuario.findById(item.user_nombre).lean();
      const producto = await Producto.findById(item.producto_id).lean();
      const unidad = await UnidadMedida.findById(item.unidad_medida_nombre).lean();
      
      let marca = null;
      let categoria = null;
      if (producto) {
        marca = await Marca.findById(producto.marca_nombre).lean();
        categoria = await Categoria.findById(producto.categoria_nombre).lean();
        producto.marca_nombre = marca;
        producto.categoria_nombre = categoria;
      }

      return {
        ...item,
        user_nombre: usuario || item.user_nombre,
        producto_id: producto || item.producto_id,
        unidad_medida_nombre: unidad || item.unidad_medida_nombre
      };
    }));

    res.status(200).json(responseFormat(true, 'Lista de alimentos en inventario', itemsCompletos));
  } catch (error) {
    res.status(500).json(responseFormat(false, error.message, null));
  }
});

app.get('/api/inventario/:itemId', async (req, res) => {
  try {
    const item = await Inventario.findById(req.params.itemId).lean();
    if (!item) {
      return res.status(404).json(responseFormat(false, 'Alimento no encontrado', null));
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
    res.status(500).json(responseFormat(false, error.message, null));
  }
});

app.put('/api/inventario/:itemId', async (req, res) => {
  try {
    const itemActualizado = await Inventario.findByIdAndUpdate(req.params.itemId, req.body, { new: true });
    if (!itemActualizado) {
      return res.status(404).json(responseFormat(false, 'Alimento no encontrado', null));
    }

    await HistorialInventario.create({
      inventario_id: itemActualizado._id,
      accion: 'ACTUALIZADO',
      detalles: `Se actualizó el alimento. Estado: ${itemActualizado.estado}, Cantidad: ${itemActualizado.cantidad}`
    });

    res.status(200).json(responseFormat(true, 'Alimento actualizado exitosamente', itemActualizado));
  } catch (error) {
    res.status(500).json(responseFormat(false, error.message, null));
  }
});

app.delete('/api/inventario/:itemId', async (req, res) => {
  try {
    const itemEliminado = await Inventario.findByIdAndDelete(req.params.itemId);
    if (!itemEliminado) {
      return res.status(404).json(responseFormat(false, 'Alimento no encontrado', null));
    }

    await HistorialInventario.create({
      inventario_id: itemEliminado._id,
      accion: 'ELIMINADO',
      detalles: `Se eliminó físicamente el alimento del inventario`
    });

    res.status(200).json(responseFormat(true, 'Alimento eliminado exitosamente', itemEliminado));
  } catch (error) {
    res.status(500).json(responseFormat(false, error.message, null));
  }
});

// 7. Historial de Inventario
app.get('/api/historial_inventario', async (req, res) => {
  try {
    const historial = await HistorialInventario.find().populate('inventario_id');
    res.status(200).json(responseFormat(true, 'Historial de inventario obtenido exitosamente', historial));
  } catch (error) {
    res.status(500).json(responseFormat(false, error.message, null));
  }
});

// 8. Patrones Predictivos
app.post('/api/patrones_predictivos', async (req, res) => {
  try {
    const nuevoPatron = new PatronPredictivo(req.body);
    await nuevoPatron.save();
    res.status(201).json(responseFormat(true, 'Patrón predictivo creado exitosamente', nuevoPatron));
  } catch (error) {
    res.status(500).json(responseFormat(false, error.message, null));
  }
});

app.get('/api/patrones_predictivos', async (req, res) => {
  try {
    const patrones = await PatronPredictivo.find().populate({ path: 'user_nombre', model: 'Usuario' });
    res.status(200).json(responseFormat(true, 'Patrones predictivos obtenidos', patrones));
  } catch (error) {
    res.status(500).json(responseFormat(false, error.message, null));
  }
});

// 9. Ingredientes
app.post('/api/ingredientes', async (req, res) => {
  try {
    const nuevoIngrediente = new Ingrediente(req.body);
    await nuevoIngrediente.save();
    res.status(201).json(responseFormat(true, 'Ingrediente creado exitosamente', nuevoIngrediente));
  } catch (error) {
    res.status(500).json(responseFormat(false, error.message, null));
  }
});

app.get('/api/ingredientes', async (req, res) => {
  try {
    const ingredientes = await Ingrediente.find();
    res.status(200).json(responseFormat(true, 'Lista de ingredientes obtenida', ingredientes));
  } catch (error) {
    res.status(500).json(responseFormat(false, error.message, null));
  }
});

// 10. Meal Preps
app.post('/api/meal_preps', async (req, res) => {
  try {
    const nuevoMealPrep = new MealPrep(req.body);
    await nuevoMealPrep.save();
    res.status(201).json(responseFormat(true, 'Plan de comidas creado exitosamente', nuevoMealPrep));
  } catch (error) {
    res.status(500).json(responseFormat(false, error.message, null));
  }
});

app.get('/api/meal_preps', async (req, res) => {
  try {
    const mealPreps = await MealPrep.find().lean();
    
    const mealPrepsCompletos = await Promise.all(mealPreps.map(async (prep) => {
      // Buscar el patrón predictivo y poblar su usuario manualmente
      let patron = await PatronPredictivo.findById(prep.patron_predictivo_id).lean();
      if (patron) {
        const usuario = await Usuario.findById(patron.user_nombre).lean();
        patron.user_nombre = usuario || patron.user_nombre;
      }

      // Buscar el ingrediente por su clave natural de texto
      const ingrediente = await Ingrediente.findById(prep.ingrediente_nombre).lean();

      return {
        ...prep,
        patron_predictivo_id: patron || prep.patron_predictivo_id,
        ingrediente_nombre: ingrediente || prep.ingrediente_nombre
      };
    }));

    res.status(200).json(responseFormat(true, 'Lista de planes de comida obtenida', mealPrepsCompletos));
  } catch (error) {
    res.status(500).json(responseFormat(false, error.message, null));
  }
});

// Inicialización del Servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
  console.log(`Documentación interactiva disponible en http://localhost:${PORT}/api-docs`);
});