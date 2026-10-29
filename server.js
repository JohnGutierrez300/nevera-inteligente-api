const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// Redirección automática de la raíz al Swagger para que cargue directo
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
// MODELOS DE MONGOOSE (Estructura en Árbol)
// ==========================================

const Usuario = mongoose.model('Usuario', new mongoose.Schema({
  nombre: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password_hash: { type: String, required: true }
}, { collection: 'usuarios' }));

const Categoria = mongoose.model('Categoria', new mongoose.Schema({
  nombre: { type: String, required: true, unique: true }
}, { collection: 'categorias' }));

const UnidadMedida = mongoose.model('UnidadMedida', new mongoose.Schema({
  nombre: { type: String, required: true },
  abreviatura: { type: String, required: true }
}, { collection: 'unidades_medida' }));

const Marca = mongoose.model('Marca', new mongoose.Schema({
  nombre: { type: String, required: true, unique: true }
}, { collection: 'marcas' }));

const Producto = mongoose.model('Producto', new mongoose.Schema({
  marca_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Marca', required: true },
  categoria_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Categoria', required: true },
  nombre: { type: String, required: true }
}, { collection: 'productos' }));

const Inventario = mongoose.model('Inventario', new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario', required: true },
  producto_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Producto', required: true },
  unidad_medida_id: { type: mongoose.Schema.Types.ObjectId, ref: 'UnidadMedida', required: true },
  cantidad: { type: Number, required: true },
  fecha_vencimiento: { type: Date, default: null },
  estado: { type: String, enum: ['EN_NEVERA', 'CONSUMIDO', 'DESPERDICIADO'], default: 'EN_NEVERA' }
}, { collection: 'inventario' }));

const PatronPredictivo = mongoose.model('PatronPredictivo', new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario', required: true },
  frecuencia_compra_dias: { type: Number },
  probabilidad_desperdicio: { type: Number }
}, { collection: 'patrones_predictivos' }));

const Ingrediente = mongoose.model('Ingrediente', new mongoose.Schema({
  nombre: { type: String, required: true, unique: true }
}, { collection: 'ingredientes' }));

const MealPrep = mongoose.model('MealPrep', new mongoose.Schema({
  patron_predictivo_id: { type: mongoose.Schema.Types.ObjectId, ref: 'PatronPredictivo', required: true },
  ingrediente_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Ingrediente', required: true },
  nombre_receta: { type: String, required: true }
}, { collection: 'meal_preps' }));

// ==========================================
// RUTAS DE LA API RESTful
// ==========================================

// 1. Usuarios
app.post('/api/usuarios', async (req, res) => {
  try {
    const nuevoUsuario = new Usuario(req.body);
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

// 2. Inventario
app.post('/api/inventario', async (req, res) => {
  try {
    const nuevoItem = new Inventario(req.body);
    await nuevoItem.save();
    res.status(201).json(responseFormat(true, 'Alimento agregado al inventario', nuevoItem));
  } catch (error) {
    res.status(500).json(responseFormat(false, error.message, null));
  }
});

app.get('/api/inventario', async (req, res) => {
  try {
    const items = await Inventario.find()
      .populate('user_id', 'nombre email')
      .populate({
        path: 'producto_id',
        populate: ['marca_id', 'categoria_id']
      })
      .populate('unidad_medida_id');
    res.status(200).json(responseFormat(true, 'Lista de alimentos en inventario', items));
  } catch (error) {
    res.status(500).json(responseFormat(false, error.message, null));
  }
});

app.get('/api/inventario/:itemId', async (req, res) => {
  try {
    const item = await Inventario.findById(req.params.itemId)
      .populate('user_id', 'nombre email')
      .populate({
        path: 'producto_id',
        populate: ['marca_id', 'categoria_id']
      })
      .populate('unidad_medida_id');
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
    res.status(200).json(responseFormat(true, 'Alimento eliminado exitosamente', itemEliminado));
  } catch (error) {
    res.status(500).json(responseFormat(false, error.message, null));
  }
});

// 3. Patrones Predictivos
app.get('/api/patrones_predictivos', async (req, res) => {
  try {
    const patrones = await PatronPredictivo.find().populate('user_id', 'nombre email');
    res.status(200).json(responseFormat(true, 'Patrones predictivos obtenidos', patrones));
  } catch (error) {
    res.status(500).json(responseFormat(false, error.message, null));
  }
});

// 4. Meal Preps
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
        populate: { path: 'user_id', select: 'nombre email' }
      })
      .populate('ingrediente_id');
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