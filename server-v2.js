require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const Groq = require('groq-sdk');

const RAGEngine = require('./lib/rag');
const DatasetManager = require('./lib/dataset');

const app = express();
const PORT = process.env.PORT || 3001;

/**
 * =====================================
 * KONFIGURASI BOT PER KATEGORI
 * =====================================
 *
 * Contoh .env Adela:
 * BOT_CATEGORY=gelang
 * BOT_OWNER=Adela
 * WA_CLIENT_ID=bot-adela-gelang
 *
 * Contoh .env Ari:
 * BOT_CATEGORY=kalung
 * BOT_OWNER=Ari
 * WA_CLIENT_ID=bot-ari-kalung
 *
 * Contoh .env Fikri:
 * BOT_CATEGORY=cincin
 * BOT_OWNER=Fikri
 * WA_CLIENT_ID=bot-fikri-cincin
 *
 * Contoh .env Anting:
 * BOT_CATEGORY=anting
 * BOT_OWNER=NamaTeman
 * WA_CLIENT_ID=bot-anting
 */

const BOT_CATEGORY = (process.env.BOT_CATEGORY || 'gelang').toLowerCase();
const BOT_OWNER = process.env.BOT_OWNER || 'Admin';

const SHOP_NAME = process.env.SHOP_NAME || 'Bunga Tanjung Gold';
const SHOPEE_LINK = process.env.SHOPEE_LINK || 'https://id.shp.ee/2DUgfdtF';

const PRODUCT_CATEGORIES = ['gelang', 'anting', 'cincin', 'kalung'];

const CATEGORY_LABELS = {
  gelang: 'gelang',
  kalung: 'kalung',
  cincin: 'cincin',
  anting: 'anting'
};

function getCategoryLabel() {
  return CATEGORY_LABELS[BOT_CATEGORY] || BOT_CATEGORY;
}

function getMentionedOtherCategory(message) {
  const lowerMessage = (message || '').toLowerCase();

  return PRODUCT_CATEGORIES.find(category =>
    category !== BOT_CATEGORY && lowerMessage.includes(category)
  );
}

function buildWelcomeMenu() {
  const categoryLabel = getCategoryLabel();

  return (
    `Halo Kak, selamat datang di ${SHOP_NAME}.\n` +
    `Saya asisten toko yang siap membantu Kakak mencari produk ${categoryLabel}.\n\n` +
    `Silakan pilih layanan:\n` +
    `1. Cek produk tersedia\n` +
    `2. Cari produk\n` +
    `3. Lihat detail produk\n` +
    `4. Cari produk berdasarkan harga\n` +
    `5. Bantuan admin\n\n` +
    `Kakak bisa balas dengan angka pilihan, atau langsung tulis kebutuhan Kakak.\n\n` +
    `Untuk pembelian, Kakak bisa langsung melalui Shopee toko kami:\n` +
    `${SHOPEE_LINK}`
  );
}

function normalizeMenuOption(message) {
  const text = (message || '').toLowerCase().trim();
  const categoryLabel = getCategoryLabel();

  if (text === '1') {
    return `Tampilkan produk ${categoryLabel} yang tersedia di dataset. Berikan beberapa pilihan produk dengan nama dan harga jika ada.`;
  }

  if (text === '2') {
    return `Bantu cari produk ${categoryLabel} yang cocok untuk pelanggan berdasarkan dataset. Tanyakan kebutuhan pelanggan jika kata kunci produk belum jelas.`;
  }

  if (text === '3') {
    return `Jelaskan detail produk ${categoryLabel} yang tersedia berdasarkan dataset. Jika nama produk belum disebutkan, minta pelanggan menyebutkan nama produk yang ingin dilihat detailnya.`;
  }

  if (text === '4') {
    return `Bantu cari produk ${categoryLabel} berdasarkan harga. Jika pelanggan belum menyebutkan budget atau rentang harga, minta pelanggan menyebutkan budgetnya.`;
  }

  if (text === '5') {
    return `Berikan bantuan admin untuk pelanggan yang ingin bertanya lebih lanjut tentang produk ${categoryLabel}, pemesanan, atau pembelian melalui Shopee. Sertakan link Shopee toko: ${SHOPEE_LINK}`;
  }

  return message;
}

function isMenuKeyword(message) {
  const text = (message || '').toLowerCase().trim();

  return [
    'halo',
    'hai',
    'hi',
    'hello',
    'menu',
    'mulai',
    'start',
    'bantuan',
    'help',
    'gl',
    'kl',
    'cc',
    'at'
  ].includes(text);
}

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

const ragEngine = new RAGEngine();
const datasetManager = new DatasetManager();

let client = null;
let qrCodeData = null;
let isReady = false;
let isCleaning = false;
let isInitializing = false;

const handledMessageIds = new Set();

/**
 * Menyimpan chat yang sudah pernah disapa.
 * Jadi pesan pertama dari setiap nomor akan langsung dibalas menu.
 */
const greetedChats = new Set();

const knowledgeFile = path.join(__dirname, 'knowledge.json');
const behaviorFile = path.join(__dirname, 'config', 'behavior.json');

if (!fs.existsSync(knowledgeFile)) {
  fs.writeFileSync(
    knowledgeFile,
    JSON.stringify({ keywords: {}, responses: {} }, null, 2)
  );
}

function loadKnowledge() {
  try {
    const data = fs.readFileSync(knowledgeFile, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error loading knowledge:', error);
    return { keywords: {}, responses: {} };
  }
}

function saveKnowledge(data) {
  try {
    fs.writeFileSync(knowledgeFile, JSON.stringify(data, null, 2));
    ragEngine.clearCache();
    return true;
  } catch (error) {
    console.error('Error saving knowledge:', error);
    return false;
  }
}

function loadBehavior() {
  try {
    if (!fs.existsSync(behaviorFile)) return null;

    const content = fs.readFileSync(behaviorFile, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    console.error('Error loading behavior config:', error.message);
    return null;
  }
}

function saveBehavior(obj) {
  try {
    fs.mkdirSync(path.dirname(behaviorFile), { recursive: true });
    fs.writeFileSync(behaviorFile, JSON.stringify(obj, null, 2));
    return true;
  } catch (error) {
    console.error('Error saving behavior config:', error.message);
    return false;
  }
}

async function getAIResponse(message, contextItems = [], behavior = null) {
  try {
    const contextBlock = ragEngine.buildContextBlock(contextItems);
    const categoryLabel = getCategoryLabel();

    if (!behavior) {
      behavior = loadBehavior() || {
        system_instructions:
          `Anda adalah chatbot customer service ${SHOP_NAME}. ` +
          `Anda hanya boleh menjawab berdasarkan konteks dataset yang diberikan. ` +
          `Bot ini hanya melayani kategori ${categoryLabel}. ` +
          `Gunakan sapaan Kak dan gaya bahasa ramah seperti admin toko online.`,
        fallback_response:
          `Mohon maaf Kak, informasi itu belum tersedia untuk kategori ${categoryLabel}.`,
        max_sentences: 3,
        language: 'id'
      };
    }

    if (!contextBlock || contextItems.length === 0) {
      return (
        behavior.fallback_response ||
        `Mohon maaf Kak, informasi itu belum tersedia untuk kategori ${categoryLabel}.`
      );
    }

    const systemParts = [];

    if (behavior.system_instructions) {
      systemParts.push(behavior.system_instructions);
    }

    systemParts.push(
      `Bot ini milik ${BOT_OWNER} dan hanya melayani kategori ${categoryLabel}.`
    );

    systemParts.push(
      `Jawab dengan gaya ramah, sopan, singkat, dan natural seperti admin toko online. Gunakan sapaan "Kak".`
    );

    systemParts.push(
      `Jawab hanya berdasarkan konteks berikut. Jangan mengarang nama produk, harga, stok, bahan, promo, atau detail lain yang tidak ada di konteks.`
    );

    systemParts.push(
      `Jika konteks tidak memadai, jawab: ${behavior.fallback_response}`
    );

    systemParts.push(
      `Jika pelanggan ingin membeli, arahkan ke link Shopee: ${SHOPEE_LINK}`
    );

    systemParts.push(
      `Jawab maksimal ${behavior.max_sentences || 3} kalimat. Bahasa: ${behavior.language || 'id'}.`
    );

    const systemMessage = systemParts.join(' ');
    const userMessage = `Konteks:\n${contextBlock}\n\nPertanyaan: ${message}`;

    const completion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user', content: userMessage }
      ],
      model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
      max_tokens: Number(process.env.GROQ_MAX_TOKENS || 250),
      temperature: 0.1
    });

    return completion.choices[0].message.content;
  } catch (error) {
    console.error('Error getting AI response:', error.message);
    return null;
  }
}

async function startBot() {
  if (isReady || isInitializing) {
    return {
      success: false,
      message: 'Bot sudah berjalan atau sedang dimulai'
    };
  }

  if (isCleaning) {
    return {
      success: false,
      message: 'Bot sedang dihentikan, harap tunggu'
    };
  }

  isInitializing = true;

  try {
    const clientInstance = initializeClient();
    await clientInstance.initialize();

    isInitializing = false;

    return {
      success: true,
      message: 'Bot dimulai, silakan scan QR code'
    };
  } catch (error) {
    isInitializing = false;
    client = null;
    qrCodeData = null;
    isCleaning = false;
    throw error;
  }
}

function initializeClient() {
  if (client) return client;

  client = new Client({
    authStrategy: new LocalAuth({
      clientId: process.env.WA_CLIENT_ID || `whatsapp-bot-${BOT_CATEGORY}`
    }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-web-resources',
        '--disable-sync',
        '--disable-translate',
        '--disable-extensions',
        '--disable-default-apps',
        '--disable-component-extensions-with-background-pages'
      ],
      timeout: 120000
    }
  });

  client.on('qr', qr => {
    console.log('📱 QR Code Generated');
    console.log('\n🔗 Scan QR Code di bawah untuk connect bot:\n');

    qrCodeData = qr;
    qrcode.generate(qr, { small: true });

    console.log('\n');
  });

  client.on('ready', () => {
    console.log('✅ Bot is ready!');
    console.log(`👤 Bot owner: ${BOT_OWNER}`);
    console.log(`🏷️ Kategori bot: ${BOT_CATEGORY}`);

    isReady = true;
    isCleaning = false;
  });

  client.on('authenticated', () => {
    console.log('✅ Client authenticated');
  });

  client.on('disconnected', reason => {
    console.log('❌ Client disconnected:', reason);

    isReady = false;
    client = null;
  });

  const handleIncomingMessage = async (msg, eventName) => {
    try {
      console.log(
        `${eventName} event: from=${msg.from}, fromMe=${msg.fromMe}, body=${JSON.stringify(msg.body)}`
      );

      const messageId =
        msg && msg.id && msg.id._serialized ? msg.id._serialized : null;

      if (messageId) {
        if (handledMessageIds.has(messageId)) {
          console.log('↪ Ignoring duplicate event for same message');
          return;
        }

        handledMessageIds.add(messageId);

        setTimeout(() => {
          handledMessageIds.delete(messageId);
        }, 5 * 60 * 1000);
      }

      if (msg.fromMe) {
        console.log('Ignoring self-sent message to avoid reply loop');
        return;
      }

      const isPersonalChat = msg.from.endsWith('@c.us') || msg.from.endsWith('@lid');
      const isNotStatus = !msg.from.endsWith('@status');

      if (!isPersonalChat || !isNotStatus) {
        console.log(`Ignoring non-personal or status message: from=${msg.from}`);
        return;
      }

      console.log(`Personal Message from ${msg.from}: ${msg.body}`);

      try {
        const chat = await msg.getChat();
        await chat.sendStateTyping();
      } catch (e) {
        console.log('Note: Cannot show typing indicator');
      }

      const chatId = msg.from;
      const incomingText = (msg.body || '').trim();

      /**
       * =====================================
       * PESAN PERTAMA WAJIB TAMPILKAN MENU
       * =====================================
       *
       * Apa pun isi pesan pertama user,
       * bot langsung membalas menu layanan.
       */

      if (!greetedChats.has(chatId)) {
        greetedChats.add(chatId);
        await msg.reply(buildWelcomeMenu());
        console.log('Replied with first-message welcome menu');
        return;
      }

      const knowledge = loadKnowledge();
      const keyword = incomingText.toLowerCase();

      if (knowledge.responses[keyword]) {
        await msg.reply(knowledge.responses[keyword]);
        console.log('Replied with FAQ keyword match');
        return;
      }

      /**
       * Kalau user mengetik halo/menu/start setelah pesan pertama,
       * menu tetap bisa muncul lagi.
       */

      if (isMenuKeyword(incomingText)) {
        await msg.reply(buildWelcomeMenu());
        console.log('Replied with requested welcome menu');
        return;
      }

      /**
       * =====================================
       * FILTER KATEGORI LAIN
       * =====================================
       *
       * Contoh:
       * BOT_CATEGORY=gelang
       * User tanya "ada kalung?"
       * Bot langsung menolak dan mengarahkan ke halaman utama.
       */

      const normalizedMessage = normalizeMenuOption(incomingText);
      const mentionedOtherCategory = getMentionedOtherCategory(normalizedMessage);

      if (mentionedOtherCategory) {
        await msg.reply(
          `Mohon maaf Kak, bot ${BOT_OWNER} hanya melayani kategori ${getCategoryLabel()}. ` +
          `Untuk kategori ${mentionedOtherCategory}, silakan pilih tombol kategori yang sesuai di halaman utama ya.`
        );
        return;
      }

      /**
       * =====================================
       * AMBIL DATASET SESUAI BOT_CATEGORY
       * =====================================
       *
       * BOT_CATEGORY=gelang -> data/gelang.csv
       * BOT_CATEGORY=kalung -> data/kalung.csv
       * BOT_CATEGORY=cincin -> data/cincin.csv
       * BOT_CATEGORY=anting -> data/anting.csv
       *
       * File shopee.csv boleh tetap ada,
       * tapi tidak dipakai untuk bot kategori.
       */

      const categoryDocuments = datasetManager.getDatasetDocuments(BOT_CATEGORY);

      console.log(`📦 Bot owner: ${BOT_OWNER}`);
      console.log(`🏷️ Kategori bot: ${BOT_CATEGORY}`);
      console.log(`📄 Dokumen dataset ditemukan: ${categoryDocuments.length}`);

      if (!categoryDocuments.length) {
        await msg.reply(
          `Mohon maaf Kak, dataset untuk kategori ${getCategoryLabel()} belum ditemukan. ` +
          `Pastikan file data/${BOT_CATEGORY}.csv sudah ada ya.`
        );
        return;
      }

      const contextItems = ragEngine.retrieveContext(
        normalizedMessage,
        categoryDocuments,
        Number(process.env.RAG_TOP_K || 3)
      );

      console.log(`🔍 RAG Retrieved ${contextItems.length} relevant context(s)`);

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('AI response timeout')), 15000)
      );

      try {
        const behavior = loadBehavior();

        const aiResponse = await Promise.race([
          getAIResponse(normalizedMessage, contextItems, behavior),
          timeoutPromise
        ]);

        if (aiResponse) {
          await msg.reply(aiResponse);
          console.log(`Replied with AI response. Contexts: ${contextItems.length}`);
        } else {
          await msg.reply('Maaf Kak, saya belum bisa memahami pesan Kakak. Boleh coba tulis ulang ya.');
        }
      } catch (aiError) {
        console.error('AI Error:', aiError.message);

        await msg.reply(
          'Maaf Kak, terjadi kesalahan saat memproses pesan. Silakan coba lagi ya.'
        );
      }
    } catch (error) {
      console.error('Message handler error:', error.message);
    }
  };

  client.on('message', msg => handleIncomingMessage(msg, 'message'));
  client.on('message_create', msg => handleIncomingMessage(msg, 'message_create'));

  return client;
}

app.get('/api/bot/status', (req, res) => {
  res.json({
    isReady,
    isCleaning,
    isInitializing,
    hasQRCode: qrCodeData ? true : false,
    category: BOT_CATEGORY,
    owner: BOT_OWNER
  });
});

app.post('/api/bot/start', async (req, res) => {
  try {
    const result = await startBot();
    return res.json(result);
  } catch (error) {
    console.error('Error starting bot:', error.message);

    res.status(500).json({
      message: 'Error memulai bot. Pastikan koneksi internet stabil dan coba lagi.',
      success: false
    });
  }
});

app.post('/api/bot/stop', async (req, res) => {
  try {
    if (!client) {
      return res.json({
        message: 'Bot tidak sedang berjalan',
        success: false
      });
    }

    isCleaning = true;
    isReady = false;
    qrCodeData = null;

    const clientToDestroy = client;
    client = null;

    res.json({
      message: 'Bot sudah dihentikan',
      success: true
    });

    setImmediate(async () => {
      try {
        await clientToDestroy.destroy();
      } catch (destroyError) {
        console.error('Error destroying client:', destroyError.message);
      } finally {
        isCleaning = false;
      }
    });
  } catch (error) {
    console.error('Error stopping bot:', error);

    isCleaning = false;

    res.status(500).json({
      message: 'Error menghentikan bot: ' + error.message,
      success: false
    });
  }
});

app.get('/api/bot/qr', (req, res) => {
  if (qrCodeData) {
    res.json({ qr: qrCodeData });
  } else {
    res.json({ qr: null });
  }
});

app.get('/api/datasets', (req, res) => {
  res.json({
    datasets: datasetManager.listDatasets(),
    totalDocuments: datasetManager.getAllDocuments().length,
    activeCategory: BOT_CATEGORY,
    activeCategoryDocuments: datasetManager.getDatasetDocuments(BOT_CATEGORY).length
  });
});

app.get('/api/datasets/:name', (req, res) => {
  const docs = datasetManager.getDatasetDocuments(req.params.name);

  if (docs.length === 0) {
    return res.status(404).json({
      message: 'Dataset tidak ditemukan'
    });
  }

  res.json({ documents: docs });
});

app.post('/api/datasets', (req, res) => {
  try {
    const { name, data } = req.body;

    if (!name || !data) {
      return res.status(400).json({
        message: 'name dan data harus diisi'
      });
    }

    const result = datasetManager.saveDataset(name, data);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      message: 'Error: ' + error.message
    });
  }
});

app.get('/api/knowledge/keywords', (req, res) => {
  const knowledge = loadKnowledge();
  res.json(knowledge);
});

app.post('/api/knowledge/keyword', (req, res) => {
  try {
    const { keyword, response } = req.body;

    if (!keyword || !response) {
      return res.status(400).json({
        message: 'Keyword dan response harus diisi',
        success: false
      });
    }

    const knowledge = loadKnowledge();
    knowledge.responses[keyword.toLowerCase().trim()] = response;

    if (saveKnowledge(knowledge)) {
      res.json({
        message: 'Keyword berhasil disimpan',
        success: true
      });
    } else {
      res.status(500).json({
        message: 'Error menyimpan keyword',
        success: false
      });
    }
  } catch (error) {
    res.status(500).json({
      message: 'Error: ' + error.message,
      success: false
    });
  }
});

app.delete('/api/knowledge/keyword/:keyword', (req, res) => {
  try {
    const keyword = decodeURIComponent(req.params.keyword).toLowerCase();
    const knowledge = loadKnowledge();

    if (knowledge.responses[keyword]) {
      delete knowledge.responses[keyword];

      if (saveKnowledge(knowledge)) {
        res.json({
          message: 'Keyword berhasil dihapus',
          success: true
        });
      } else {
        res.status(500).json({
          message: 'Error menghapus keyword',
          success: false
        });
      }
    } else {
      res.status(404).json({
        message: 'Keyword tidak ditemukan',
        success: false
      });
    }
  } catch (error) {
    res.status(500).json({
      message: 'Error: ' + error.message,
      success: false
    });
  }
});

app.get('/api/behavior', (req, res) => {
  try {
    const behavior = loadBehavior();

    if (!behavior) {
      return res.status(404).json({
        message: 'Behavior config not found'
      });
    }

    res.json(behavior);
  } catch (error) {
    res.status(500).json({
      message: 'Error: ' + error.message
    });
  }
});

app.post('/api/behavior', (req, res) => {
  try {
    const obj = req.body;

    if (!obj || typeof obj !== 'object') {
      return res.status(400).json({
        message: 'Invalid behavior object'
      });
    }

    const saved = saveBehavior(obj);

    if (saved) {
      return res.json({
        message: 'Behavior saved',
        success: true
      });
    }

    res.status(500).json({
      message: 'Error saving behavior',
      success: false
    });
  } catch (error) {
    res.status(500).json({
      message: 'Error: ' + error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
  console.log(`🖥️ Admin Dashboard: http://localhost:${PORT}`);
  console.log(`👤 Bot owner: ${BOT_OWNER}`);
  console.log(`🏷️ Kategori aktif: ${BOT_CATEGORY}`);
  console.log(`🏪 Nama toko: ${SHOP_NAME}`);
  console.log(`🛒 Link Shopee: ${SHOPEE_LINK}`);
  console.log(`📚 Datasets loaded: ${datasetManager.listDatasets().length}`);
  console.log(
    `📄 Dokumen kategori ${BOT_CATEGORY}: ${datasetManager.getDatasetDocuments(BOT_CATEGORY).length}`
  );

  if (process.env.AUTO_START_BOT !== 'false') {
    setTimeout(() => {
      startBot().catch(error => {
        console.error('Error auto-starting bot:', error.message);
      });
    }, 500);
  }
});