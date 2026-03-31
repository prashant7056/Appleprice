/**
 * ApplePrice.in — Backend API v3
 * Persistent storage: SQLite via better-sqlite3
 *
 * Schema design:
 *   products table  — one row per product family
 *     id            INTEGER PRIMARY KEY AUTOINCREMENT
 *     data          TEXT    — full product JSON (models, prices, reviews etc.)
 *
 *   reviews_seq     — single-row counter for auto-incrementing review IDs
 *     id            INTEGER (always 1)
 *     next_seq      INTEGER
 *
 * All nested structure (models → colors → prices → sellers → coupons → reviews)
 * is stored as JSON inside the `data` column.  This keeps the API contract
 * 100% identical to the previous in-memory version while adding full persistence.
 *
 * Images live on disk:
 *   backend/uploads/products/  ← product / color images
 *   backend/uploads/reviews/   ← review photos
 *
 * Image paths stored in JSON are relative: /uploads/products/foo.jpg
 */

'use strict';

const express      = require('express');
const cors         = require('cors');
const multer       = require('multer');
const path         = require('path');
const fs           = require('fs');
const Database     = require('better-sqlite3');

const app = express();

// ── DIRECTORY SETUP ───────────────────────────────────────────────────────────
const BASE_DIR           = __dirname;
const UPLOADS_DIR        = path.join(BASE_DIR, 'uploads');
const UPLOADS_PRODUCTS   = path.join(UPLOADS_DIR, 'products');
const UPLOADS_REVIEWS    = path.join(UPLOADS_DIR, 'reviews');

[UPLOADS_DIR, UPLOADS_PRODUCTS, UPLOADS_REVIEWS].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(UPLOADS_DIR));   // serves both /uploads/products and /uploads/reviews

// ── MULTER ────────────────────────────────────────────────────────────────────
function makeUpload(subDir) {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, subDir),
    filename:    (req, file, cb) => {
      const ext  = path.extname(file.originalname).toLowerCase() || '.jpg';
      const name = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
      cb(null, name);
    }
  });
  return multer({
    storage,
    limits:     { fileSize: 8 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const ok = /^image\/(jpeg|jpg|png|webp|gif)$/.test(file.mimetype);
      cb(null, ok);
    }
  });
}

const uploadProduct = makeUpload(UPLOADS_PRODUCTS);
const uploadReview  = makeUpload(UPLOADS_REVIEWS);

function handleUpload(uploaderInstance, field) {
  return (req, res, next) => {
    uploaderInstance.single(field)(req, res, err => {
      if (err instanceof multer.MulterError)
        return res.status(400).json({ success: false, message: `Upload error: ${err.message}` });
      if (err)
        return res.status(400).json({ success: false, message: err.message || 'Upload failed' });
      next();
    });
  };
}

// ── SQLITE DATABASE ───────────────────────────────────────────────────────────
const DB_PATH = path.join(BASE_DIR, 'applepricein.db');
const db      = new Database(DB_PATH);

// Enable WAL mode for better write performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    data  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS reviews_seq (
    id       INTEGER PRIMARY KEY CHECK (id = 1),
    next_seq INTEGER NOT NULL DEFAULT 1
  );

  INSERT OR IGNORE INTO reviews_seq (id, next_seq) VALUES (1, 1);
`);

// ── DB HELPERS ────────────────────────────────────────────────────────────────
const stmts = {
  getAllProducts: db.prepare('SELECT id, data FROM products ORDER BY id'),
  getProduct:    db.prepare('SELECT id, data FROM products WHERE id = ?'),
  insertProduct: db.prepare('INSERT INTO products (data) VALUES (?)'),
  updateProduct: db.prepare('UPDATE products SET data = ? WHERE id = ?'),
  deleteProduct: db.prepare('DELETE FROM products WHERE id = ?'),
  getNextReviewSeq: db.prepare('SELECT next_seq FROM reviews_seq WHERE id = 1'),
  bumpReviewSeq:    db.prepare('UPDATE reviews_seq SET next_seq = next_seq + 1 WHERE id = 1'),
};

function rowToProduct(row) {
  const p = JSON.parse(row.data);
  p.id = row.id;
  return p;
}

function getAllProducts() {
  return stmts.getAllProducts.all().map(rowToProduct);
}

function getProductById(id) {
  const row = stmts.getProduct.get(id);
  return row ? rowToProduct(row) : null;
}

function saveProduct(product) {
  const { id, ...data } = product;
  stmts.updateProduct.run(JSON.stringify(data), id);
}

function insertProduct(data) {
  const info = stmts.insertProduct.run(JSON.stringify(data));
  return { id: info.lastInsertRowid, ...data };
}

function deleteProductById(id) {
  stmts.deleteProduct.run(id);
}

function newReviewId() {
  const { next_seq } = stmts.getNextReviewSeq.get();
  stmts.bumpReviewSeq.run();
  return 'R-' + String(next_seq).padStart(6, '0');
}

// ── SEED DATA (only inserted if database is empty) ────────────────────────────
function seedIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) as n FROM products').get().n;
  if (count > 0) return;

  console.log('🌱 Database is empty — inserting demo data…');

  const seed = [
    {
      family:       'iPhone 16 Pro',
      brand:        'Apple',
      category:     'iPhone',
      desc:         'A18 Pro chip, ProRes 4K video, titanium design, Action button.',
      defaultImage: '',
      models: [
        {
          modelId:  'm1',
          name:     '6.3" Standard',
          storages: ['128GB', '256GB', '512GB', '1TB'],
          colors: [
            { colorId: 'c1', name: 'Black Titanium',   hex: '#2c2c2c', image: '' },
            { colorId: 'c2', name: 'White Titanium',   hex: '#f0ede8', image: '' },
            { colorId: 'c3', name: 'Natural Titanium', hex: '#c8b9a0', image: '' },
            { colorId: 'c4', name: 'Desert Titanium',  hex: '#c4a882', image: '' },
          ],
          prices: {
            '128GB::Black Titanium': {
              sellers: [
                { site: 'Apple Store',      price: 119900, score: 9,   link: 'https://www.apple.com/in/shop/buy-iphone/iphone-16-pro', bankOffer: '5% cashback with Apple Card',                       availability: 'available'    },
                { site: 'Amazon.in',        price: 115900, score: 8.5, link: 'https://www.amazon.in/s?k=iphone+16+pro',               bankOffer: '10% instant discount with HDFC card up to ₹5,000', availability: 'available'    },
                { site: 'Flipkart',         price: 114900, score: 8,   link: 'https://www.flipkart.com/search?q=iphone+16+pro',        bankOffer: '',                                                  availability: 'available'    },
                { site: 'Croma',            price: 118900, score: 7.5, link: 'https://www.croma.com/searchB?q=iphone+16+pro',          bankOffer: '',                                                  availability: 'available'    },
                { site: 'Reliance Digital', price: 116900, score: 7,   link: 'https://www.reliancedigital.in/search?q=iphone+16+pro',  bankOffer: '5% off with Reliance One card',                     availability: 'available'    },
                { site: 'Vijay Sales',      price: 115900, score: 7,   link: 'https://www.vijaysales.com/search/iphone-16-pro',        bankOffer: '',                                                  availability: 'out_of_stock' },
              ],
              coupon: { code: 'FLIP500', text: '₹500 off', expiry: '31 Mar 2026', terms: 'On orders above ₹1,00,000' }
            },
            '256GB::Black Titanium': {
              sellers: [
                { site: 'Apple Store',      price: 129900, score: 9,   link: 'https://www.apple.com/in/shop/buy-iphone/iphone-16-pro', bankOffer: '',                                                  availability: 'available'   },
                { site: 'Amazon.in',        price: 125900, score: 8.5, link: 'https://www.amazon.in/s?k=iphone+16+pro+256',            bankOffer: '10% instant discount with HDFC card up to ₹5,000', availability: 'available'   },
                { site: 'Flipkart',         price: 124900, score: 8,   link: 'https://www.flipkart.com/search?q=iphone+16+pro+256',    bankOffer: '',                                                  availability: 'available'   },
                { site: 'Croma',            price: 128900, score: 7.5, link: 'https://www.croma.com/searchB?q=iphone+16+pro',          bankOffer: '',                                                  availability: 'available'   },
                { site: 'Reliance Digital', price: 126900, score: 7,   link: 'https://www.reliancedigital.in/search?q=iphone+16+pro',  bankOffer: '',                                                  availability: 'coming_soon' },
                { site: 'Vijay Sales',      price: 125900, score: 7,   link: 'https://www.vijaysales.com/search/iphone-16-pro',        bankOffer: '',                                                  availability: 'available'   },
              ],
              coupon: null
            }
          }
        },
        {
          modelId:  'm2',
          name:     '6.9" Pro Max',
          storages: ['256GB', '512GB', '1TB'],
          colors: [
            { colorId: 'c1', name: 'Black Titanium',   hex: '#2c2c2c', image: '' },
            { colorId: 'c2', name: 'White Titanium',   hex: '#f0ede8', image: '' },
            { colorId: 'c3', name: 'Natural Titanium', hex: '#c8b9a0', image: '' },
            { colorId: 'c4', name: 'Desert Titanium',  hex: '#c4a882', image: '' },
          ],
          prices: {
            '256GB::Black Titanium': {
              sellers: [
                { site: 'Apple Store',      price: 149900, score: 9,   link: 'https://www.apple.com/in/shop/buy-iphone/iphone-16-pro', bankOffer: '',                                                  availability: 'available'   },
                { site: 'Amazon.in',        price: 144900, score: 8.5, link: 'https://www.amazon.in/s?k=iphone+16+pro+max',            bankOffer: '10% instant discount with HDFC card up to ₹5,000', availability: 'available'   },
                { site: 'Flipkart',         price: 143900, score: 8,   link: 'https://www.flipkart.com/search?q=iphone+16+pro+max',    bankOffer: '',                                                  availability: 'available'   },
                { site: 'Croma',            price: 148900, score: 7.5, link: 'https://www.croma.com/searchB?q=iphone+16+pro+max',      bankOffer: '',                                                  availability: 'unavailable' },
                { site: 'Reliance Digital', price: 146900, score: 7,   link: 'https://www.reliancedigital.in/search?q=iphone+16+pro',  bankOffer: '',                                                  availability: 'available'   },
                { site: 'Vijay Sales',      price: 145900, score: 7,   link: 'https://www.vijaysales.com/search/iphone-16-pro-max',    bankOffer: '',                                                  availability: 'available'   },
              ],
              coupon: null
            }
          }
        }
      ],
      reviews: [
        { reviewId: 'R-000001', author: 'Rahul M.', rating: 5, body: 'Incredible camera and battery life. Best iPhone ever.',  date: '2025-10-15', image: '' },
        { reviewId: 'R-000002', author: 'Priya S.', rating: 4, body: 'Titanium feels premium but heavier than expected.',      date: '2025-11-01', image: '' },
      ]
    },
    {
      family:       'MacBook Air M4',
      brand:        'Apple',
      category:     'Mac',
      desc:         'M4 chip, up to 32GB RAM, 18-hour battery, fanless design.',
      defaultImage: '',
      models: [
        {
          modelId:  'm1',
          name:     '13"',
          storages: ['256GB SSD', '512GB SSD', '1TB SSD'],
          colors: [
            { colorId: 'c1', name: 'Midnight',  hex: '#1a1f2e', image: '' },
            { colorId: 'c2', name: 'Starlight', hex: '#e8e4da', image: '' },
            { colorId: 'c3', name: 'Sky Blue',  hex: '#9db8d2', image: '' },
            { colorId: 'c4', name: 'Silver',    hex: '#c8c8c8', image: '' },
          ],
          prices: {
            '256GB SSD::Midnight': {
              sellers: [
                { site: 'Apple Store',      price: 114900, score: 9,   link: 'https://www.apple.com/in/shop/buy-mac/macbook-air',    bankOffer: '',                             availability: 'available' },
                { site: 'Amazon.in',        price: 109900, score: 8.5, link: 'https://www.amazon.in/s?k=macbook+air+m4',             bankOffer: '10% off with HDFC up to ₹8,000', availability: 'available' },
                { site: 'Flipkart',         price: 108900, score: 8,   link: 'https://www.flipkart.com/search?q=macbook+air+m4',     bankOffer: '',                             availability: 'available' },
                { site: 'Croma',            price: 112900, score: 7.5, link: 'https://www.croma.com/searchB?q=macbook+air+m4',       bankOffer: '',                             availability: 'available' },
                { site: 'Reliance Digital', price: 111900, score: 7,   link: 'https://www.reliancedigital.in/search?q=macbook+air+m4', bankOffer: '',                           availability: 'available' },
                { site: 'Vijay Sales',      price: 110900, score: 7,   link: 'https://www.vijaysales.com/search/macbook-air-m4',     bankOffer: '',                             availability: 'available' },
              ],
              coupon: null
            }
          }
        },
        {
          modelId:  'm2',
          name:     '15"',
          storages: ['256GB SSD', '512GB SSD', '1TB SSD'],
          colors: [
            { colorId: 'c1', name: 'Midnight',  hex: '#1a1f2e', image: '' },
            { colorId: 'c2', name: 'Starlight', hex: '#e8e4da', image: '' },
            { colorId: 'c3', name: 'Sky Blue',  hex: '#9db8d2', image: '' },
            { colorId: 'c4', name: 'Silver',    hex: '#c8c8c8', image: '' },
          ],
          prices: {
            '256GB SSD::Midnight': {
              sellers: [
                { site: 'Apple Store',      price: 134900, score: 9,   link: 'https://www.apple.com/in/shop/buy-mac/macbook-air',    bankOffer: '',                             availability: 'available' },
                { site: 'Amazon.in',        price: 129900, score: 8.5, link: 'https://www.amazon.in/s?k=macbook+air+m4+15',          bankOffer: '10% off with HDFC up to ₹8,000', availability: 'available' },
                { site: 'Flipkart',         price: 128900, score: 8,   link: 'https://www.flipkart.com/search?q=macbook+air+m4+15',  bankOffer: '',                             availability: 'available' },
                { site: 'Croma',            price: 132900, score: 7.5, link: 'https://www.croma.com/searchB?q=macbook+air+15+m4',   bankOffer: '',                             availability: 'available' },
                { site: 'Reliance Digital', price: 130900, score: 7,   link: 'https://www.reliancedigital.in/search?q=macbook+air+m4', bankOffer: '',                           availability: 'available' },
                { site: 'Vijay Sales',      price: 129900, score: 7,   link: 'https://www.vijaysales.com/search/macbook-air-15-m4', bankOffer: '',                             availability: 'available' },
              ],
              coupon: null
            }
          }
        }
      ],
      reviews: []
    }
  ];

  // Insert seed products and set review sequence to 3
  // (R-000001 and R-000002 are used in the seed reviews)
  const insertTx = db.transaction(() => {
    for (const p of seed) {
      stmts.insertProduct.run(JSON.stringify(p));
    }
    db.prepare('UPDATE reviews_seq SET next_seq = 3 WHERE id = 1').run();
  });
  insertTx();

  console.log(`✅ Seeded ${seed.length} demo products`);
}

seedIfEmpty();

// ── BUSINESS LOGIC HELPERS ────────────────────────────────────────────────────
function productSummary(p) {
  let lowestPrice   = Infinity;
  let totalListings = 0;
  for (const model of (p.models || [])) {
    for (const entry of Object.values(model.prices || {})) {
      const sellers = entry.sellers || [];
      totalListings += sellers.length;
      for (const s of sellers) {
        if ((s.availability ?? 'available') !== 'available') continue;
        if (s.price < lowestPrice) lowestPrice = s.price;
      }
    }
  }
  const thumbImage = p.defaultImage || (p.models?.[0]?.colors?.[0]?.image) || '';
  return {
    id:           p.id,
    family:       p.family,
    brand:        p.brand,
    category:     p.category,
    desc:         p.desc,
    thumbImage,
    defaultImage: p.defaultImage || '',
    lowestPrice:  lowestPrice === Infinity ? null : lowestPrice,
    totalListings,
    modelCount:   (p.models || []).length,
    reviewCount:  (p.reviews || []).length,
  };
}

function rankSellers(sellers) {
  const ORDER = { available: 0, out_of_stock: 1, coming_soon: 2, unavailable: 3 };
  return [...sellers]
    .sort((a, b) => {
      const aO = ORDER[a.availability ?? 'available'] ?? 0;
      const bO = ORDER[b.availability ?? 'available'] ?? 0;
      if (aO !== bO) return aO - bO;
      return a.price - b.price;
    })
    .map((s, i) => ({ ...s, rank: i + 1 }));
}

// ── IMAGE UPLOAD ROUTES ───────────────────────────────────────────────────────
// POST /api/upload  → for product images (colors, default image)
app.post('/api/upload', handleUpload(uploadProduct, 'image'), (req, res) => {
  if (!req.file)
    return res.status(400).json({ success: false, message: 'No file received. Field must be "image", JPEG/PNG/WebP/GIF, under 8 MB.' });
  res.json({ success: true, url: `/uploads/products/${req.file.filename}` });
});

// ── PRODUCT ROUTES ────────────────────────────────────────────────────────────

// GET /api/products
app.get('/api/products', (req, res) => {
  const { search, category, sort } = req.query;
  let result = getAllProducts().map(productSummary);

  if (category && category !== 'All')
    result = result.filter(p => p.category === category);

  if (search) {
    const q = search.toLowerCase();
    result = result.filter(p => (p.family + p.brand + p.category + p.desc).toLowerCase().includes(q));
  }

  if (sort === 'price-asc')  result.sort((a, b) => (a.lowestPrice || Infinity) - (b.lowestPrice || Infinity));
  if (sort === 'price-desc') result.sort((a, b) => (b.lowestPrice || 0)        - (a.lowestPrice || 0));
  if (sort === 'name')       result.sort((a, b) => a.family.localeCompare(b.family));

  res.json({ success: true, count: result.length, products: result });
});

// GET /api/products/:id
app.get('/api/products/:id', (req, res) => {
  const p = getProductById(parseInt(req.params.id));
  if (!p) return res.status(404).json({ success: false, message: 'Product not found' });
  res.json({ success: true, product: p });
});

// GET /api/products/:id/prices
app.get('/api/products/:id/prices', (req, res) => {
  const p = getProductById(parseInt(req.params.id));
  if (!p) return res.status(404).json({ success: false, message: 'Product not found' });

  const { model: modelId, storage, color } = req.query;
  if (!modelId || !storage || !color)
    return res.status(400).json({ success: false, message: 'model, storage, and color are required' });

  const model = (p.models || []).find(m => m.modelId === modelId);
  if (!model) return res.status(404).json({ success: false, message: 'Model not found' });

  const key   = `${storage}::${color}`;
  const entry = (model.prices || {})[key];
  if (!entry) return res.json({ success: true, sellers: [], coupon: null, lowestPrice: 0, savings: 0 });

  const ranked    = rankSellers(entry.sellers || []);
  const available = ranked.filter(s => (s.availability ?? 'available') === 'available');
  const lowest    = available.length ? available[0].price : (ranked.length ? ranked[0].price : 0);
  const highest   = available.length ? available[available.length - 1].price : 0;

  res.json({
    success: true,
    sellers:        ranked,
    coupon:         entry.coupon || null,
    lowestPrice:    lowest,
    savings:        highest - lowest,
    allUnavailable: available.length === 0 && ranked.length > 0,
  });
});

// GET /api/categories
app.get('/api/categories', (req, res) => {
  const cats = ['All', ...new Set(getAllProducts().map(p => p.category))];
  res.json({ success: true, categories: cats });
});

// GET /api/stats
app.get('/api/stats', (req, res) => {
  const all = getAllProducts();
  let totalListings = 0, lowestPrice = Infinity, totalSavings = 0;

  for (const p of all) {
    for (const m of (p.models || [])) {
      for (const entry of Object.values(m.prices || {})) {
        const avail  = (entry.sellers || []).filter(s => (s.availability ?? 'available') === 'available');
        const prices = avail.map(s => s.price);
        totalListings += (entry.sellers || []).length;
        if (prices.length) {
          const mn = Math.min(...prices), mx = Math.max(...prices);
          if (mn < lowestPrice) lowestPrice = mn;
          totalSavings += mx - mn;
        }
      }
    }
  }

  res.json({
    success: true,
    stats: {
      totalProducts: all.length,
      totalListings,
      lowestPrice:   lowestPrice === Infinity ? 0 : lowestPrice,
      totalSavings,
      brands:        [...new Set(all.map(p => p.brand))].filter(Boolean).length,
    }
  });
});

// POST /api/products
app.post('/api/products', (req, res) => {
  const { family, brand, category, desc, models, defaultImage } = req.body;
  if (!family || !family.trim())
    return res.status(400).json({ success: false, message: 'Product family name is required' });

  const data = {
    family:       family.trim(),
    brand:        (brand || 'Apple').trim(),
    category:     category || 'Other',
    desc:         (desc || '').trim(),
    defaultImage: defaultImage || '',
    models:       Array.isArray(models) ? models : [],
    reviews:      [],
  };
  const product = insertProduct(data);
  res.status(201).json({ success: true, product });
});

// PUT /api/products/:id
app.put('/api/products/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const existing = getProductById(id);
  if (!existing) return res.status(404).json({ success: false, message: 'Product not found' });

  const { family, brand, category, desc, models, defaultImage } = req.body;
  if (!family || !family.trim())
    return res.status(400).json({ success: false, message: 'Product family name is required' });

  const updated = {
    ...existing,
    id,                                       // keep numeric id
    family:       family.trim(),
    brand:        (brand || 'Apple').trim(),
    category:     category || existing.category,
    desc:         (desc || '').trim(),
    defaultImage: defaultImage !== undefined ? defaultImage : (existing.defaultImage || ''),
    models:       Array.isArray(models) ? models : existing.models,
  };

  saveProduct(updated);
  res.json({ success: true, product: updated });
});

// DELETE /api/products/:id
app.delete('/api/products/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const p  = getProductById(id);
  if (!p) return res.status(404).json({ success: false, message: 'Product not found' });

  deleteProductById(id);
  res.json({ success: true, message: `Deleted "${p.family}"` });
});

// ── REVIEW ROUTES ─────────────────────────────────────────────────────────────

// GET /api/products/:id/reviews
app.get('/api/products/:id/reviews', (req, res) => {
  const p = getProductById(parseInt(req.params.id));
  if (!p) return res.status(404).json({ success: false, message: 'Product not found' });
  res.json({ success: true, reviews: p.reviews || [] });
});

// POST /api/products/:id/reviews
app.post('/api/products/:id/reviews', handleUpload(uploadReview, 'image'), (req, res) => {
  const p = getProductById(parseInt(req.params.id));
  if (!p) return res.status(404).json({ success: false, message: 'Product not found' });

  const { author, rating, body } = req.body;
  if (!author || !body)
    return res.status(400).json({ success: false, message: 'author and body are required' });

  const review = {
    reviewId: newReviewId(),
    author:   author.trim(),
    rating:   Math.min(5, Math.max(1, parseInt(rating) || 5)),
    body:     body.trim(),
    date:     new Date().toISOString().split('T')[0],
    image:    req.file ? `/uploads/reviews/${req.file.filename}` : '',
  };

  if (!p.reviews) p.reviews = [];
  p.reviews.push(review);
  saveProduct(p);

  res.status(201).json({ success: true, review });
});

// GET /api/reviews/search?q=
app.get('/api/reviews/search', (req, res) => {
  const q       = (req.query.q || '').trim().toLowerCase();
  const results = [];

  for (const p of getAllProducts()) {
    for (const r of (p.reviews || [])) {
      if (!q || r.reviewId.toLowerCase().includes(q) || r.author.toLowerCase().includes(q)) {
        results.push({ ...r, productId: p.id, productFamily: p.family });
      }
    }
  }
  res.json({ success: true, results });
});

// DELETE /api/products/:id/reviews/:reviewId
app.delete('/api/products/:id/reviews/:reviewId', (req, res) => {
  const p = getProductById(parseInt(req.params.id));
  if (!p) return res.status(404).json({ success: false, message: 'Product not found' });

  const idx = (p.reviews || []).findIndex(r => r.reviewId === req.params.reviewId);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Review not found' });

  const [deleted] = p.reviews.splice(idx, 1);
  saveProduct(p);

  // Remove image file from disk
  if (deleted.image && deleted.image.startsWith('/uploads/')) {
    const filePath = path.join(UPLOADS_DIR, deleted.image.replace('/uploads/', ''));
    fs.unlink(filePath, () => {});
  }

  res.json({ success: true, message: `Deleted review ${deleted.reviewId}` });
});

// ── GLOBAL ERROR HANDLER (always JSON) ───────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(err.status || 500).json({ success: false, message: err.message || 'Internal server error' });
});

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ ApplePrice.in API  →  http://localhost:${PORT}`);
  console.log(`   Database           →  ${DB_PATH}`);
  console.log(`   Product images     →  ${UPLOADS_PRODUCTS}`);
  console.log(`   Review images      →  ${UPLOADS_REVIEWS}`);
  console.log('');
  console.log('   GET    /api/products');
  console.log('   GET    /api/products/:id');
  console.log('   GET    /api/products/:id/prices?model=&storage=&color=');
  console.log('   POST   /api/products');
  console.log('   PUT    /api/products/:id');
  console.log('   DELETE /api/products/:id');
  console.log('   POST   /api/upload                    ← product images');
  console.log('   POST   /api/products/:id/reviews      ← review images');
  console.log('   GET    /api/reviews/search?q=');
  console.log('   DELETE /api/products/:id/reviews/:reviewId');
});
