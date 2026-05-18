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
const userSession = new Map();

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
    console.error('Error loading knowledge:', error.message);
    return { keywords: {}, responses: {} };
  }
}

function saveKnowledge(data) {
  try {
    fs.writeFileSync(knowledgeFile, JSON.stringify(data, null, 2));
    ragEngine.clearCache();
    return true;
  } catch (error) {
    console.error('Error saving knowledge:', error.message);
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

    if (!behavior) {
      behavior = loadBehavior() || {
        system_instructions:
          'Jawab hanya berdasarkan konteks yang diberikan. Jika tidak ada jawaban, tampilkan fallback.',
        fallback_response:
          'Mohon maaf, informasi tersebut tidak tersedia di data toko kami.',
        max_sentences: 2,
        language: 'id'
      };
    }

    if (!behavior.ignoreContextCheck && (!contextBlock || contextItems.length === 0)) {
      return (
        behavior.fallback_response ||
        'Mohon maaf, informasi tersebut tidak tersedia di data toko kami.'
      );
    }

    const systemParts = [];

    if (behavior.system_instructions) {
      systemParts.push(behavior.system_instructions);
    }

    if (!behavior.ignoreContextCheck) {
      systemParts.push(
        `Jawab hanya menggunakan konteks berikut. Jika konteks tidak memadai, jawab: ${behavior.fallback_response}`
      );
    }

    if (!behavior.ignoreSentenceLimit) {
      systemParts.push(
        `Jawab maksimal ${behavior.max_sentences || 2} kalimat. Bahasa: ${
          behavior.language || 'id'
        }.`
      );
    }

    const systemMessage = systemParts.join(' ');
    const userMessage = `Konteks:\n${contextBlock || 'Informasi produk ada pada instruksi sistem'}\n\nPertanyaan: ${message}`;

    const completion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user', content: userMessage }
      ],
      model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
      max_tokens: Number(process.env.GROQ_MAX_TOKENS || 200),
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
    authStrategy: new LocalAuth({ clientId: 'whatsapp-bot' }),
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

  client.on('qr', (qr) => {
    console.log('QR Code Generated');
    console.log('\nScan QR Code di bawah untuk connect bot:\n');

    qrCodeData = qr;
    qrcode.generate(qr, { small: true });

    console.log('\n');
  });

  client.on('ready', () => {
    console.log('Bot is ready!');
    isReady = true;
    isCleaning = false;
  });

  client.on('authenticated', () => {
    console.log('Client authenticated');
  });

  client.on('disconnected', (reason) => {
    console.log('Client disconnected:', reason);
    isReady = false;
    client = null;
  });

  const handleIncomingMessage = async (msg, eventName) => {
    try {
      console.log(
        `${eventName} event: from=${msg.from}, fromMe=${msg.fromMe}, body=${JSON.stringify(
          msg.body
        )}`
      );

      const messageId =
        msg && msg.id && msg.id._serialized ? msg.id._serialized : null;

      if (messageId) {
        if (handledMessageIds.has(messageId)) {
          console.log('Ignoring duplicate event for same message');
          return;
        }

        handledMessageIds.add(messageId);

        setTimeout(() => {
          handledMessageIds.delete(messageId);
        }, 5 * 60 * 1000);
      }

      if (msg.fromMe) {
        console.log('Ignoring self-sent message');
        return;
      }

      const isPersonalChat =
        msg.from.endsWith('@c.us') || msg.from.endsWith('@lid');

      const isNotStatus = !msg.from.endsWith('@status');

      if (!isPersonalChat || !isNotStatus) {
        console.log('Ignoring non-personal message');
        return;
      }

      console.log(`Personal Message from ${msg.from}: ${msg.body}`);

      try {
        const chat = await msg.getChat();
        await chat.sendStateTyping();
      } catch (e) {
        console.log('Cannot show typing indicator');
      }

      const keyword = msg.body.toLowerCase().trim();
      const senderNumber = msg.from;

      const menuKeywords = ['menu', 'halo', 'hi', 'start', 'mulai', 'hai', 'hello', 'assalamualaikum', 'pagi', 'siang', 'sore', 'malam', 'p', 'test', 'tes'];
      const bantuanMenuKeywords = ['bantuan', 'help', 'bisa apa'];
      const kalungKeywords = ['kl', 'kalung'];
      const gelangKeywords = ['gl', 'gelang'];
      const cincinKeywords = ['cc', 'cincin'];
      const antingKeywords = ['at', 'anting'];

      const isFirstMessage = !userSession.has(senderNumber);
      
      // Match if keyword exactly matches, or if it contains variations of menu
      const isMenuTrigger = menuKeywords.some(word => {
        const regex = new RegExp(`\\b${word}\\b`, 'i');
        return regex.test(keyword);
      }) || keyword === 'p' || /menu|mnu|menunya|minu/i.test(keyword);

      const isBantuanTrigger = bantuanMenuKeywords.some(word => {
        const regex = new RegExp(`\\b${word}\\b`, 'i');
        return regex.test(keyword);
      });

      const isKalung = kalungKeywords.some(word => keyword === word || keyword.startsWith(word + ' '));
      const isGelang = gelangKeywords.some(word => keyword === word || keyword.startsWith(word + ' '));
      const isCincin = cincinKeywords.some(word => keyword === word || keyword.startsWith(word + ' '));
      const isAnting = antingKeywords.some(word => keyword === word || keyword.startsWith(word + ' '));

      if (isBantuanTrigger) {
        await msg.reply(`Halo! Ini yang bisa aku bantu 😊\n\n🛍️ *Produk & Katalog*\n• Lihat daftar produk per kategori\n• Cari produk berdasarkan nama\n• Info harga produk\n\n💡 *Rekomendasi*\n• Rekomendasi produk sesuai budget\n• Rekomendasi produk untuk hadiah\n\n🛒 *Pembelian*\n• Link produk langsung ke Shopee\n• Info cara pesan di Shopee\n\n📦 *Pengiriman & Pesanan*\n• Info estimasi pengiriman\n• Cara cek status pesanan\n\n📞 *Lainnya*\n• Info toko Bunga Tanjung Official Shop\n• Hubungi admin toko\n\n—\nKetik *Menu* untuk lihat kategori produk`);
        return;
      }

      if (isMenuTrigger || (isFirstMessage && !isKalung && !isGelang && !isCincin && !isAnting && !isBantuanTrigger && !/^[1-9][0-9]*$/.test(keyword))) {
        userSession.set(senderNumber, 'menu');
        
        const menuVariations = [
          `Halo Kak! Selamat datang di *Bunga Tanjung Official Shop* 💍✨\nToko perhiasan terpercaya di Shopee!\n\nSilakan pilih kategori produk kami:\n\n💎 *KL* → Kalung\n✨ *GL* → Gelang\n💍 *CC* → Cincin\n👂 *AT* → Anting\n\n*BANTUAN* → Lihat semua yang bisa aku bantu\n\nKami siap melayanimu!`,
          `Hai! Senang bertemu denganmu di *Bunga Tanjung Official Shop* 💍✨\nLagi cari perhiasan apa hari ini kak?\n\nKetik kode di bawah untuk lihat koleksi kami:\n💎 *KL* → Kalung\n✨ *GL* → Gelang\n💍 *CC* → Cincin\n👂 *AT* → Anting\n\nKetik *BANTUAN* kalau butuh panduan ya!`,
          `Selamat datang di *Bunga Tanjung Official Shop*! 💍✨\nPusat perhiasan terlengkap dan terpercaya.\n\nYuk intip koleksi cantik kami:\n💎 *KL* → Kalung\n✨ *GL* → Gelang\n💍 *CC* → Cincin\n👂 *AT* → Anting\n\nAda yang bisa dibantu? Ketik *BANTUAN* ya kak!`,
          `Halo! Selamat datang di *Bunga Tanjung Official Shop* 💍✨\nPerhiasan elegan menantimu!\n\nPilih kategori yang kamu suka yuk:\n💎 *KL* → Kalung\n✨ *GL* → Gelang\n💍 *CC* → Cincin\n👂 *AT* → Anting\n\nKetik *BANTUAN* untuk bantuan lebih lanjut 😊`
        ];
        const randomMenu = menuVariations[Math.floor(Math.random() * menuVariations.length)];
        
        await msg.reply(randomMenu);
        return;
      }

      if (isKalung) {
        userSession.set(senderNumber, 'kalung');
        const listProduk = `1. KALUNG ITALY SANTA DEWASA UNISEX EMAS 17K BUNGA TANJUNG GOLD - Rp 5.056.000\n2. KALUNG SUPER FLAT HOLOGRAM FLOWER EMAS 17K BUNGA TANJUNG GOLD - Rp 13.860.000\n3. KALUNG HERME ROSE GOLD EMAS 17K BUNGA TANJUNG GOLD - Rp 7.809.000\n4. KALUNG HOLLOW LUXURY EMAS 17K BUNGA TANJUNG GOLD - Rp 5.292.000\n5. KALUNG CLOVER ARSIR BUNGA 5 EMAS 17K BUNGA TANJUNG GOLD - Rp 12.852.000\n6. KALUNG SOLENE ETERNA BLOOM SYIFA HADJU EMAS 17K BUNGA TANJUNG GOLD - Rp 10.836.000\n7. KALUNG VAR 42 EMAS 17K BUNGA TANJUNG GOLD - Rp 9.027.850\n8. KALUNG POLOS SERUT RINGAN EMAS 17K BUNGA TANJUNG GOLD - Rp 3.276.000\n9. KALUNG SOLENE NELDJU SYIFA HADJU EMAS 17K BUNGA TANJUNG GOLD - Rp 7.560.000\n10. KALUNG HOLLOW TETES LIE EMAS 17K BUNGA TANJUNG GOLD - Rp 5.796.000`;
        await msg.reply(`Ini dia koleksi *Kalung* kami yang cantik! \n\n${listProduk}\n\n*1-10* → Info lebih lanjut produk \n*Menu* → Kembali ke halaman utama \n*BANTUAN* → Lihat semua fitur `);
        return;
      }

      if (isGelang) {
        userSession.set(senderNumber, 'gelang');
        const listProduk = `1. GELANG TALI PIXIU PI XIU CHARM DRAGON EMAS 23K BUNGA TANJUNG GOLD - Rp 3.850.000\n2. GELANG WILLOW LEAF DAUN EMAS 17K BUNGA TANJUNG GOLD - Rp 6.450.000\n3. GELANG CLASSIC KOREA TWIST SUPER RINGAN EMAS 17K BUNGA TANJUNG GOLD - Rp 2.890.000\n4. GELANG CHARLOTTE GOLD LARGE EMAS 17K BUNGA TANJUNG GOLD - Rp 8.750.000\n5. GELANG HERME BELL EMAS 17K BUNGA TANJUNG GOLD - Rp 5.950.000\n6. GELANG FANIA TWIN LAYER KUPU EMAS 18K BUNGA TANJUNG GOLD - Rp 4.120.000\n7. GELANG CLOVER FLOWER EMAS 17K BUNGA TANJUNG GOLD - Rp 5.340.000\n8. GELANG CHARLOTTE GOLD SUPER RINGAN EMAS 17K BUNGA TANJUNG GOLD - Rp 3.150.000\n9. GELANG LUXURY RINGAN EMAS 17K BUNGA TANJUNG GOLD - Rp 3.680.000\n10. GELANG PAPERCLIP VARIASI EMAS 17K BUNGA TANJUNG GOLD - Rp 4.790.000`;
        await msg.reply(`Ini dia koleksi *Gelang* kami yang elegan! \n\n${listProduk}\n\n*1-10* → Info lebih lanjut produk \n*Menu* → Kembali ke halaman utama \n*BANTUAN* → Lihat semua fitur `);
        return;
      }

      if (isCincin) {
        userSession.set(senderNumber, 'cincin');
        const listProduk = `1. CINCIN NIKAH DAPHNE WEDDING RING EMAS 17K BUNGA TANJUNG GOLD - Rp 4.500.000\n2. CINCIN NIKAH SABINA WEDDING RING EMAS 17K BUNGA TANJUNG GOLD - Rp 4.850.000\n3. CINCIN NIKAH QEELA WEDDING RING EMAS 17K BUNGA TANJUNG GOLD - Rp 4.200.000\n4. CINCIN NIKAH MARETTA WEDDING RING EMAS 17K BUNGA TANJUNG GOLD - Rp 5.100.000\n5. CINCIN NIKAH KEYNA WEDDING RING EMAS 17K BUNGA TANJUNG GOLD - Rp 4.650.000\n6. CINCIN NIKAH FALYN WEDDING RING EMAS 17K BUNGA TANJUNG GOLD - Rp 4.350.000\n7. CINCIN NIKAH LIANA WEDDING RING EMAS 17K BUNGA TANJUNG GOLD - Rp 4.900.000\n8. CINCIN NIKAH RENATA WEDDING RING EMAS 17K BUNGA TANJUNG GOLD - Rp 4.750.000\n9. CINCIN NIKAH CHLOE WEDDING RING EMAS 17K BUNGA TANJUNG GOLD - Rp 5.250.000\n10. CINCIN NIKAH FARRA WEDDING RING EMAS 17K BUNGA TANJUNG GOLD - Rp 4.400.000`;
        await msg.reply(`Ini dia koleksi *Cincin* kami yang memesona! \n\n${listProduk}\n\n*1-10* → Info lebih lanjut produk \n*Menu* → Kembali ke halaman utama \n*BANTUAN* → Lihat semua fitur `);
        return;
      }

      if (isAnting) {
        userSession.set(senderNumber, 'anting');
        const listProduk = `1. ANTING KOLONGAN BAYI BABY EMAS KADAR 17K BUNGA TANJUNG - Rp 1.250.000\n2. ANTING JEPIT BLINK EMAS 17K BUNGA TANJUNG GOLD - Rp 2.450.000\n3. ANTING TINDIK CLOVER LY EMAS 17K BUNGA TANJUNG GOLD - Rp 1.850.000\n4. ANTING TINDIK ATOM SUPER RINGAN ROSE EMAS 17K BUNGA TANJUNG GOLD - Rp 1.450.000\n5. ANTING TINDIK TETES AIR EMAS 17K BUNGA TANJUNG GOLD - Rp 2.150.000\n6. ANTING KLIP KUPU KUPU BLINK B EMAS 17K BUNGA TANJUNG GOLD - Rp 2.850.000\n7. ANTING TINDIK KIPAS BS EMAS 17K BUNGA TANJUNG GOLD - Rp 1.950.000\n8. ANTING KLIP FLOWER C EMAS 17K BUNGA TANJUNG GOLD - Rp 2.650.000\n9. ANTING KLIP LISTRING E EMAS 17K BUNGA TANJUNG GOLD - Rp 2.300.000\n10. ANTING KLIP CLOVER A EMAS 17K BUNGA TANJUNG GOLD - Rp 2.750.000`;
        await msg.reply(`Ini dia koleksi *Anting* kami yang menawan! \n\n${listProduk}\n\n*1-10* → Info lebih lanjut produk \n*Menu* → Kembali ke halaman utama \n*BANTUAN* → Lihat semua fitur `);
        return;
      }

      // Old greetings logic commented out to prevent conflict with menuKeywords
      /*
      const greetings = [
        'halo',
        'hai',
        'hello',
        'hi',
        'assalamualaikum',
        'pagi',
        'siang',
        'sore',
        'malam'
      ];
      */

      const tokoKeywords = [
        'nama toko',
        'toko apa',
        'ini toko apa',
        'siapa nama toko',
        'tokonya apa'
      ];

      const lokasiKeywords = [
        'lokasi',
        'alamat',
        'dimana toko',
        'toko dimana',
        'lokasi toko',
        'alamat toko'
      ];

      const bantuanKeywords = [
        'bisa bantu',
        'mau tanya',
        'bantuan',
        'tolong',
        'admin',
        'cs',
        'customer service'
      ];

      const produkKeywords = [
        'produk apa saja',
        'jual apa',
        'ada produk apa',
        'barang apa saja',
        'kategori produk',
        'produk yang dijual',
        'menjual apa'
      ];

      const diskonKeywords = [
        'diskon',
        'promo',
        'potongan harga',
        'sale',
        'gratis ongkir',
        'voucher'
      ];

      const pembayaranKeywords = [
        'pembayaran',
        'bayar',
        'transfer',
        'cod',
        'cash on delivery',
        'qris',
        'dana',
        'ovo',
        'gopay',
        'shopeepay',
        'metode pembayaran'
      ];

      const pengirimanKeywords = [
        'pengiriman',
        'ongkir',
        'kurir',
        'dikirim',
        'estimasi',
        'berapa hari',
        'jasa kirim'
      ];

      const stokKeywords = [
        'stok',
        'tersedia',
        'ready',
        'masih ada',
        'habis'
      ];

      const outsideKeywords = [
        'politik',
        'presiden',
        'matematika',
        'coding',
        'program',
        'berita',
        'sekolah',
        'tugas',
        'game',
        'film',
        'lagu',
        'resep',
        'cuaca'
      ];

      // Old greetings response commented out
      /*
      if (greetings.some((word) => keyword.includes(word))) {
        await msg.reply(
          'Halo, selamat datang di Bunga Tanjung Official Shop. Saya bisa bantu informasi seputar produk perhiasan seperti kalung, harga, dan detail produk.'
        );
        return;
      }
      */

      if (tokoKeywords.some((word) => {
        const regex = new RegExp(`\\b${word}\\b`, 'i');
        return regex.test(keyword);
      })) {
        await msg.reply(
          'Nama toko kami adalah Bunga Tanjung Official Shop, toko perhiasan yang menyediakan produk seperti kalung, gelang, cincin, dan anting.'
        );
        return;
      }

      if (lokasiKeywords.some((word) => keyword.includes(word))) {
        await msg.reply(
          'Toko Bunga Tanjung Official Shop berlokasi di Denpasar, Bali.'
        );
        return;
      }

      if (bantuanKeywords.some((word) => keyword.includes(word))) {
        await msg.reply(
          'Tentu, saya bisa bantu. Silakan tanyakan produk perhiasan seperti kalung, harga produk, detail produk, pembayaran, pengiriman, atau promo toko kami.'
        );
        return;
      }

      if (produkKeywords.some((word) => keyword.includes(word))) {
        await msg.reply(
          'Toko Bunga Tanjung Official Shop menjual produk perhiasan seperti kalung, gelang, cincin, anting, dan perhiasan anak-anak. Untuk dataset saat ini, produk yang tersedia adalah kategori kalung.'
        );
        return;
      }

      if (diskonKeywords.some((word) => keyword.includes(word))) {
        await msg.reply(
          'Untuk informasi diskon atau promo, silakan cek langsung di halaman Shopee Bunga Tanjung Official Shop karena promo dapat berubah sewaktu-waktu.'
        );
        return;
      }

      if (pembayaranKeywords.some((word) => keyword.includes(word))) {
        await msg.reply(
          'Pembayaran dapat mengikuti metode yang tersedia di Shopee, seperti ShopeePay, transfer bank, COD jika tersedia, kartu debit/kredit, dan metode pembayaran lain yang muncul saat checkout.'
        );
        return;
      }

      if (pengirimanKeywords.some((word) => keyword.includes(word))) {
        await msg.reply(
          'Pengiriman mengikuti pilihan kurir yang tersedia di Shopee. Estimasi pengiriman dan ongkir dapat dilihat saat checkout sesuai alamat pembeli.'
        );
        return;
      }

      if (stokKeywords.some((word) => keyword.includes(word))) {
        await msg.reply(
          'Untuk stok produk, silakan sebutkan nama produk yang ingin dicek. Saya akan membantu mencocokkan dengan data produk yang tersedia.'
        );
        return;
      }

      if (outsideKeywords.some((word) => keyword.includes(word))) {
        await msg.reply(
          'Mohon maaf, saya hanya dapat membantu pertanyaan seputar produk dan informasi toko Bunga Tanjung Official Shop.'
        );
        return;
      }

      const knowledge = loadKnowledge();

      if (knowledge.responses[keyword]) {
        await msg.reply(knowledge.responses[keyword]);
        console.log('Replied with FAQ keyword match');
        return;
      }

      const allDocuments = datasetManager.getAllDocuments();

      const contextItems = ragEngine.retrieveContext(
        msg.body,
        allDocuments,
        Number(process.env.RAG_TOP_K || 3)
      );

      console.log(
        `RAG Retrieved ${contextItems.length} relevant context(s)`
      );

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('AI response timeout')), 15000)
      );

      try {
        const behavior = loadBehavior() || { system_instructions: '' };
        let customBehavior = { ...behavior };
        
        const ruleText = `Aturan:\n- Jika pelanggan ketik angka 1–10, tampilkan detail produk sesuai nomor tersebut\n- Jika pelanggan tanya budget tertentu, rekomendasikan produk yang sesuai\n- Jika pelanggan ingin beli, arahkan ke link Shopee produk tersebut\n- ANGKA BUKAN PILIHAN KATEGORI, angka = nomor produk di daftar ini\n- PENTING: Jika pelanggan mengirim pesan yang TIDAK jelas, sekadar sapaan santai, atau di luar konteks produk, JANGAN MENGARANG JAWABAN. Cukup balas persis dengan kalimat ini: "Mohon maaf, saat ini saya hanya melayani pertanyaan seputar produk Bunga Tanjung. Ketik *Menu* untuk kembali ke halaman utama."\n\nTampilkan informasi lengkap produk yang dipilih pelanggan berdasarkan nomornya.\n\nFormat balasan:\n———————————————\n🛍️ *[NAMA PRODUK]*\n\n💰 Harga: Rp [HARGA]\n🏷️ Kategori: [KATEGORI]\n📝 Deskripsi: [DESKRIPSI PRODUK]\n\n🛒 Beli sekarang di Shopee:\n[LINK PRODUK]\n———————————————\nKetik *Menu* untuk kembali 🏠\nKetik kode kategori untuk lihat produk lain 🔠`;

        const currentCategory = userSession.get(senderNumber);
        
        if (currentCategory) {
          customBehavior.ignoreContextCheck = true;
          customBehavior.ignoreSentenceLimit = true;
        }

        if (currentCategory === 'kalung') {
          customBehavior.system_instructions = `Kamu adalah asisten produk kategori KALUNG di Bunga Tanjung Official Shop.\n\nData produk kalung yang tersedia:\n1. KALUNG ITALY SANTA DEWASA UNISEX EMAS 17K BUNGA TANJUNG GOLD - Rp 5.056.000 - https://shopee.co.id/KALUNG-ITALY-SANTA-DEWASA-UNISEX-EMAS-17K-BUNGA-TANJUNG-GOLD-i.48895190.12907109035\n2. KALUNG SUPER FLAT HOLOGRAM FLOWER EMAS 17K BUNGA TANJUNG GOLD - Rp 13.860.000 - https://shopee.co.id/KALUNG-SUPER-FLAT-HOLOGRAM-FLOWER-EMAS-17K-BUNGA-TANJUNG-GOLD-i.48895190.41375778931\n3. KALUNG HERME ROSE GOLD EMAS 17K BUNGA TANJUNG GOLD - Rp 7.809.000 - https://shopee.co.id/KALUNG-HERME-ROSE-GOLD-EMAS-17K-BUNGA-TANJUNG-GOLD-i.48895190.10189979051\n4. KALUNG HOLLOW LUXURY EMAS 17K BUNGA TANJUNG GOLD - Rp 5.292.000 - https://shopee.co.id/KALUNG-HOLLOW-LUXURY-EMAS-17K-BUNGA-TANJUNG-GOLD-i.48895190.41410520579\n5. KALUNG CLOVER ARSIR BUNGA 5 EMAS 17K BUNGA TANJUNG GOLD - Rp 12.852.000 - https://shopee.co.id/KALUNG-CLOVER-ARSIR-BUNGA-5-EMAS-17K-BUNGA-TANJUNG-GOLD-i.48895190.27808251560\n6. KALUNG SOLENE ETERNA BLOOM SYIFA HADJU EMAS 17K BUNGA TANJUNG GOLD - Rp 10.836.000 - https://shopee.co.id/KALUNG-SOLENE-ETERNA-BLOOM-SYIFA-HADJU-EMAS-17K-BUNGA-TANJUNG-GOLD-i.48895190.42980436422\n7. KALUNG VAR 42 EMAS 17K BUNGA TANJUNG GOLD - Rp 9.027.850 - https://shopee.co.id/KALUNG-VAR-42-EMAS-17K-BUNGA-TANJUNG-GOLD-i.48895190.28080584329\n8. KALUNG POLOS SERUT RINGAN EMAS 17K BUNGA TANJUNG GOLD - Rp 3.276.000 - https://shopee.co.id/KALUNG-POLOS-SERUT-RINGAN-EMAS-17K-BUNGA-TANJUNG-GOLD-i.48895190.16869984451\n9. KALUNG SOLENE NELDJU SYIFA HADJU EMAS 17K BUNGA TANJUNG GOLD - Rp 7.560.000 - https://shopee.co.id/KALUNG-SOLENE-NELDJU-SYIFA-HADJU-EMAS-17K-BUNGA-TANJUNG-GOLD-i.48895190.57459608612\n10. KALUNG HOLLOW TETES LIE EMAS 17K BUNGA TANJUNG GOLD - Rp 5.796.000 - https://shopee.co.id/KALUNG-HOLLOW-TETES-LIE-EMAS-17K-BUNGA-TANJUNG-GOLD-i.48895190.51309756294\n\n${ruleText}`;
        } else if (currentCategory === 'gelang') {
          customBehavior.system_instructions = `Kamu adalah asisten produk kategori GELANG di Bunga Tanjung Official Shop.\n\nData produk gelang yang tersedia:\n1. GELANG TALI PIXIU PI XIU CHARM DRAGON EMAS 23K BUNGA TANJUNG GOLD - Rp 3.850.000 - https://shopee.co.id/GELANG-TALI-PIXIU-PI-XIU-CHARM-DRAGON-EMAS-23K-BUNGA-TANJUNG-GOLD-i.48895190.14100954145\n2. GELANG WILLOW LEAF DAUN EMAS 17K BUNGA TANJUNG GOLD - Rp 6.450.000 - https://shopee.co.id/GELANG-WILLOW-LEAF-DAUN-EMAS-17K-BUNGA-TANJUNG-GOLD-i.48895190.26380245317\n3. GELANG CLASSIC KOREA TWIST SUPER RINGAN EMAS 17K BUNGA TANJUNG GOLD - Rp 2.890.000 - https://shopee.co.id/GELANG-CLASSIC-KOREA-TWIST-SUPER-RINGAN-EMAS-17K-BUNGA-TANJUNG-GOLD-i.48895190.24691751226\n4. GELANG CHARLOTTE GOLD LARGE EMAS 17K BUNGA TANJUNG GOLD - Rp 8.750.000 - https://shopee.co.id/GELANG-CHARLOTTE-GOLD-LARGE-EMAS-17K-BUNGA-TANJUNG-GOLD-i.48895190.14371428306\n5. GELANG HERME BELL EMAS 17K BUNGA TANJUNG GOLD - Rp 5.950.000 - https://shopee.co.id/GELANG-HERME-BELL-EMAS-17K-BUNGA-TANJUNG-GOLD-i.48895190.17000780680\n6. GELANG FANIA TWIN LAYER KUPU EMAS 18K BUNGA TANJUNG GOLD - Rp 4.120.000 - https://shopee.co.id/GELANG-FANIA-TWIN-LAYER-KUPU-EMAS-18K-BUNGA-TANJUNG-GOLD-i.48895190.45410494905\n7. GELANG CLOVER FLOWER EMAS 17K BUNGA TANJUNG GOLD - Rp 5.340.000 - https://shopee.co.id/GELANG-CLOVER-FLOWER-EMAS-17K-BUNGA-TANJUNG-GOLD-i.48895190.22039932427\n8. GELANG CHARLOTTE GOLD SUPER RINGAN EMAS 17K BUNGA TANJUNG GOLD - Rp 3.150.000 - https://shopee.co.id/GELANG-CHARLOTTE-GOLD-SUPER-RINGAN-EMAS-17K-BUNGA-TANJUNG-GOLD-i.48895190.28682898388\n9. GELANG LUXURY RINGAN EMAS 17K BUNGA TANJUNG GOLD - Rp 3.680.000 - https://shopee.co.id/GELANG-LUXURY-RINGAN-EMAS-17K-BUNGA-TANJUNG-GOLD-i.48895190.23068676071\n10. GELANG PAPERCLIP VARIASI EMAS 17K BUNGA TANJUNG GOLD - Rp 4.790.000 - https://shopee.co.id/GELANG-PAPERCLIP-VARIASI-EMAS-17K-BUNGA-TANJUNG-GOLD-i.48895190.17625874784\n\n${ruleText}`;
        } else if (currentCategory === 'cincin') {
          customBehavior.system_instructions = `Kamu adalah asisten produk kategori CINCIN di Bunga Tanjung Official Shop.\n\nData produk cincin yang tersedia:\n1. CINCIN NIKAH DAPHNE WEDDING RING EMAS 17K BUNGA TANJUNG GOLD - Rp 4.500.000 - https://shopee.co.id/CINCIN-NIKAH-DAPHNE-WEDDING-RING-EMAS-17K-BUNGA-TANJUNG-GOLD-i.48895190.20182095735\n2. CINCIN NIKAH SABINA WEDDING RING EMAS 17K BUNGA TANJUNG GOLD - Rp 4.850.000 - https://shopee.co.id/CINCIN-NIKAH-SABINA-WEDDING-RING-EMAS-17K-BUNGA-TANJUNG-GOLD-i.48895190.29844774891\n3. CINCIN NIKAH QEELA WEDDING RING EMAS 17K BUNGA TANJUNG GOLD - Rp 4.200.000 - https://shopee.co.id/CINCIN-NIKAH-QEELA-WEDDING-RING-EMAS-17K-BUNGA-TANJUNG-GOLD-i.48895190.54309979785\n4. CINCIN NIKAH MARETTA WEDDING RING EMAS 17K BUNGA TANJUNG GOLD - Rp 5.100.000 - https://shopee.co.id/CINCIN-NIKAH-MARETTA-WEDDING-RING-EMAS-17K-BUNGA-TANJUNG-GOLD-i.48895190.28676038237\n5. CINCIN NIKAH KEYNA WEDDING RING EMAS 17K BUNGA TANJUNG GOLD - Rp 4.650.000 - https://shopee.co.id/CINCIN-NIKAH-KEYNA-WEDDING-RING-EMAS-17K-BUNGA-TANJUNG-GOLD-i.48895190.22852625776\n6. CINCIN NIKAH FALYN WEDDING RING EMAS 17K BUNGA TANJUNG GOLD - Rp 4.350.000 - https://shopee.co.id/CINCIN-NIKAH-FALYN-WEDDING-RING-EMAS-17K-BUNGA-TANJUNG-GOLD-i.48895190.16895554931\n7. CINCIN NIKAH LIANA WEDDING RING EMAS 17K BUNGA TANJUNG GOLD - Rp 4.900.000 - https://shopee.co.id/CINCIN-NIKAH-LIANA-WEDDING-RING-EMAS-17K-BUNGA-TANJUNG-GOLD-i.48895190.22746439452\n8. CINCIN NIKAH RENATA WEDDING RING EMAS 17K BUNGA TANJUNG GOLD - Rp 4.750.000 - https://shopee.co.id/CINCIN-NIKAH-RENATA-WEDDING-RING-EMAS-17K-BUNGA-TANJUNG-GOLD-i.48895190.28179816101\n9. CINCIN NIKAH CHLOE WEDDING RING EMAS 17K BUNGA TANJUNG GOLD - Rp 5.250.000 - https://shopee.co.id/CINCIN-NIKAH-CHLOE-WEDDING-RING-EMAS-17K-BUNGA-TANJUNG-GOLD-i.48895190.16792327862\n10. CINCIN NIKAH FARRA WEDDING RING EMAS 17K BUNGA TANJUNG GOLD - Rp 4.400.000 - https://shopee.co.id/CINCIN-NIKAH-FARRA-WEDDING-RING-EMAS-17K-BUNGA-TANJUNG-GOLD-i.48895190.24126805720\n\n${ruleText}`;
        } else if (currentCategory === 'anting') {
          customBehavior.system_instructions = `Kamu adalah asisten produk kategori ANTING di Bunga Tanjung Official Shop.\n\nData produk anting yang tersedia:\n1. ANTING KOLONGAN BAYI BABY EMAS KADAR 17K BUNGA TANJUNG - Rp 1.250.000 - https://shopee.co.id/ANTING-KOLONGAN-BAYI-BABY-EMAS-KADAR-17K-BUNGA-TANJUNG-i.48895190.22329430632\n2. ANTING JEPIT BLINK EMAS 17K BUNGA TANJUNG GOLD - Rp 2.450.000 - https://shopee.co.id/ANTING-JEPIT-BLINK-EMAS-17K-BUNGA-TANJUNG-GOLD-i.48895190.21057737936\n3. ANTING TINDIK CLOVER LY EMAS 17K BUNGA TANJUNG GOLD - Rp 1.850.000 - https://shopee.co.id/ANTING-TINDIK-CLOVER-LY-EMAS-17K-BUNGA-TANJUNG-GOLD-i.48895190.22559447947\n4. ANTING TINDIK ATOM SUPER RINGAN ROSE EMAS 17K BUNGA TANJUNG GOLD - Rp 1.450.000 - https://shopee.co.id/ANTING-TINDIK-ATOM-SUPER-RINGAN-ROSE-EMAS-17K-BUNGA-TANJUNG-GOLD-i.48895190.55904370292\n5. ANTING TINDIK TETES AIR EMAS 17K BUNGA TANJUNG GOLD - Rp 2.150.000 - https://shopee.co.id/ANTING-TINDIK-TETES-AIR-EMAS-17K-BUNGA-TANJUNG-GOLD-i.48895190.27755932774\n6. ANTING KLIP KUPU KUPU BLINK B EMAS 17K BUNGA TANJUNG GOLD - Rp 2.850.000 - https://shopee.co.id/ANTING-KLIP-KUPU-KUPU-BLINK-B-EMAS-17K-BUNGA-TANJUNG-GOLD-i.48895190.53356754186\n7. ANTING TINDIK KIPAS BS EMAS 17K BUNGA TANJUNG GOLD - Rp 1.950.000 - https://shopee.co.id/ANTING-TINDIK-KIPAS-BS-EMAS-17K-BUNGA-TANJUNG-GOLD-i.48895190.43022899115\n8. ANTING KLIP FLOWER C EMAS 17K BUNGA TANJUNG GOLD - Rp 2.650.000 - https://shopee.co.id/ANTING-KLIP-FLOWER-C-EMAS-17K-BUNGA-TANJUNG-GOLD-i.48895190.27987809894\n9. ANTING KLIP LISTRING E EMAS 17K BUNGA TANJUNG GOLD - Rp 2.300.000 - https://shopee.co.id/ANTING-KLIP-LISTRING-E-EMAS-17K-BUNGA-TANJUNG-GOLD-i.48895190.27837288430\n10. ANTING KLIP CLOVER A EMAS 17K BUNGA TANJUNG GOLD - Rp 2.750.000 - https://shopee.co.id/ANTING-KLIP-CLOVER-A-EMAS-17K-BUNGA-TANJUNG-GOLD-i.48895190.23873730300\n\n${ruleText}`;
        }

        const aiResponse = await Promise.race([
          getAIResponse(msg.body, contextItems, customBehavior),
          timeoutPromise
        ]);

        if (aiResponse) {
          await msg.reply(aiResponse);

          console.log(
            `Replied with AI response (RAG contexts: ${contextItems.length})`
          );
        } else {
          await msg.reply(
            'Maaf, saya tidak memahami pesan Anda. Silakan coba lagi.'
          );
        }
      } catch (aiError) {
        console.error('AI Error:', aiError.message);

        await msg.reply(
          'Maaf, terjadi kesalahan dalam memproses pesan. Silakan coba lagi.'
        );
      }
    } catch (error) {
      console.error('Message handler error:', error.message);
    }
  };

  client.on('message', (msg) => handleIncomingMessage(msg, 'message'));

  client.on('message_create', (msg) =>
    handleIncomingMessage(msg, 'message_create')
  );

  return client;
}

app.get('/api/bot/status', (req, res) => {
  res.json({
    isReady,
    isCleaning,
    isInitializing,
    hasQRCode: qrCodeData ? true : false
  });
});

app.post('/api/bot/start', async (req, res) => {
  try {
    const result = await startBot();
    return res.json(result);
  } catch (error) {
    console.error('Error starting bot:', error.message);

    res.status(500).json({
      message:
        'Error memulai bot. Pastikan koneksi internet stabil dan coba lagi.',
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
    totalDocuments: datasetManager.getAllDocuments().length
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
  console.log(`Server berjalan di http://localhost:${PORT}`);
  console.log(`Admin Dashboard: http://localhost:${PORT}`);
  console.log(`Datasets loaded: ${datasetManager.listDatasets().length}`);

  if (process.env.AUTO_START_BOT !== 'false') {
    setTimeout(() => {
      startBot().catch((error) => {
        console.error('Error auto-starting bot:', error.message);
      });
    }, 500);
  }
});