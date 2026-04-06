
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const fsPromises = require("fs/promises");
const crypto = require("crypto");
let Pool = null;

try {
  ({ Pool } = require("pg"));
} catch (error) {
  Pool = null;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "chat-data.json");
const DEFAULT_GROUP = "general";
const MAX_MESSAGES = 200;
const DATABASE_URL = process.env.DATABASE_URL || "";
const STORAGE_KEY = "chatx-store";

const onlineUsers = new Map();
const userSockets = new Map();
let store = createDefaultStore();
let dbPool = null;

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_request, response) => {
  response.json({
    ok: true,
    storage: dbPool ? "postgres" : "json-file"
  });
});

function createDefaultStore() {
  return {
    users: {},
    groups: {
      [DEFAULT_GROUP]: {
        name: DEFAULT_GROUP,
        owner: null,
        visibility: "public",
        members: [],
        requests: [],
        messages: []
      }
    },
    directMessages: {}
  };
}

function normalizeName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 24);
}

function normalizeGroupName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_]/g, "")
    .slice(0, 24) || DEFAULT_GROUP;
}

function normalizeMessage(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 800);
}

function directChatId(userA, userB) {
  return [normalizeName(userA).toLowerCase(), normalizeName(userB).toLowerCase()].sort().join("__");
}

function createPasswordHash(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, user) {
  if (!user || !user.salt || !user.passwordHash) {
    return false;
  }

  const computedHash = crypto.scryptSync(String(password), user.salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(computedHash, "hex"), Buffer.from(user.passwordHash, "hex"));
}

function uniqueNames(names) {
  return Array.from(new Set(names.filter(Boolean)));
}

function normalizeStatus(status, kind) {
  if (kind === "direct") {
    return {
      delivered: Boolean(status && status.delivered),
      seen: Boolean(status && status.seen)
    };
  }

  return {
    recipients: Array.isArray(status && status.recipients) ? uniqueNames(status.recipients.map(normalizeName)) : [],
    deliveredTo: Array.isArray(status && status.deliveredTo) ? uniqueNames(status.deliveredTo.map(normalizeName)) : [],
    seenBy: Array.isArray(status && status.seenBy) ? uniqueNames(status.seenBy.map(normalizeName)) : []
  };
}

function normalizeMessageRecord(message, fallbackKind) {
  return {
    id: message.id || `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    kind: message.kind || fallbackKind,
    from: normalizeName(message.from) || "System",
    text: normalizeMessage(message.text) || "Message unavailable",
    target: message.target || "",
    timestamp: message.timestamp || new Date().toISOString(),
    editedAt: message.editedAt || null,
    status: normalizeStatus(message.status, message.kind || fallbackKind)
  };
}

function normalizeStore(rawStore) {
  const normalized = {
    users: rawStore.users && typeof rawStore.users === "object" ? rawStore.users : {},
    groups: rawStore.groups && typeof rawStore.groups === "object" ? rawStore.groups : {},
    directMessages:
      rawStore.directMessages && typeof rawStore.directMessages === "object" ? rawStore.directMessages : {}
  };

  if (!normalized.groups[DEFAULT_GROUP]) {
    normalized.groups[DEFAULT_GROUP] = {
      name: DEFAULT_GROUP,
      owner: null,
      visibility: "public",
      members: [],
      requests: [],
      messages: []
    };
  }

  Object.keys(normalized.users).forEach((username) => {
    const user = normalized.users[username];
    const cleanName = normalizeName(user.username || username);

    normalized.users[cleanName] = {
      username: cleanName,
      passwordHash: user.passwordHash || "",
      salt: user.salt || "",
      role: ["admin", "leader", "user"].includes(user.role) ? user.role : "user",
      createdAt: user.createdAt || new Date().toISOString(),
      lastSeenAt: user.lastSeenAt || user.createdAt || new Date().toISOString()
    };

    if (cleanName !== username) {
      delete normalized.users[username];
    }
  });

  Object.keys(normalized.groups).forEach((groupName) => {
    const group = normalized.groups[groupName];
    const cleanGroup = normalizeGroupName(group.name || groupName);

    normalized.groups[cleanGroup] = {
      name: cleanGroup,
      owner: group.owner ? normalizeName(group.owner) : null,
      visibility: group.visibility === "private" ? "private" : "public",
      members: Array.isArray(group.members) ? uniqueNames(group.members.map(normalizeName)) : [],
      requests: Array.isArray(group.requests) ? uniqueNames(group.requests.map(normalizeName)) : [],
      messages: Array.isArray(group.messages)
        ? group.messages.slice(-MAX_MESSAGES).map((message) => normalizeMessageRecord(message, "group"))
        : []
    };

    if (cleanGroup !== groupName) {
      delete normalized.groups[groupName];
    }
  });

  Object.keys(normalized.directMessages).forEach((chatId) => {
    normalized.directMessages[chatId] = Array.isArray(normalized.directMessages[chatId])
      ? normalized.directMessages[chatId].slice(-MAX_MESSAGES).map((message) => normalizeMessageRecord(message, "direct"))
      : [];
  });

  return normalized;
}

function shouldUseDatabase() {
  return Boolean(DATABASE_URL);
}

function getDatabaseConfig() {
  const useSsl = process.env.POSTGRES_SSL === "false" ? false : { rejectUnauthorized: false };
  return {
    connectionString: DATABASE_URL,
    ssl: useSsl
  };
}

async function initializeDatabase() {
  if (!shouldUseDatabase()) {
    return;
  }

  if (!Pool) {
    throw new Error("DATABASE_URL is set, but the 'pg' package is not installed yet. Run npm install.");
  }

  dbPool = new Pool(getDatabaseConfig());

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function loadStoreFromFile() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });

    if (!fs.existsSync(DATA_FILE)) {
      const emptyStore = createDefaultStore();
      fs.writeFileSync(DATA_FILE, JSON.stringify(emptyStore, null, 2));
      return emptyStore;
    }

    return normalizeStore(JSON.parse(fs.readFileSync(DATA_FILE, "utf8")));
  } catch (error) {
    console.error("Could not load chat data:", error);
    return createDefaultStore();
  }
}

async function loadStoreFromDatabase() {
  try {
    const result = await dbPool.query("SELECT value FROM app_state WHERE key = $1 LIMIT 1", [STORAGE_KEY]);

    if (!result.rows.length) {
      const emptyStore = createDefaultStore();
      await dbPool.query(
        "INSERT INTO app_state (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())",
        [STORAGE_KEY, JSON.stringify(emptyStore)]
      );
      return emptyStore;
    }

    return normalizeStore(result.rows[0].value);
  } catch (error) {
    console.error("Could not load chat data from Postgres:", error);
    return createDefaultStore();
  }
}

async function loadStore() {
  if (dbPool) {
    return loadStoreFromDatabase();
  }

  return loadStoreFromFile();
}

async function saveStoreToFile() {
  try {
    await fsPromises.mkdir(DATA_DIR, { recursive: true });
    await fsPromises.writeFile(DATA_FILE, JSON.stringify(store, null, 2));
  } catch (error) {
    console.error("Could not save chat data:", error);
  }
}

async function saveStoreToDatabase() {
  try {
    await dbPool.query(
      `
        INSERT INTO app_state (key, value, updated_at)
        VALUES ($1, $2::jsonb, NOW())
        ON CONFLICT (key)
        DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `,
      [STORAGE_KEY, JSON.stringify(store)]
    );
  } catch (error) {
    console.error("Could not save chat data to Postgres:", error);
  }
}

async function saveStore() {
  if (dbPool) {
    await saveStoreToDatabase();
    return;
  }

  await saveStoreToFile();
}

function countAdmins() {
  return Object.values(store.users).filter((user) => user.role === "admin").length;
}

function ensureUserRecord(username) {
  const cleanUsername = normalizeName(username) || "Anonymous";
  return store.users[cleanUsername] || null;
}

function ensureGroup(groupName) {
  const cleanGroup = normalizeGroupName(groupName);

  if (!store.groups[cleanGroup]) {
    store.groups[cleanGroup] = {
      name: cleanGroup,
      owner: null,
      visibility: "private",
      members: [],
      requests: [],
      messages: []
    };
  }

  return store.groups[cleanGroup];
}

function addMemberToGroup(username, groupName) {
  const group = ensureGroup(groupName);

  if (!group.members.includes(username)) {
    group.members.push(username);
  }

  group.members = uniqueNames(group.members);
  group.requests = group.requests.filter((name) => name !== username);
}

function removeMemberFromGroup(username, groupName) {
  const group = ensureGroup(groupName);
  group.members = group.members.filter((name) => name !== username);
  group.requests = group.requests.filter((name) => name !== username);
}

function isUserOnline(username) {
  const sockets = userSockets.get(username);
  return Boolean(sockets && sockets.size);
}

function getLastSeenAt(username) {
  return store.users[username] ? store.users[username].lastSeenAt : null;
}
function setUserSocket(username, socketId) {
  if (!userSockets.has(username)) {
    userSockets.set(username, new Set());
  }

  userSockets.get(username).add(socketId);
}

function removeUserSocket(username, socketId) {
  const sockets = userSockets.get(username);

  if (!sockets) {
    return;
  }

  sockets.delete(socketId);

  if (!sockets.size) {
    userSockets.delete(username);
  }
}

function sendToUsername(username, eventName, payload) {
  const sockets = userSockets.get(username);

  if (!sockets) {
    return;
  }

  sockets.forEach((socketId) => {
    io.to(socketId).emit(eventName, payload);
  });
}

function getCurrentUser(socket) {
  const username = socket.data.username;
  return username ? store.users[username] || null : null;
}

function canCreatePublicGroup(user) {
  return Boolean(user && (user.role === "admin" || user.role === "leader"));
}

function canManageGroup(user, group) {
  return Boolean(user && group && (group.owner === user.username || user.role === "admin"));
}

function getVisibleGroups(username) {
  const user = store.users[username];

  return Object.values(store.groups)
    .filter((group) => group.visibility === "public" || group.members.includes(username) || (user && user.role === "admin"))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((group) => ({
      name: group.name,
      owner: group.owner,
      visibility: group.visibility,
      memberCount: group.members.length,
      requestCount: group.requests.length,
      lastMessage: group.messages[group.messages.length - 1] || null
    }));
}

function getDiscoverableGroups(username) {
  const user = store.users[username];

  return Object.values(store.groups)
    .filter((group) => group.name !== DEFAULT_GROUP)
    .filter((group) => !group.members.includes(username) && !(user && user.role === "admin"))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((group) => ({
      name: group.name,
      owner: group.owner,
      visibility: group.visibility,
      requested: group.requests.includes(username)
    }));
}

function getGroupMembers(groupName) {
  return ensureGroup(groupName).members
    .slice()
    .sort((a, b) => a.localeCompare(b))
    .map((username) => ({
      username,
      online: isUserOnline(username),
      role: store.users[username] ? store.users[username].role : "user"
    }));
}

function buildDirectList(username) {
  const names = new Set();

  Object.keys(store.directMessages).forEach((chatId) => {
    const [userA, userB] = chatId.split("__");
    const current = username.toLowerCase();

    if (userA === current || userB === current) {
      const other = userA === current ? userB : userA;
      const resolved = Object.keys(store.users).find((name) => name.toLowerCase() === other) || other;
      if (resolved !== username) {
        names.add(resolved);
      }
    }
  });

  Array.from(userSockets.keys()).forEach((name) => {
    if (name !== username) {
      names.add(name);
    }
  });

  return Array.from(names)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const messages = store.directMessages[directChatId(username, name)] || [];
      return {
        username: name,
        online: isUserOnline(name),
        lastSeenAt: getLastSeenAt(name),
        lastMessage: messages[messages.length - 1] || null
      };
    });
}

function emitSidebar(username) {
  const user = store.users[username];

  sendToUsername(username, "sidebar data", {
    user: user
      ? {
          username: user.username,
          role: user.role
        }
      : null,
    groups: getVisibleGroups(username),
    discover: getDiscoverableGroups(username),
    directs: buildDirectList(username)
  });
}

function emitSidebarForEveryone() {
  Array.from(userSockets.keys()).forEach((username) => {
    emitSidebar(username);
  });
}

function groupRecipients(groupName, sender) {
  return ensureGroup(groupName).members.filter((member) => member !== sender);
}

function createDirectMessage(from, target, text) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    kind: "direct",
    from,
    target,
    text,
    timestamp: new Date().toISOString(),
    editedAt: null,
    status: {
      delivered: false,
      seen: false
    }
  };
}

function createGroupMessage(from, target, text, recipients) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    kind: "group",
    from,
    target,
    text,
    timestamp: new Date().toISOString(),
    editedAt: null,
    status: {
      recipients,
      deliveredTo: [],
      seenBy: []
    }
  };
}

function userHasActiveGroupOpen(username, groupName) {
  return Array.from(onlineUsers.values()).some(
    (user) => user.username === username && user.activeChatType === "group" && user.activeChatId === groupName
  );
}

function userHasActiveDirectOpen(username, otherUsername) {
  return Array.from(onlineUsers.values()).some(
    (user) => user.username === username && user.activeChatType === "direct" && user.activeChatId === otherUsername
  );
}

function emitGroupStatusUpdate(groupName, message) {
  sendToUsername(message.from, "group status update", {
    group: groupName,
    messageId: message.id,
    status: message.status
  });
}

function emitDirectStatusUpdate(viewerUsername, otherUsername, message) {
  sendToUsername(viewerUsername, "direct status update", {
    username: otherUsername,
    messageId: message.id,
    status: message.status
  });
}

async function markPendingDeliveriesForUser(username) {
  let changed = false;

  Object.values(store.groups).forEach((group) => {
    group.messages.forEach((message) => {
      if (message.kind !== "group" || !message.status || message.from === username) {
        return;
      }

      if (message.status.recipients.includes(username) && !message.status.deliveredTo.includes(username)) {
        message.status.deliveredTo.push(username);
        message.status.deliveredTo = uniqueNames(message.status.deliveredTo);
        changed = true;
        emitGroupStatusUpdate(group.name, message);
      }
    });
  });

  Object.keys(store.directMessages).forEach((chatId) => {
    store.directMessages[chatId].forEach((message) => {
      if (message.kind === "direct" && message.target === username && message.status && !message.status.delivered) {
        message.status.delivered = true;
        changed = true;
        emitDirectStatusUpdate(message.from, username, message);
        emitDirectStatusUpdate(username, message.from, message);
      }
    });
  });

  if (changed) {
    await saveStore();
  }
}

async function markGroupSeen(username, groupName) {
  const group = ensureGroup(groupName);
  let changed = false;

  group.messages.forEach((message) => {
    if (message.kind !== "group" || message.from === username || !message.status.recipients.includes(username)) {
      return;
    }

    if (!message.status.deliveredTo.includes(username)) {
      message.status.deliveredTo.push(username);
      message.status.deliveredTo = uniqueNames(message.status.deliveredTo);
      changed = true;
    }

    if (!message.status.seenBy.includes(username)) {
      message.status.seenBy.push(username);
      message.status.seenBy = uniqueNames(message.status.seenBy);
      changed = true;
    }

    emitGroupStatusUpdate(groupName, message);
  });

  if (changed) {
    await saveStore();
  }
}

async function markDirectSeen(username, otherUsername) {
  const chatId = directChatId(username, otherUsername);
  const messages = store.directMessages[chatId] || [];
  let changed = false;

  messages.forEach((message) => {
    if (message.kind !== "direct" || message.target !== username || message.from !== otherUsername) {
      return;
    }

    if (!message.status.delivered) {
      message.status.delivered = true;
      changed = true;
    }

    if (!message.status.seen) {
      message.status.seen = true;
      changed = true;
    }

    emitDirectStatusUpdate(otherUsername, username, message);
    emitDirectStatusUpdate(username, otherUsername, message);
  });

  if (changed) {
    await saveStore();
  }
}
function emitGroupMembers(groupName) {
  const group = ensureGroup(groupName);
  const payload = {
    group: groupName,
    owner: group.owner,
    members: getGroupMembers(groupName),
    requests: group.requests.slice().sort((a, b) => a.localeCompare(b))
  };

  group.members.forEach((username) => {
    sendToUsername(username, "group members", payload);
  });
}

function openGroupForSocket(socket, username, groupName) {
  const group = ensureGroup(groupName);
  const user = store.users[username];

  if (!(group.visibility === "public" || group.members.includes(username) || user.role === "admin")) {
    socket.emit("group access denied", {
      group: group.name,
      visibility: group.visibility,
      requested: group.requests.includes(username)
    });
    return;
  }

  socket.data.activeChatType = "group";
  socket.data.activeChatId = group.name;

  const state = onlineUsers.get(socket.id);

  if (state) {
    state.activeChatType = "group";
    state.activeChatId = group.name;
  }

  socket.emit("chat opened", {
    chatType: "group",
    chatId: group.name,
    title: group.name,
    subtitle:
      group.name === DEFAULT_GROUP
        ? "Everyone can chat here"
        : group.owner
          ? `Owner: ${group.owner}`
          : "Group chat",
    canChat: true,
    isOwner: canManageGroup(user, group),
    history: group.messages
  });

  emitGroupMembers(group.name);
}

function openDirectForSocket(socket, username, otherUsername) {
  const other = ensureUserRecord(otherUsername);

  if (!other) {
    socket.emit("toast", {
      text: "That user does not exist yet."
    });
    return;
  }

  socket.data.activeChatType = "direct";
  socket.data.activeChatId = other.username;

  const state = onlineUsers.get(socket.id);

  if (state) {
    state.activeChatType = "direct";
    state.activeChatId = other.username;
  }

  socket.emit("chat opened", {
    chatType: "direct",
    chatId: other.username,
    title: other.username,
    subtitle: isUserOnline(other.username) ? "Online now" : "Last seen recently",
    canChat: true,
    isOwner: false,
    history: store.directMessages[directChatId(username, other.username)] || [],
    presence: {
      online: isUserOnline(other.username),
      lastSeenAt: other.lastSeenAt
    }
  });
}

async function registerSocketAuth(socket, username) {
  const user = store.users[username];

  socket.data.username = username;
  onlineUsers.set(socket.id, {
    username,
    activeChatType: "group",
    activeChatId: DEFAULT_GROUP
  });

  setUserSocket(username, socket.id);
  addMemberToGroup(username, DEFAULT_GROUP);
  store.users[username].lastSeenAt = new Date().toISOString();

  await saveStore();
  await markPendingDeliveriesForUser(username);

  socket.emit("auth success", {
    username: user.username,
    role: user.role
  });

  emitSidebarForEveryone();
  openGroupForSocket(socket, username, DEFAULT_GROUP);
}

async function logoutSocket(socket, notify = true) {
  const username = socket.data.username;

  if (!username) {
    return;
  }

  if (store.users[username]) {
    store.users[username].lastSeenAt = new Date().toISOString();
  }

  onlineUsers.delete(socket.id);
  removeUserSocket(username, socket.id);
  socket.data.username = null;
  socket.data.activeChatType = null;
  socket.data.activeChatId = null;

  await saveStore();
  emitSidebarForEveryone();

  Object.keys(store.groups).forEach((groupName) => {
    if (store.groups[groupName].members.includes(username)) {
      emitGroupMembers(groupName);
    }
  });

  if (notify) {
    socket.emit("logged out");
  }
}

function updateMessageInGroup(groupName, messageId, username, newText) {
  const group = ensureGroup(groupName);
  const message = group.messages.find((item) => item.id === messageId);

  if (!message || message.from !== username || message.kind === "system") {
    return null;
  }

  message.text = newText;
  message.editedAt = new Date().toISOString();
  return message;
}

function updateMessageInDirect(username, otherUsername, messageId, newText) {
  const messages = store.directMessages[directChatId(username, otherUsername)] || [];
  const message = messages.find((item) => item.id === messageId);

  if (!message || message.from !== username) {
    return null;
  }

  message.text = newText;
  message.editedAt = new Date().toISOString();
  return message;
}

function deleteOwnedGroups(username) {
  Object.keys(store.groups).forEach((groupName) => {
    const group = store.groups[groupName];

    if (groupName !== DEFAULT_GROUP && group.owner === username) {
      const affected = group.members.slice();
      delete store.groups[groupName];

      affected.forEach((memberName) => {
        sendToUsername(memberName, "group deleted", {
          group: groupName
        });
      });
    }
  });
}

function scrubUserFromHistory(username) {
  Object.values(store.groups).forEach((group) => {
    group.members = group.members.filter((member) => member !== username);
    group.requests = group.requests.filter((member) => member !== username);
    group.messages.forEach((message) => {
      if (message.from === username) {
        message.from = "Deleted User";
      }

      if (message.kind === "group" && message.status) {
        message.status.recipients = message.status.recipients.filter((name) => name !== username);
        message.status.deliveredTo = message.status.deliveredTo.filter((name) => name !== username);
        message.status.seenBy = message.status.seenBy.filter((name) => name !== username);
      }
    });
  });

  Object.keys(store.directMessages).forEach((chatId) => {
    if (chatId.includes(username.toLowerCase())) {
      delete store.directMessages[chatId];
    }
  });
}
io.on("connection", (socket) => {
  socket.on("signup", async ({ username, password }) => {
    const cleanUsername = normalizeName(username);
    const cleanPassword = String(password || "").trim();

    if (!cleanUsername || cleanPassword.length < 4) {
      socket.emit("auth error", {
        text: "Use a username and a password with at least 4 characters."
      });
      return;
    }

    if (store.users[cleanUsername]) {
      socket.emit("auth error", {
        text: "That username already exists."
      });
      return;
    }

    const passwordData = createPasswordHash(cleanPassword);

    store.users[cleanUsername] = {
      username: cleanUsername,
      passwordHash: passwordData.hash,
      salt: passwordData.salt,
      role: countAdmins() === 0 ? "admin" : "user",
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString()
    };

    addMemberToGroup(cleanUsername, DEFAULT_GROUP);
    await saveStore();
    await registerSocketAuth(socket, cleanUsername);
  });

  socket.on("login", async ({ username, password }) => {
    const cleanUsername = normalizeName(username);
    const user = store.users[cleanUsername];

    if (!verifyPassword(password, user)) {
      socket.emit("auth error", {
        text: "Invalid username or password."
      });
      return;
    }

    await registerSocketAuth(socket, cleanUsername);
  });

  socket.on("resume session", async ({ username }) => {
    const cleanUsername = normalizeName(username);
    const user = store.users[cleanUsername];

    if (!user) {
      socket.emit("logged out");
      return;
    }

    await registerSocketAuth(socket, cleanUsername);
  });

  socket.on("logout", async () => {
    await logoutSocket(socket);
  });

  socket.on("open group", async ({ group }) => {
    const currentUser = getCurrentUser(socket);

    if (!currentUser) {
      return;
    }

    await markGroupSeen(currentUser.username, normalizeGroupName(group));
    openGroupForSocket(socket, currentUser.username, group);
  });

  socket.on("open direct", async ({ username: otherUsername }) => {
    const currentUser = getCurrentUser(socket);
    const other = normalizeName(otherUsername);

    if (!currentUser || !other) {
      return;
    }

    await markDirectSeen(currentUser.username, other);
    openDirectForSocket(socket, currentUser.username, other);
  });

  socket.on("create group", async ({ group, visibility }) => {
    const currentUser = getCurrentUser(socket);
    const cleanGroup = normalizeGroupName(group);
    const groupVisibility = visibility === "public" ? "public" : "private";

    if (!currentUser || !cleanGroup || store.groups[cleanGroup] || cleanGroup === DEFAULT_GROUP) {
      socket.emit("toast", {
        text: "That group cannot be created."
      });
      return;
    }

    if (groupVisibility === "public" && !canCreatePublicGroup(currentUser)) {
      socket.emit("toast", {
        text: "Only admin or leader accounts can create public groups."
      });
      return;
    }

    store.groups[cleanGroup] = {
      name: cleanGroup,
      owner: currentUser.username,
      visibility: groupVisibility,
      members: [currentUser.username],
      requests: [],
      messages: []
    };

    await saveStore();
    emitSidebarForEveryone();
    openGroupForSocket(socket, currentUser.username, cleanGroup);
  });

  socket.on("request group join", async ({ group }) => {
    const currentUser = getCurrentUser(socket);
    const targetGroup = ensureGroup(group);

    if (!currentUser || targetGroup.members.includes(currentUser.username)) {
      return;
    }

    if (targetGroup.visibility === "public") {
      addMemberToGroup(currentUser.username, targetGroup.name);
    } else if (!targetGroup.requests.includes(currentUser.username)) {
      targetGroup.requests.push(currentUser.username);
    }

    await saveStore();
    emitSidebarForEveryone();
    emitGroupMembers(targetGroup.name);
  });

  socket.on("review join request", async ({ group, member, action }) => {
    const currentUser = getCurrentUser(socket);
    const targetGroup = ensureGroup(group);
    const memberName = normalizeName(member);

    if (!currentUser || !canManageGroup(currentUser, targetGroup)) {
      return;
    }

    if (action === "approve") {
      addMemberToGroup(memberName, targetGroup.name);
      sendToUsername(memberName, "toast", {
        text: `You were approved for ${targetGroup.name}.`
      });
    } else {
      targetGroup.requests = targetGroup.requests.filter((name) => name !== memberName);
    }

    await saveStore();
    emitSidebarForEveryone();
    emitGroupMembers(targetGroup.name);
  });

  socket.on("add group member", async ({ group, member }) => {
    const currentUser = getCurrentUser(socket);
    const targetGroup = ensureGroup(group);
    const memberName = normalizeName(member);

    if (!currentUser || !memberName || !store.users[memberName] || !canManageGroup(currentUser, targetGroup)) {
      return;
    }

    addMemberToGroup(memberName, targetGroup.name);
    await saveStore();
    emitSidebarForEveryone();
    emitGroupMembers(targetGroup.name);
  });

  socket.on("remove group member", async ({ group, member }) => {
    const currentUser = getCurrentUser(socket);
    const targetGroup = ensureGroup(group);
    const memberName = normalizeName(member);

    if (!currentUser || !memberName || !canManageGroup(currentUser, targetGroup) || memberName === targetGroup.owner) {
      return;
    }

    removeMemberFromGroup(memberName, targetGroup.name);
    await saveStore();
    emitSidebarForEveryone();
    emitGroupMembers(targetGroup.name);
  });

  socket.on("delete group", async ({ group }) => {
    const currentUser = getCurrentUser(socket);
    const cleanGroup = normalizeGroupName(group);
    const targetGroup = store.groups[cleanGroup];

    if (!currentUser || !targetGroup || cleanGroup === DEFAULT_GROUP || !canManageGroup(currentUser, targetGroup)) {
      return;
    }

    const affectedMembers = targetGroup.members.slice();
    delete store.groups[cleanGroup];
    await saveStore();

    affectedMembers.forEach((memberName) => {
      sendToUsername(memberName, "group deleted", {
        group: cleanGroup
      });
    });

    emitSidebarForEveryone();
  });
  socket.on("change user role", async ({ username, role }) => {
    const currentUser = getCurrentUser(socket);
    const targetName = normalizeName(username);
    const targetUser = store.users[targetName];

    if (!currentUser || currentUser.role !== "admin" || !targetUser) {
      return;
    }

    targetUser.role = role === "leader" ? "leader" : "user";
    await saveStore();
    emitSidebarForEveryone();
  });

  socket.on("chat message", async (text) => {
    const currentUser = getCurrentUser(socket);
    const cleanText = normalizeMessage(text);

    if (!currentUser || !cleanText) {
      return;
    }

    if (socket.data.activeChatType === "direct") {
      const otherUsername = normalizeName(socket.data.activeChatId);

      if (!store.users[otherUsername]) {
        return;
      }

      const message = createDirectMessage(currentUser.username, otherUsername, cleanText);
      message.status.delivered = isUserOnline(otherUsername);
      message.status.seen = userHasActiveDirectOpen(otherUsername, currentUser.username);

      const chatId = directChatId(currentUser.username, otherUsername);

      if (!Array.isArray(store.directMessages[chatId])) {
        store.directMessages[chatId] = [];
      }

      store.directMessages[chatId].push(message);
      store.directMessages[chatId] = store.directMessages[chatId].slice(-MAX_MESSAGES);

      await saveStore();

      sendToUsername(currentUser.username, "direct message", {
        username: otherUsername,
        message
      });
      sendToUsername(otherUsername, "direct message", {
        username: currentUser.username,
        message
      });

      emitSidebar(currentUser.username);
      emitSidebar(otherUsername);
      return;
    }

    const groupName = normalizeGroupName(socket.data.activeChatId || DEFAULT_GROUP);
    const targetGroup = ensureGroup(groupName);

    if (!(targetGroup.visibility === "public" || targetGroup.members.includes(currentUser.username) || currentUser.role === "admin")) {
      return;
    }

    const recipients = groupRecipients(groupName, currentUser.username);
    const message = createGroupMessage(currentUser.username, groupName, cleanText, recipients);

    message.status.deliveredTo = recipients.filter((name) => isUserOnline(name));
    message.status.seenBy = recipients.filter((name) => userHasActiveGroupOpen(name, groupName));

    targetGroup.messages.push(message);
    targetGroup.messages = targetGroup.messages.slice(-MAX_MESSAGES);

    await saveStore();

    targetGroup.members.forEach((memberName) => {
      sendToUsername(memberName, "group message", {
        group: groupName,
        message
      });
    });

    emitSidebarForEveryone();
  });

  socket.on("edit message", async ({ chatType, chatId, messageId, text }) => {
    const currentUser = getCurrentUser(socket);
    const cleanText = normalizeMessage(text);

    if (!currentUser || !messageId || !cleanText) {
      return;
    }

    let updatedMessage = null;

    if (chatType === "direct") {
      updatedMessage = updateMessageInDirect(currentUser.username, normalizeName(chatId), messageId, cleanText);

      if (updatedMessage) {
        const otherUsername = normalizeName(chatId);
        await saveStore();
        sendToUsername(currentUser.username, "message edited", {
          chatType: "direct",
          chatId: otherUsername,
          message: updatedMessage
        });
        sendToUsername(otherUsername, "message edited", {
          chatType: "direct",
          chatId: currentUser.username,
          message: updatedMessage
        });
      }

      return;
    }

    updatedMessage = updateMessageInGroup(normalizeGroupName(chatId), messageId, currentUser.username, cleanText);

    if (updatedMessage) {
      const groupName = normalizeGroupName(chatId);
      await saveStore();
      ensureGroup(groupName).members.forEach((memberName) => {
        sendToUsername(memberName, "message edited", {
          chatType: "group",
          chatId: groupName,
          message: updatedMessage
        });
      });
    }
  });

  socket.on("delete account", async () => {
    const currentUser = getCurrentUser(socket);

    if (!currentUser) {
      return;
    }

    if (currentUser.role === "admin" && countAdmins() === 1) {
      socket.emit("toast", {
        text: "Create another admin account first before deleting this one."
      });
      return;
    }

    deleteOwnedGroups(currentUser.username);
    scrubUserFromHistory(currentUser.username);
    delete store.users[currentUser.username];

    const sockets = userSockets.get(currentUser.username) ? Array.from(userSockets.get(currentUser.username)) : [];

    await saveStore();

    sockets.forEach((socketId) => {
      io.to(socketId).emit("logged out");
      onlineUsers.delete(socketId);
    });

    userSockets.delete(currentUser.username);
    emitSidebarForEveryone();
  });

  socket.on("disconnect", async () => {
    await logoutSocket(socket, false);
  });
});

async function startServer() {
  try {
    await initializeDatabase();
    store = await loadStore();

    server.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
      console.log(`Storage mode: ${dbPool ? "postgres" : "json-file"}`);
    });
  } catch (error) {
    console.error("Server failed to start:", error);
    process.exit(1);
  }
}

startServer();
