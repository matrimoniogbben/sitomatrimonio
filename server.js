import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = path.resolve(process.env.DATA_FILE || "./data/data.json");
const ADMIN_USER = process.env.ADMIN_USER || "";
const ADMIN_PASS = process.env.ADMIN_PASS || "";
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 20);
const SIGNED_URL_EXPIRES_SECONDS = Number(
  process.env.SIGNED_URL_EXPIRES_SECONDS || 3600,
);
const PHOTO_PREVIEW_EXPIRES_SECONDS = Number(
  process.env.PHOTO_PREVIEW_EXPIRES_SECONDS || 3600,
);
const R2_DATA_KEY = process.env.R2_DATA_KEY || "site-data/data.json";
const R2_ENDPOINT =
  process.env.R2_ENDPOINT ||
  `https://${process.env.R2_ACCOUNT_ID || ""}.r2.cloudflarestorage.com`;

function wrapAsync(app) {
  for (const method of ["get", "post", "put", "patch", "delete"]) {
    const original = app[method].bind(app);
    app[method] = (path, ...handlers) =>
      original(
        path,
        ...handlers.map((handler) =>
          handler.length >= 3
            ? handler
            : (req, res, next) =>
                Promise.resolve(handler(req, res, next)).catch(next),
        ),
      );
  }
}

wrapAsync(app);

// CORS configurato per inviare headers correttamente FIN DAL PRIMO HANDSHAKE
// Importante per il Cold Start su Render: gli headers devono essere presenti
// anche nella primissima risposta dopo il risveglio del server
app.use(
  cors({
    origin: (origin, callback) => {
      // Permetti richieste senza Origin header (es. Cron-job.org, curl, health checks, server-to-server)
      if (!origin) {
        return callback(null, true);
      }
      
      // Se CORS_ORIGIN non è impostato o è "*", consenti tutte le origini
      if (!process.env.CORS_ORIGIN || process.env.CORS_ORIGIN === "*") {
        return callback(null, true);
      }
      
      // Altrimenti valida contro la whitelist
      const allowedOrigins = process.env.CORS_ORIGIN.split(",").map(o => o.trim());
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      
      return callback(new Error("CORS origin non autorizzata"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

// Middleware per garantire che gli headers CORS siano sempre presenti
// Anche in caso di errori o risposte premature durante il cold start
app.use((req, res, next) => {
  // Assicurati che gli header CORS siano inviati per tutte le risposte
  const allowedOrigin = req.headers.origin;
  if (allowedOrigin) {
    if (!process.env.CORS_ORIGIN || process.env.CORS_ORIGIN === "*") {
      res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    } else {
      const allowedOrigins = process.env.CORS_ORIGIN.split(",").map(o => o.trim());
      if (allowedOrigins.includes(allowedOrigin)) {
        res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
      }
    }
  }
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  
  // Gestisci preflight requests (OPTIONS) immediatamente
  if (req.method === "OPTIONS") {
    return res.status(204).send();
  }
  
  next();
});

app.set("trust proxy", 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(
  rateLimit({
    windowMs: 60_000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, message: "Troppe richieste. Riprova tra un minuto." },
  }),
);
app.use(express.json({ limit: "1mb" }));
app.use(express.text({ type: "text/plain", limit: "1mb" }));
app.use(
  express.static(path.join(__dirname, "public"), { extensions: ["html"] }),
);

const defaultData = {
  photos: [],
  messages: [],
  quiz: {
    questions: [
      {
        id: crypto.randomUUID(),
        question: "Chi è più probabile che inizi a ballare per primo?",
        answers: ["Gloria", "Beniamino", "Entrambi insieme", "Nessuno dei due"],
        correctIndex: 2,
      },
      {
        id: crypto.randomUUID(),
        question: "Qual è la parola d’ordine della festa?",
        answers: ["Eleganza", "Divertimento", "Silenzio", "Dieta"],
        correctIndex: 1,
      },
      {
        id: crypto.randomUUID(),
        question: "Cosa devono fare gli invitati oggi?",
        answers: [
          "Scappare presto",
          "Scattare foto e divertirsi",
          "Restare seri",
          "Pensare al lavoro",
        ],
        correctIndex: 1,
      },
    ],
    submissions: [],
  },
};

let dataCache = null;
let writeQueue = Promise.resolve();

function hasR2Config() {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      process.env.R2_BUCKET,
  );
}

const s3 = hasR2Config()
  ? new S3Client({
      region: process.env.R2_REGION || "auto",
      endpoint: R2_ENDPOINT,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    })
  : null;

function jsonOk(res, payload = {}) {
  return res.json({ ok: true, ...payload });
}

function jsonError(res, status, message, details = undefined) {
  return res.status(status).json({ ok: false, message, details });
}

function cleanText(value, max = 160) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function timeToMinutes(value) {
  if (!/^\d{2}:\d{2}$/.test(value)) return -1;
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}

function cleanEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .slice(0, 180);
}

function assertAdminCredentialsAreConfigured() {
  return (
    ADMIN_USER &&
    ADMIN_PASS &&
    ADMIN_PASS.length >= 8 &&
    ADMIN_PASS !== "cambia-questa-password"
  );
}

function adminToken() {
  return crypto
    .createHash("sha256")
    .update(
      `gb-admin:${ADMIN_USER}:${ADMIN_PASS}:${process.env.R2_SECRET_ACCESS_KEY || "local-secret"}`,
    )
    .digest("hex");
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function requireAdmin(req, res, next) {
  if (!assertAdminCredentialsAreConfigured()) {
    return jsonError(
      res,
      503,
      "ADMIN_PASS non configurata: imposta una password sicura nel file .env.",
    );
  }

  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!safeEqual(token, adminToken())) {
    return jsonError(res, 401, "Accesso non autorizzato.");
  }

  return next();
}

async function ensureDataFile() {
  await mkdir(path.dirname(DATA_FILE), { recursive: true });
  try {
    await readFile(DATA_FILE, "utf8");
  } catch {
    await writeFile(DATA_FILE, JSON.stringify(defaultData, null, 2), "utf8");
  }
}

function normalizeData(parsed) {
  return {
    photos: Array.isArray(parsed.photos) ? parsed.photos : [],
    messages: Array.isArray(parsed.messages) ? parsed.messages : [],
    quiz: {
      questions: Array.isArray(parsed.quiz?.questions)
        ? parsed.quiz.questions
        : defaultData.quiz.questions,
      submissions: Array.isArray(parsed.quiz?.submissions)
        ? parsed.quiz.submissions
        : [],
    },
  };
}

async function loadLocalData() {
  await ensureDataFile();
  const raw = await readFile(DATA_FILE, "utf8");
  return normalizeData(JSON.parse(raw));
}

async function loadData() {
  if (dataCache) return dataCache;

  if (!s3) {
    dataCache = await loadLocalData();
    return dataCache;
  }

  try {
    const object = await s3.send(
      new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: R2_DATA_KEY }),
    );
    dataCache = normalizeData(JSON.parse(await object.Body.transformToString()));
  } catch (error) {
    if (!isMissingR2ObjectError(error)) throw error;
    // Only a confirmed missing object may be initialized from the local backup.
    dataCache = await loadLocalData();
    await persistData(dataCache);
  }

  return dataCache;
}

function isMissingR2ObjectError(error) {
  return (
    error?.name === "NoSuchKey" ||
    error?.Code === "NoSuchKey" ||
    error?.code === "NoSuchKey"
  );
}

async function persistData(data) {
  data.updatedAt = new Date().toISOString();
  await mkdir(path.dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
  if (s3) {
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: R2_DATA_KEY,
        ContentType: "application/json",
        Body: JSON.stringify(data),
      }),
    );
  }
  dataCache = data;
}

function mutateData(mutator) {
  const run = writeQueue.then(async () => {
    const data = await loadData();
    const result = await mutator(data);
    await persistData(data);
    return result;
  });

  writeQueue = run.catch(() => undefined);
  return run;
}

function requireR2(res) {
  if (!s3) {
    jsonError(
      res,
      503,
      "Cloudflare R2 non è configurato. Compila le variabili R2 nel file .env.",
    );
    return false;
  }
  return true;
}

function fileBaseName(name) {
  return (
    cleanText(name || "foto", 80)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase() || "foto"
  );
}

function publicUrlForKey(key) {
  const base = (process.env.R2_PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  if (!base) return null;
  return `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

async function signedGetUrl(key, downloadName = undefined) {
  if (!s3) return null;

  const command = new GetObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    ...(downloadName
      ? {
          ResponseContentDisposition: `attachment; filename="${downloadName.replace(/"/g, "")}"`,
        }
      : {}),
  });

  return getSignedUrl(s3, command, {
    expiresIn: PHOTO_PREVIEW_EXPIRES_SECONDS,
  });
}

async function decoratePhoto(photo, req = null) {
  const publicUrl = publicUrlForKey(photo.key);
  const url = publicUrl || (await signedGetUrl(photo.key));
  const base = req ? `${req.protocol}://${req.get("host")}` : "";
  return {
    ...photo,
    url,
    downloadUrl: `${base}/api/photos/download?key=${encodeURIComponent(photo.key)}&filename=${encodeURIComponent(
      photo.originalName || "foto-gloria-beniamino.jpg",
    )}`,
  };
}

function leaderboardFromSubmissions(submissions) {
  const byName = new Map();

  for (const item of submissions || []) {
    const key = `${item.name}`.toLowerCase();
    const previous = byName.get(key);

    if (
      !previous ||
      (item.correctAnswers ?? item.score) >
        (previous.correctAnswers ?? previous.score) ||
      ((item.correctAnswers ?? item.score) ===
        (previous.correctAnswers ?? previous.score) &&
        (item.elapsedMs ?? Number.MAX_SAFE_INTEGER) <
          (previous.elapsedMs ?? Number.MAX_SAFE_INTEGER))
    ) {
      byName.set(key, item);
    }
  }

  return Array.from(byName.values())
    .sort((a, b) => {
      const correctDifference =
        (b.correctAnswers ?? b.score) - (a.correctAnswers ?? a.score);
      if (correctDifference !== 0) return correctDifference;
      const timeDifference =
        (a.elapsedMs ?? Number.MAX_SAFE_INTEGER) -
        (b.elapsedMs ?? Number.MAX_SAFE_INTEGER);
      if (timeDifference !== 0) return timeDifference;
      return new Date(a.createdAt) - new Date(b.createdAt);
    })
    .map((item, index) => ({
      id: item.id,
      position: index + 1,
      name: item.name,
      score: item.score,
      correctAnswers: Number.isFinite(item.correctAnswers)
        ? item.correctAnswers
        : item.score,
      total: item.total,
      elapsedMs: Number.isFinite(item.elapsedMs) ? item.elapsedMs : null,
      createdAt: item.createdAt,
    }));
}

function quizParticipantKey(name) {
  return `${cleanText(name, 80)}`
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("it-IT");
}

function hasQuizSubmission(submissions, name) {
  const key = quizParticipantKey(name);
  return Boolean(
    key &&
      (submissions || []).some(
        (item) => quizParticipantKey(item.name) === key,
      ),
  );
}

app.get("/api/health", (req, res) => {
  jsonOk(res, {
    status: "online",
    r2Configured: hasR2Config(),
    adminConfigured: assertAdminCredentialsAreConfigured(),
  });
});

app.post("/api/photos/presign", async (req, res) => {
  if (!requireR2(res)) return;

  const uploaderName = cleanText(req.body.uploaderName, 120);
  const originalName = fileBaseName(req.body.fileName || "foto.webp");
  const size = Number(req.body.size || 0);
  const type = cleanText(req.body.type || "image/webp", 80);

  if (!uploaderName) {
    return jsonError(res, 400, "Inserisci il nome di chi carica la foto.");
  }

  // Accetta WebP, JPEG, PNG, HEIC (il server userà sharp per convertire in WebP)
  const allowedTypes = ["image/webp", "image/jpeg", "image/png", "image/heic"];
  const typeLower = (type || "").toLowerCase();
  if (!allowedTypes.includes(typeLower)) {
    return jsonError(
      res,
      400,
      "Le foto devono essere in formato immagine (WebP, JPEG o PNG). Verranno convertite prima del caricamento.",
    );
  }

  if (!size || size > MAX_UPLOAD_MB * 1024 * 1024) {
    return jsonError(
      res,
      400,
      `La foto supera il limite di ${MAX_UPLOAD_MB}MB.`,
    );
  }

  const key = `photos/${Date.now()}-${crypto.randomUUID()}-${originalName.replace(/\.[^.]+$/, "")}.webp`;

  const command = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    ContentType: "image/webp",
    Metadata: {
      uploader: uploaderName,
      originalname: originalName,
    },
  });

  const uploadUrl = await getSignedUrl(s3, command, {
    expiresIn: SIGNED_URL_EXPIRES_SECONDS,
  });

  return jsonOk(res, {
    key,
    uploadUrl,
    expiresIn: SIGNED_URL_EXPIRES_SECONDS,
  });
});

app.post("/api/photos/confirm", async (req, res) => {
  if (!requireR2(res)) return;

  const key = cleanText(req.body.key, 260);
  const uploaderName = cleanText(req.body.uploaderName, 120);
  const originalName = cleanText(req.body.originalName || "foto.webp", 160);
  const size = Number(req.body.size || 0);

  if (
    !key.startsWith("photos/") ||
    !uploaderName
  ) {
    return jsonError(res, 400, "Dati foto non validi.");
  }

  // Do not persist metadata for a key that was not uploaded through R2.
  try {
    const uploaded = await s3.send(
      new HeadObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
      }),
    );

    const uploadedSize = Number(uploaded.ContentLength || 0);
    if (
      uploaded.ContentType !== "image/webp" ||
      !uploadedSize ||
      uploadedSize > MAX_UPLOAD_MB * 1024 * 1024
    ) {
      return jsonError(
        res,
        400,
        "Il file caricato non è un'immagine WebP valida o supera il limite consentito.",
      );
    }
  } catch {
    return jsonError(
      res,
      400,
      "Foto non trovata su Cloudflare R2. Riprova il caricamento.",
    );
  }

  const saved = await mutateData((data) => {
    const existing = data.photos.find((photo) => photo.key === key);
    if (existing) return existing;

    const photo = {
      id: crypto.randomUUID(),
      key,
      uploaderName,
      originalName,
      size,
      type: "image/webp",
      createdAt: new Date().toISOString(),
    };

    data.photos.unshift(photo);
    return photo;
  });

  return jsonOk(res, { photo: await decoratePhoto(saved, req) });
});

app.get("/api/photos", async (req, res) => {
  try {
    const data = await loadData();
    const limit = Math.min(Math.max(Number(req.query.limit || 5), 1), 200);
    const page = Math.max(Number(req.query.page || 1), 1);
    const search = cleanText(req.query.search || "", 120).toLowerCase();
    const date = cleanText(req.query.date || "", 10);
    const time = cleanText(req.query.time || "", 5);

    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return jsonError(res, 400, "Data filtro non valida.");
    }
    if (time) {
      const t = timeToMinutes(time);
      if (t < 0 || t > 1439) {
        return jsonError(res, 400, "Orario filtro non valido.");
      }
    }

    let filtered = data.photos.filter(
      (photo) =>
        (!search || photo.uploaderName.toLowerCase().includes(search)) &&
        (!date || photo.createdAt?.slice(0, 10) === date),
    );

    if (time) {
      const target = timeToMinutes(time);
      if (target >= 0) {
        filtered = filtered
          .map((photo) => {
            const diff = timeToMinutes(photo.createdAt?.slice(11, 16) || "");
            return { photo, diff: diff >= 0 ? Math.abs(diff - target) : 99999 };
          })
          .sort((a, b) => a.diff - b.diff || (a.photo.createdAt || "").localeCompare(b.photo.createdAt || ""))
          .map((item) => item.photo);
      }
    } else if (!search && !date) {
      for (let i = filtered.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [filtered[i], filtered[j]] = [filtered[j], filtered[i]];
      }
    }
    const offset = (page - 1) * limit;
    const photos = await Promise.all(
      filtered.slice(offset, offset + limit).map((photo) => decoratePhoto(photo, req)),
    );

    return jsonOk(res, { photos, total: filtered.length, page, limit });
  } catch (error) {
    console.error("Errore in GET /api/photos:", error.message);
    // In caso di errore durante il caricamento dati (es. cold start), 
    // restituisci array vuoto invece di errore 500
    return jsonOk(res, { photos: [], total: 0, page: 1, limit: Number(req.query.limit || 5) });
  }
});

app.get("/api/photos/download", async (req, res) => {
  const key = cleanText(req.query.key, 260);
  const requestedName = fileBaseName(
    cleanText(req.query.filename || "foto-gloria-beniamino.jpg", 160),
  );
  const filename = `${requestedName.replace(/\.[^.]+$/, "") || "foto-gloria-beniamino"}.jpg`;

  if (!key.startsWith("photos/")) {
    return jsonError(res, 400, "Chiave foto non valida.");
  }

  if (!requireR2(res)) return;
  const data = await loadData();
  if (!data.photos.some((photo) => photo.key === key)) {
    return jsonError(res, 404, "Foto non trovata.");
  }

  try {
    const object = await s3.send(
      new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }),
    );
    const source = Buffer.from(await object.Body.transformToByteArray());
    const jpeg = await sharp(source, { failOn: "error" })
      .jpeg({ quality: 90, chromaSubsampling: "4:4:4" })
      .toBuffer();
    res.set({
      "Content-Type": "image/jpeg",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(jpeg.length),
    });
    return res.send(jpeg);
  } catch (error) {
    console.error("Photo download conversion failed", error);
    return jsonError(res, 502, "Impossibile convertire la foto in JPEG.");
  }
});

app.post("/api/messages", async (req, res) => {
  const name = cleanText(req.body.name, 120);
  const email = cleanEmail(req.body.email);
  const message = cleanText(req.body.message, 1200);
  const type = req.body.type === "contact" ? "contact" : "guestbook";

  if (!name || !message) {
    return jsonError(res, 400, "Inserisci nome e messaggio.");
  }

  const saved = await mutateData((data) => {
    const item = {
      id: crypto.randomUUID(),
      name,
      email,
      message,
      type,
      read: false,
      createdAt: new Date().toISOString(),
    };

    data.messages.unshift(item);
    return item;
  });

  return jsonOk(res, { message: saved });
});

const QUIZ_OPEN_MS = process.env.QUIZ_OPEN_OVERRIDE
  ? Number(process.env.QUIZ_OPEN_OVERRIDE)
  : Date.UTC(2026, 8, 5) - 2 * 3600 * 1000; // 2026-09-05T00:00:00+02:00

function quizNotYetOpen() {
  return Date.now() < QUIZ_OPEN_MS;
}

function quizLocked(res) {
  return jsonError(
    res,
    403,
    "Il quiz non è ancora disponibile: si aprirà il 5 settembre 2026!",
  );
}

app.get("/api/quiz/questions", async (req, res) => {
  if (quizNotYetOpen()) return quizLocked(res);
  const data = await loadData();

  const questions = data.quiz.questions.map(
    ({ id, intro, question, answers }) => ({
      id,
      intro,
      question,
      answers,
    }),
  );

  return jsonOk(res, { questions });
});

app.get("/api/quiz/participation", async (req, res) => {
  if (quizNotYetOpen()) return quizLocked(res);
  const name = cleanText(req.query.name, 80);
  if (!name) {
    return jsonError(res, 400, "Inserisci nome o nickname per iniziare il quiz.");
  }
  const data = await loadData();
  return jsonOk(res, {
    participated: hasQuizSubmission(data.quiz.submissions, name),
  });
});

app.post("/api/quiz/abandon", async (req, res) => {
  if (quizNotYetOpen()) return quizLocked(res);
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return jsonError(res, 400, "Dati tentativo non validi.");
    }
  }
  const name = cleanText(body?.name, 80);
  if (!name) return jsonOk(res, { recorded: false });

  const saved = await mutateData((data) => {
    if (hasQuizSubmission(data.quiz.submissions, name)) return null;
    const submission = {
      id: crypto.randomUUID(),
      name,
      score: 0,
      correctAnswers: 0,
      total: 0,
      elapsedMs: 7200000,
      createdAt: new Date().toISOString(),
    };
    data.quiz.submissions.push(submission);
    return submission;
  });
  return jsonOk(res, { recorded: Boolean(saved) });
});

app.post("/api/quiz/submit", async (req, res) => {
  if (quizNotYetOpen()) return quizLocked(res);

  const name = cleanText(req.body.name, 80);
  const answers = Array.isArray(req.body.answers) ? req.body.answers : [];
  const clientElapsedMs = Math.min(
    Math.max(Number(req.body.elapsedMs) || 0, 0),
    7_200_000,
  );

  if (!name) {
    return jsonError(res, 400, "Nome o nickname sono obbligatori.");
  }

  // === Validazione server-side elapsedMs con protezione TOCTOU ===
  const quizStart = Number(req.body.quizStartedAt || 0);
  const serverNow = Date.now();
  let elapsedMs = clientElapsedMs;

  // Se il client ha riferito un tempo di inizio, validiamo coerenza server-side
  if (quizStart > 0 && quizStart < serverNow) {
    const serverElapsed = serverNow - quizStart;
    // Usa il valore più basso tra client e server, con tolleranza 30s per clock drift
    if (Math.abs(serverElapsed - clientElapsedMs) > 30000) {
      // Se c'è discrepanza significativa, usiamo il valore server (più affidabile)
      elapsedMs = Math.min(serverElapsed, clientElapsedMs);
    }
  }
  // ===========================================================

  const saved = await mutateData((data) => {
    const alreadyPlayed = hasQuizSubmission(data.quiz.submissions, name);
    if (alreadyPlayed) return null;

    const questions = data.quiz.questions;
    let correctAnswers = 0;

    for (const question of questions) {
      const answer = answers.find((item) => item.questionId === question.id);
      if (
        answer &&
        Number(answer.answerIndex) === Number(question.correctIndex)
      )
        correctAnswers += 1;
    }

    const elapsedSeconds = Math.floor(elapsedMs / 1000);
    const score = correctAnswers * 1000 - elapsedMs / 1000; // Nota: usa elapsedMs già validato

    const submission = {
      id: crypto.randomUUID(),
      name,
      score,
      correctAnswers,
      total: questions.length,
      elapsedMs, // Usa elapsedMs validato
      createdAt: new Date().toISOString(),
    };

    data.quiz.submissions.unshift(submission);
    return submission;
  });

  if (!saved) {
    return jsonError(
      res,
      409,
      "Hai già partecipato al quiz. Chiedi agli sposi se vuoi riprovare.",
    );
  }

  return jsonOk(res, {
    result: {
      score: saved.score,
      correctAnswers: saved.correctAnswers,
      total: saved.total,
      createdAt: saved.createdAt,
    },
  });
});

app.post("/api/admin/login", async (req, res) => {
  if (!assertAdminCredentialsAreConfigured()) {
    return jsonError(
      res,
      503,
      "Configura ADMIN_PASS nel file .env prima di usare l’area riservata.",
    );
  }

  const username = cleanText(req.body.username, 80);
  const password = String(req.body.password || "");
  if (!safeEqual(username, ADMIN_USER) || !safeEqual(password, ADMIN_PASS)) {
    return jsonError(res, 401, "Credenziali non corrette.");
  }

  return jsonOk(res, { token: adminToken() });
});

app.get("/api/admin/dashboard", requireAdmin, async (req, res) => {
  const data = await loadData();
  return jsonOk(res, {
    stats: {
      photos: data.photos.length,
      messages: data.messages.length,
      unreadMessages: data.messages.filter((message) => !message.read).length,
      quizQuestions: data.quiz.questions.length,
      quizSubmissions: data.quiz.submissions.length,
      r2Configured: hasR2Config(),
    },
  });
});

app.get("/api/admin/photos", requireAdmin, async (req, res) => {
  const data = await loadData();
  const photos = await Promise.all(data.photos.map((photo) => decoratePhoto(photo, req)));
  return jsonOk(res, { photos });
});

app.delete("/api/admin/photos", requireAdmin, async (req, res) => {
  const keys = Array.isArray(req.body.keys)
    ? req.body.keys
        .map((key) => cleanText(key, 260))
        .filter((key) => key.startsWith("photos/"))
    : [];

  if (!keys.length) {
    return jsonError(res, 400, "Seleziona almeno una foto da eliminare.");
  }

  if (!s3) {
    return jsonError(res, 503, "Cloudflare R2 non è configurato.");
  }

  const deleted = await s3.send(
    new DeleteObjectsCommand({
      Bucket: process.env.R2_BUCKET,
      Delete: {
        Objects: keys.map((Key) => ({ Key })),
        Quiet: true,
      },
    }),
  );
  const failed = new Set((deleted.Errors || []).map((item) => item.Key));
  const deletedKeys = keys.filter((key) => !failed.has(key));
  if (!deletedKeys.length) {
    return jsonError(res, 502, "Cloudflare R2 non ha eliminato le foto richieste.");
  }

  const remaining = await mutateData((data) => {
    data.photos = data.photos.filter((photo) => !deletedKeys.includes(photo.key));
    return data.photos.length;
  });

  const failedKeys = [...failed];
  if (failedKeys.length) {
    return jsonOk(res, {
      deleted: deletedKeys.length,
      remaining,
      failed: failedKeys.length,
      failedKeys,
      message: `Alcune foto non sono state eliminate da Cloudflare R2: ${failedKeys.join(", ")}.`,
    });
  }

  return jsonOk(res, { deleted: deletedKeys.length, remaining, failed: 0 });
});

app.get("/api/admin/messages", requireAdmin, async (req, res) => {
  const data = await loadData();
  const type =
    req.query.type === "contact"
      ? "contact"
      : req.query.type === "guestbook"
        ? "guestbook"
        : "";
  const messages = type
    ? data.messages.filter((message) => (message.type || "guestbook") === type)
    : data.messages;
  return jsonOk(res, { messages });
});

app.patch("/api/admin/messages/:id/read", requireAdmin, async (req, res) => {
  const id = cleanText(req.params.id, 80);

  const updated = await mutateData((data) => {
    const item = data.messages.find((message) => message.id === id);
    if (!item) return null;
    item.read = Boolean(req.body.read);
    return item;
  });

  if (!updated) return jsonError(res, 404, "Messaggio non trovato.");
  return jsonOk(res, { message: updated });
});

app.delete("/api/admin/messages/:id", requireAdmin, async (req, res) => {
  const id = cleanText(req.params.id, 80);

  const removed = await mutateData((data) => {
    const before = data.messages.length;
    data.messages = data.messages.filter((message) => message.id !== id);
    return before !== data.messages.length;
  });

  if (!removed) return jsonError(res, 404, "Messaggio non trovato.");
  return jsonOk(res, { removed: true });
});

app.get("/api/admin/quiz", requireAdmin, async (req, res) => {
  const data = await loadData();
  return jsonOk(res, {
    questions: data.quiz.questions,
    submissions: data.quiz.submissions,
    leaderboard: leaderboardFromSubmissions(data.quiz.submissions),
  });
});

app.delete(
  "/api/admin/quiz/submissions/:id",
  requireAdmin,
  async (req, res) => {
    const id = cleanText(req.params.id, 80);
    const removed = await mutateData((data) => {
      const before = data.quiz.submissions.length;
      data.quiz.submissions = data.quiz.submissions.filter(
        (submission) => submission.id !== id,
      );
      return before !== data.quiz.submissions.length;
    });

    if (!removed) return jsonError(res, 404, "Partecipante non trovato.");
    return jsonOk(res, { removed: true });
  },
);

app.post("/api/admin/quiz/questions", requireAdmin, async (req, res) => {
  const question = cleanText(req.body.question, 300);
  const answers = Array.isArray(req.body.answers)
    ? req.body.answers
        .map((answer) => cleanText(answer, 160))
        .filter(Boolean)
        .slice(0, 6)
    : [];
  const correctIndex = Number(req.body.correctIndex);

  if (
      !question ||
      answers.length < 2 ||
      !Number.isInteger(correctIndex) ||
      correctIndex < 0 ||
    correctIndex >= answers.length
  ) {
    return jsonError(
      res,
      400,
      "Domanda, almeno due risposte e risposta corretta sono obbligatorie.",
    );
  }

  const saved = await mutateData((data) => {
    const item = {
      id: crypto.randomUUID(),
      question,
      answers,
      correctIndex,
    };

    data.quiz.questions.push(item);
    return item;
  });

  return jsonOk(res, { question: saved });
});

app.put("/api/admin/quiz/questions/order", requireAdmin, async (req, res) => {
  const ids = Array.isArray(req.body.ids)
    ? req.body.ids.map((id) => cleanText(id, 80)).filter(Boolean)
    : [];

  const updated = await mutateData((data) => {
    const knownIds = data.quiz.questions.map((question) => question.id);
    if (
      ids.length !== knownIds.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !knownIds.includes(id))
    ) {
      return null;
    }

    const byId = new Map(data.quiz.questions.map((question) => [question.id, question]));
    data.quiz.questions = ids.map((id) => byId.get(id));
    return data.quiz.questions;
  });

  if (!updated) return jsonError(res, 400, "Ordine delle domande non valido.");
  return jsonOk(res, { questions: updated });
});

app.put("/api/admin/quiz/questions/:id", requireAdmin, async (req, res) => {
  const id = cleanText(req.params.id, 80);
  const question = cleanText(req.body.question, 300);
  const answers = Array.isArray(req.body.answers)
    ? req.body.answers
        .map((answer) => cleanText(answer, 160))
        .filter(Boolean)
        .slice(0, 6)
    : [];
  const correctIndex = Number(req.body.correctIndex);

  if (
      !question ||
      answers.length < 2 ||
      !Number.isInteger(correctIndex) ||
      correctIndex < 0 ||
    correctIndex >= answers.length
  ) {
    return jsonError(
      res,
      400,
      "Domanda, almeno due risposte e risposta corretta sono obbligatorie.",
    );
  }

  const updated = await mutateData((data) => {
    const item = data.quiz.questions.find((entry) => entry.id === id);
    if (!item) return null;

    item.question = question;
    item.answers = answers;
    item.correctIndex = correctIndex;
    return item;
  });

  if (!updated) return jsonError(res, 404, "Domanda non trovata.");
  return jsonOk(res, { question: updated });
});

app.delete("/api/admin/quiz/questions/:id", requireAdmin, async (req, res) => {
  const id = cleanText(req.params.id, 80);

  const removed = await mutateData((data) => {
    const before = data.quiz.questions.length;
    data.quiz.questions = data.quiz.questions.filter(
      (entry) => entry.id !== id,
    );
    return before !== data.quiz.questions.length;
  });

  if (!removed) return jsonError(res, 404, "Domanda non trovata.");
  return jsonOk(res, { removed: true });
});

app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    return jsonError(res, 404, "Endpoint non trovato.");
  }

  return res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((error, req, res, next) => {
  console.error(error);
  const status = error?.status || error?.statusCode || 500;
  const message =
    status === 400 && error?.type === "entity.parse.failed"
      ? "Richiesta non valida."
      : "Errore interno del server.";
  return jsonError(
    res,
    status,
    message,
    process.env.NODE_ENV === "production" ? undefined : error.message,
  );
});

app.listen(PORT, () => {
  console.log(`Gloria & Beniamino wedding server attivo su porta ${PORT}`);
});

process.on("unhandledRejection", (reason) => {
  console.error("[process] Unhandled rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[process] Uncaught exception:", error);
});
