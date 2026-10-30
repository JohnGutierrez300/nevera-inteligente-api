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
  _id: { type: String, required: true }, // El nombre actúa como PK natural
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
  _id: { type: String, required: true }, // Tú decides el código (ej. "P-01" o "123")
  marca_nombre: { type: String, ref: 'Marca', required: true },
  categoria_nombre: { type: String, ref: 'Categoria', required: true },
  nombre: { type: String, required: true }
}, { collection: 'productos', _id: false }));

const Inventario = mongoose.model('Inventario', new mongoose.Schema({
  user_nombre: { type: String, ref: 'Usuario', required: true },
  producto_id: { type: String, ref: 'Producto', required: true }, // <--- Cambiado a String para aceptar códigos personalizados
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
  user_nombre: { type: String, ref: 'Usuario', required: true },
  frecuencia_compra_dias: { type: Number },
  probabilidad_desperdicio: { type: Number }
}, { collection: 'patrones_predictivos' }));

const Ingrediente = mongoose.model('Ingrediente', new mongoose.Schema({
  _id: { type: String, required: true }
}, { collection: 'ingredientes', _id: false }));

const MealPrep = mongoose.model('MealPrep', new mongoose.Schema({
  patron_predictivo_id: { type: mongoose.Schema.Types.ObjectId, ref: 'PatronPredictivo', required: true },
  ingrediente_nombre: { type: String, ref: 'Ingrediente', required: true },
  nombre_receta: { type: String, required: true }
}, { collection: 'meal_preps' }));

// ==========================================
// RUTAS DE LA API RESTful
// ==========================================

// 1. Usuarios (Usando nombre como ID/PK)
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

// 2. Inventario (Con Historial Automático)
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
    const items = await Inventario.find()
      .populate('user_nombre')
      .populate({
        path: 'producto_id',
        populate: ['marca_nombre', 'categoria_nombre']
      })
      .populate('unidad_medida_nombre');
    res.status(200).json(responseFormat(true, 'Lista de alimentos en inventario', items));
  } catch (error) {
    res.status(500).json(responseFormat(false, error.message, null));
  }
});

app.get('/api/inventario/:itemId', async (req, res) => {
  try {
    const item = await Inventario.findById(req.params.itemId)
      .populate('user_nombre')
      .populate({
        path: 'producto_id',
        populate: ['marca_nombre', 'categoria_nombre']
      })
      .populate('unidad_medida_nombre');
    if (!item) {
      return res.status(404).json(responseFormat(false, 'Alimento no encontrado', null));
    }
    res.status(200).json(responseFormat(true, 'Detalle del alimento obtenido', item));
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

// 3. Historial de Inventario
app.get('/api/historial_inventario', async (req, res) => {
  try {
    const historial = await HistorialInventario.find().populate('inventario_id');
    res.status(200).json(responseFormat(true, 'Historial de inventario obtenido exitosamente', historial));
  } catch (error) {
    res.status(500).json(responseFormat(false, error.message, null));
  }
});

// 4. Patrones Predictivos
app.get('/api/patrones_predictivos', async (req, res) => {
  try {
    const patrones = await PatronPredictivo.find().populate('user_nombre');
    res.status(200).json(responseFormat(true, 'Patrones predictivos obtenidos', patrones));
  } catch (error) {
    res.status(500).json(responseFormat(false, error.message, null));
  }
});

// 5. Meal Preps
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
    const mealPreps = await MealPrep.find()
      .populate({
        path: 'patron_predictivo_id',
        populate: { path: 'user_nombre' }
      })
      .populate('ingrediente_nombre');
    res.status(200).json(responseFormat(true, 'Lista de planes de comida obtenida', mealPreps));
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