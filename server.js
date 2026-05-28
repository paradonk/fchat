const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const fs = require("fs");
const http = require("http");
const https = require("https");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const mysql = require("mysql2/promise");
const { Server } = require("socket.io");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const MySQLStore = require("express-mysql-session")(session);
const { randomUUID } = require("crypto");

const log = {
  info: (msg, data = {}) =>
    console.log(JSON.stringify({ level: "info", msg, ...data, time: new Date().toISOString() })),
  error: (msg, data = {}) =>
    console.error(JSON.stringify({ level: "error", msg, ...data, time: new Date().toISOString() }))
};

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  console.error("SESSION_SECRET env var is required. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const app = express();
app.set("trust proxy", 1);

const certPath = path.join(__dirname, "localhost+1.pem");
const keyPath = path.join(__dirname, "localhost+1-key.pem");
const useHttps = process.env.NODE_ENV !== "production" && fs.existsSync(certPath) && fs.existsSync(keyPath);
const server = useHttps
  ? https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, app)
  : http.createServer(app);
const PUBLIC_BASE_PATH = (process.env.PUBLIC_BASE_PATH || "/private/fchat").replace(/\/+$/, "");
const socketPath = `${PUBLIC_BASE_PATH || ""}/socket.io`;
const io = new Server(server, {
  path: socketPath,
  transports: ["polling", "websocket"]
});

const PORT = process.env.PORT || 3000;
const SALT_ROUNDS = 10;
const MESSAGE_LIMIT = 100;
const MAX_MESSAGE_LENGTH = 1000;
const MAX_USERNAME_LENGTH = 50;
const MAX_DISPLAY_NAME_LENGTH = 60;
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const MAX_IMAGE_COUNT = 6;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const uploadsDir = path.join(__dirname, "uploads");

fs.mkdirSync(uploadsDir, { recursive: true });

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "family_chat",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

const sessionStore = new MySQLStore({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "family_chat",
  clearExpired: true,
  checkExpirationInterval: 15 * 60 * 1000,
  expiration: 24 * 60 * 60 * 1000,
  createDatabaseTable: true
});

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.SECURE_COOKIES === "true"
  }
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "blob:", "data:"],
      connectSrc: ["'self'", "ws:", "wss:"]
    }
  }
}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again later." }
});

function formatTimestamp(value) {
  return new Date(value).toISOString();
}

function mapMessageRow(row) {
  return {
    id: row.id,
    message_type: row.message_type,
    message: row.message || "",
    image_url: row.image_url || null,
    original_name: row.original_name || null,
    group_id: row.group_id || null,
    created_at: formatTimestamp(row.created_at),
    user: {
      id: row.user_id,
      username: row.username,
      display_name: row.display_name
    }
  };
}

function groupImageMessages(messages) {
  const result = [];
  for (const msg of messages) {
    if (msg.message_type === "image" && msg.group_id) {
      const last = result[result.length - 1];
      if (last && last.message_type === "image_group" && last.group_id === msg.group_id) {
        last.images.push({ id: msg.id, image_url: msg.image_url, original_name: msg.original_name });
        continue;
      }
      result.push({
        message_type: "image_group",
        group_id: msg.group_id,
        images: [{ id: msg.id, image_url: msg.image_url, original_name: msg.original_name }],
        created_at: msg.created_at,
        user: msg.user
      });
    } else {
      result.push(msg);
    }
  }
  return result;
}

async function getRecentMessages() {
  const [rows] = await pool.query(
    `SELECT m.id, m.user_id, m.message_type, m.message, m.image_url, m.original_name, m.group_id,
            m.created_at, u.username, u.display_name
     FROM messages m
     JOIN users u ON u.id = m.user_id
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT ?`,
    [MESSAGE_LIMIT]
  );

  return groupImageMessages(rows.reverse().map(mapMessageRow));
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return next();
}

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => {
    callback(null, uploadsDir);
  },
  filename: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    const safeExtension = extension || ".bin";
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExtension}`;
    callback(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_IMAGE_SIZE },
  fileFilter: (_req, file, callback) => {
    if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
      callback(new Error("Only JPG, PNG, WEBP, and GIF files are allowed."));
      return;
    }
    callback(null, true);
  }
});

async function loadMessageById(messageId) {
  const [rows] = await pool.query(
    `SELECT m.id, m.user_id, m.message_type, m.message, m.image_url, m.original_name, m.group_id,
            m.created_at, u.username, u.display_name
     FROM messages m
     JOIN users u ON u.id = m.user_id
     WHERE m.id = ?
     LIMIT 1`,
    [messageId]
  );

  if (rows.length === 0) return null;
  return mapMessageRow(rows[0]);
}

function deleteUploadedFiles(files) {
  if (!files) return;
  for (const file of files) {
    fs.unlink(file.path, () => {});
  }
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);

const router = express.Router();

function appUrl(pathname) {
  return `${PUBLIC_BASE_PATH}${pathname}`;
}

router.get("/", (req, res) => {
  if (req.session.user) return res.redirect(appUrl("/chat.html"));
  return res.redirect(appUrl("/login.html"));
});

router.get("/login.html", (req, res) => {
  if (req.session.user) return res.redirect(appUrl("/chat.html"));
  return res.sendFile(path.join(__dirname, "public", "login.html"));
});

router.get("/chat.html", (req, res) => {
  if (!req.session.user) return res.redirect(appUrl("/login.html"));
  return res.sendFile(path.join(__dirname, "public", "chat.html"));
});

router.get("/api/session", (req, res) => {
  if (!req.session.user) return res.json({ authenticated: false });
  return res.json({ authenticated: true, user: req.session.user });
});

router.post("/api/register", authLimiter, async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const displayName = String(req.body.display_name || "").trim();

  if (!username || !password || !displayName) {
    return res.status(400).json({ error: "All fields are required." });
  }
  if (username.length > MAX_USERNAME_LENGTH) {
    return res.status(400).json({ error: `Username must be ${MAX_USERNAME_LENGTH} characters or fewer.` });
  }
  if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    return res.status(400).json({ error: `Display name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer.` });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters." });
  }

  try {
    const [existingUsers] = await pool.query(
      "SELECT id FROM users WHERE username = ? LIMIT 1",
      [username]
    );

    if (existingUsers.length > 0) {
      return res.status(409).json({ error: "Username already exists." });
    }

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    const [result] = await pool.query(
      "INSERT INTO users (username, password, display_name) VALUES (?, ?, ?)",
      [username, hashedPassword, displayName]
    );

    req.session.user = { id: result.insertId, username, display_name: displayName };
    return res.status(201).json({ message: "Registration successful.", user: req.session.user });
  } catch (error) {
    log.error("Registration error", { error: error.message });
    return res.status(500).json({ error: "Could not register user." });
  }
});

router.post("/api/login", authLimiter, async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required." });
  }

  try {
    const [rows] = await pool.query(
      "SELECT id, username, password, display_name FROM users WHERE username = ? LIMIT 1",
      [username]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    const user = rows[0];
    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    req.session.user = { id: user.id, username: user.username, display_name: user.display_name };
    return res.json({ message: "Login successful.", user: req.session.user });
  } catch (error) {
    log.error("Login error", { error: error.message });
    return res.status(500).json({ error: "Could not log in." });
  }
});

router.post("/api/logout", (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      log.error("Logout error", { error: error.message });
      return res.status(500).json({ error: "Could not log out." });
    }
    res.clearCookie("connect.sid");
    return res.json({ message: "Logged out successfully." });
  });
});

router.post("/api/upload-image", requireAuth, (req, res) => {
  upload.array("images", MAX_IMAGE_COUNT)(req, res, async (error) => {
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "Image must be 5 MB or smaller." });
    }
    if (error instanceof multer.MulterError && error.code === "LIMIT_UNEXPECTED_FILE") {
      return res.status(400).json({ error: `You can upload up to ${MAX_IMAGE_COUNT} images at once.` });
    }
    if (error) {
      return res.status(400).json({ error: error.message || "Could not upload image." });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "Please choose at least one image to upload." });
    }

    try {
      const createdMessages = [];
      const groupId = req.files.length > 1 ? randomUUID() : null;

      for (const file of req.files) {
        const imageUrl = `/uploads/${file.filename}`;
        const [result] = await pool.query(
          `INSERT INTO messages (user_id, message_type, message, image_url, original_name, group_id)
           VALUES (?, 'image', NULL, ?, ?, ?)`,
          [req.session.user.id, imageUrl, file.originalname, groupId]
        );

        const message = await loadMessageById(result.insertId);
        if (message) createdMessages.push(message);
      }

      if (createdMessages.length === 0) {
        return res.status(500).json({ error: "Could not create image messages." });
      }

      if (groupId) {
        const groupEvent = {
          message_type: "image_group",
          group_id: groupId,
          images: createdMessages.map((m) => ({ id: m.id, image_url: m.image_url, original_name: m.original_name })),
          created_at: createdMessages[0].created_at,
          user: createdMessages[0].user
        };
        io.emit("chat:message", groupEvent);
      } else {
        io.emit("chat:message", createdMessages[0]);
      }

      return res.status(201).json({ messages: createdMessages });
    } catch (uploadError) {
      deleteUploadedFiles(req.files);
      log.error("Image upload error", { error: uploadError.message });
      return res.status(500).json({ error: "Could not save image messages." });
    }
  });
});

router.get("/api/messages", requireAuth, async (req, res) => {
  try {
    const messages = await getRecentMessages();
    return res.json({ messages });
  } catch (error) {
    log.error("Fetch messages error", { error: error.message });
    return res.status(500).json({ error: "Could not load messages." });
  }
});

router.delete("/api/messages/group/:group_id", requireAuth, async (req, res) => {
  const groupId = req.params.group_id;

  if (!groupId || !/^[0-9a-f-]{36}$/.test(groupId)) {
    return res.status(400).json({ error: "Invalid group ID." });
  }

  try {
    const [rows] = await pool.query(
      "SELECT id, user_id, image_url FROM messages WHERE group_id = ?",
      [groupId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Group not found." });
    }

    if (rows.some((r) => r.user_id !== req.session.user.id)) {
      return res.status(403).json({ error: "You can only delete your own messages." });
    }

    for (const row of rows) {
      if (row.image_url) {
        fs.unlink(path.join(uploadsDir, path.basename(row.image_url)), () => {});
      }
    }

    await pool.query("DELETE FROM messages WHERE group_id = ?", [groupId]);
    io.emit("chat:delete_group", { group_id: groupId });
    return res.json({ message: "Group deleted." });
  } catch (error) {
    log.error("Delete group error", { error: error.message });
    return res.status(500).json({ error: "Could not delete group." });
  }
});

router.delete("/api/messages/:id", requireAuth, async (req, res) => {
  const messageId = Number(req.params.id);
  if (!Number.isInteger(messageId) || messageId <= 0) {
    return res.status(400).json({ error: "Invalid message ID." });
  }

  try {
    const [rows] = await pool.query(
      "SELECT user_id, message_type, image_url FROM messages WHERE id = ? LIMIT 1",
      [messageId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Message not found." });
    }
    if (rows[0].user_id !== req.session.user.id) {
      return res.status(403).json({ error: "You can only delete your own messages." });
    }

    if (rows[0].message_type === "image" && rows[0].image_url) {
      const filename = path.basename(rows[0].image_url);
      fs.unlink(path.join(uploadsDir, filename), () => {});
    }

    await pool.query("DELETE FROM messages WHERE id = ?", [messageId]);
    io.emit("chat:delete", { id: messageId });
    return res.json({ message: "Message deleted." });
  } catch (error) {
    log.error("Delete message error", { error: error.message });
    return res.status(500).json({ error: "Could not delete message." });
  }
});

router.use("/uploads", express.static(uploadsDir));
router.use(express.static(path.join(__dirname, "public")));

if (PUBLIC_BASE_PATH) {
  app.use(PUBLIC_BASE_PATH, router);
}
app.use(router);

io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

io.use((socket, next) => {
  const user = socket.request.session && socket.request.session.user;
  if (!user) return next(new Error("Unauthorized"));
  return next();
});

// userId -> { count, user }
const onlineUsers = new Map();

function broadcastOnlineUsers() {
  const users = Array.from(onlineUsers.values()).map((e) => e.user);
  io.emit("chat:online", users);
}

io.on("connection", (socket) => {
  const currentUser = socket.request.session.user;

  const entry = onlineUsers.get(currentUser.id);
  if (entry) {
    entry.count++;
  } else {
    onlineUsers.set(currentUser.id, { count: 1, user: currentUser });
  }
  broadcastOnlineUsers();

  socket.emit("chat:ready", { user: currentUser });

  socket.on("chat:message", async (payload) => {
    const rawMessage = payload && typeof payload.message === "string" ? payload.message : "";
    const message = rawMessage.trim();

    if (!message) return;

    if (message.length > MAX_MESSAGE_LENGTH) {
      socket.emit("chat:error", { error: `Message must be ${MAX_MESSAGE_LENGTH} characters or fewer.` });
      return;
    }

    try {
      const [result] = await pool.query(
        "INSERT INTO messages (user_id, message_type, message) VALUES (?, 'text', ?)",
        [currentUser.id, message]
      );

      const savedMessage = await loadMessageById(result.insertId);
      if (!savedMessage) return;

      io.emit("chat:message", savedMessage);
    } catch (error) {
      log.error("Socket message error", { error: error.message });
      socket.emit("chat:error", { error: "Could not send message." });
    }
  });

  socket.on("chat:typing", (isTyping) => {
    socket.broadcast.emit("chat:typing", { user: currentUser, isTyping: Boolean(isTyping) });
  });

  socket.on("disconnect", () => {
    const userEntry = onlineUsers.get(currentUser.id);
    if (userEntry) {
      userEntry.count--;
      if (userEntry.count <= 0) onlineUsers.delete(currentUser.id);
    }
    broadcastOnlineUsers();
    socket.broadcast.emit("chat:typing", { user: currentUser, isTyping: false });
  });
});

async function start() {
  try {
    const connection = await pool.getConnection();
    connection.release();
    server.listen(PORT, () => {
      log.info("Family chat server running", {
        port: PORT,
        basePath: PUBLIC_BASE_PATH || "/",
        socketPath,
        url: `${useHttps ? "https" : "http"}://localhost:${PORT}${PUBLIC_BASE_PATH}`
      });
    });
  } catch (error) {
    log.error("Database connection failed on startup", { error: error.message });
    process.exit(1);
  }
}

start();
