// index.js — Pulse Guardian v6.6 Continuous Random Movement + Head Rotation

require('events').defaultMaxListeners = 30;

const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalNear } } = require('mineflayer-pathfinder');
const mcData = require('minecraft-data');
const express = require('express');
const fs = require('fs');

// ---------------- Env Config ----------------
const config = {
  "bot-account": {
    username: process.env.BOT_USER,
    password: process.env.BOT_PASS || "",
    type: process.env.BOT_AUTH || "offline"
  },
  server: {
    ip: process.env.MC_HOST || "localhost",
    port: parseInt(process.env.MC_PORT || "25565", 10),
    version: process.env.MC_VERSION
  },
  utils: {
    "anti-afk": process.env.ANTI_AFK === "true",
    "chat-messages": {
      enabled: process.env.CHAT_MESSAGES === "true",
      "repeat-delay": parseInt(process.env.CHAT_REPEAT_DELAY || "60", 10),
      messages: (process.env.CHAT_MESSAGES_LIST || "").split(",").map(s => s.trim()).filter(Boolean)
    },
    "chat-log": process.env.CHAT_LOG !== "false",
    "auto-reconnect": process.env.AUTO_RECONNECT !== "false",
    "auto-reconnect-delay": parseInt(process.env.RECONNECT_DELAY || "10000", 10),
    "status-endpoint": process.env.STATUS_ENDPOINT || "/status.json"
  }
};

// ---------------- Express Heartbeat ----------------
const app = express();
const PORT = process.env.PORT || 5000;

let resurrectionCount = 0;
let lastDisconnectTime = 0;
const baseReconnectDelay = config.utils["auto-reconnect-delay"];

let botStatus = {
  online: false,
  lastSeen: null,
  position: null,
  version: null,
  resurrection: 0,
  statusText: 'Pulse Guardian offline ❌'
};

app.use(express.json());
app.get('/', (req,res) => res.status(200).send('🫀 Pulse Guardian is alive — uptime overlay active.'));
app.get('/ping', (req,res) => res.status(200).send('Pulse Guardian ping response'));
app.get('/heartbeat', (req,res) => res.status(botStatus.online ? 200 : 503).json(botStatus));
app.get(config.utils["status-endpoint"], (req,res) => res.json(botStatus));

app.listen(PORT, '0.0.0.0', () => console.log(`📡 Uptime monitor listening on port ${PORT}`));

// ---------------- Artifact Logger ----------------
function logArtifact(event, detail) {
  const timestamp = new Date().toISOString();
  const entry = `[Pulse Guardian Artifact] ${timestamp} – ${event}: ${detail}\n`;
  if (config.utils["chat-log"]) console.log(entry.trim());
  try { fs.appendFileSync('pulse-artifacts.log', entry); } catch {}
}

// ---------------- Bot Factory ----------------
function createBot() {
  resurrectionCount++;
  botStatus.resurrection = resurrectionCount;
  logArtifact('Resurrection', `Pulse Guardian v6.${resurrectionCount} – Reconnect initiated`);

  const bot = mineflayer.createBot({
    username: config["bot-account"].username,
    password: config["bot-account"].password,
    auth: config["bot-account"].type,
    host: config.server.ip,
    port: config.server.port,
    version: config.server.version
  });

  bot.loadPlugin(pathfinder);
  const mcVersion = mcData(bot.version);
  const defaultMove = new Movements(bot, mcVersion);

  // Continuous random movement + head rotation
  function wander() {
    if (!bot.entity.position) return;
    const base = bot.entity.position;
    const dx = (Math.random() - 0.5) * 10;
    const dz = (Math.random() - 0.5) * 10;
    const x = Math.floor(base.x + dx);
    const y = Math.floor(base.y);
    const z = Math.floor(base.z + dz);

    bot.pathfinder.setMovements(defaultMove);
    bot.pathfinder.setGoal(new GoalNear(x, y, z, 1));

    const yaw = Math.random() * Math.PI * 2;
    const pitch = (Math.random() - 0.5) * 0.5;
    bot.look(yaw, pitch, true).catch(() => {});

    logArtifact('Wander', `Moving to (${x},${y},${z}) with head yaw=${yaw.toFixed(2)}, pitch=${pitch.toFixed(2)}`);

    setTimeout(wander, 15000 + Math.random()*10000);
  }

  // Chat mimic
  function mimicChat() {
    if (!config.utils['chat-messages'].enabled) return;
    try {
      const msgs = config.utils['chat-messages'].messages;
      if (Array.isArray(msgs) && msgs.length > 0) {
        const msg = msgs[Math.floor(Math.random()*msgs.length)];
        bot.chat(msg);
        logArtifact('Chat', `Sent: ${msg}`);
      }
    } catch (err) {
      logArtifact('Chat Error', err.message);
    }
    const delayMs = (config.utils['chat-messages']['repeat-delay'] || 60) * 1000;
    setTimeout(mimicChat, Math.random()*delayMs + delayMs);
  }

  bot.once('spawn', () => {
    botStatus = {
      ...botStatus,
      online: true,
      lastSeen: new Date().toISOString(),
      position: bot.entity.position,
      version: bot.version,
      statusText: `Pulse Guardian v6.${resurrectionCount} active ✅`
    };
    wander();
    if (config.utils['chat-messages'].enabled) mimicChat();
    setInterval(() => {
      botStatus.lastSeen = new Date().toISOString();
      botStatus.position = bot.entity.position;
    }, 30000);
  });

  bot.on('end', () => {
    logArtifact('Disconnect', 'Bot session ended');
    botStatus.online = false;
    botStatus.statusText = `Pulse Guardian v6.${resurrectionCount} disconnected ❌`;
    if (!config.utils["auto-reconnect"]) return;
    const now = Date.now();
    let delay = baseReconnectDelay;
    if (lastDisconnectTime && now - lastDisconnectTime < 60000) {
      delay *= 2;
      logArtifact('Reconnect Throttle', `Delaying next spawn by ${delay}ms`);
    }
    lastDisconnectTime = now;
    const jitter = Math.floor(Math.random() * 5000);
    setTimeout(createBot, delay + jitter);
  });

  bot.on('kicked', reason => {
    logArtifact('Kick', JSON.stringify(reason));
    botStatus.online = false;
    botStatus.statusText = `Pulse Guardian v6.${resurrectionCount} kicked ❌`;
  });

  bot.on('error', err => {
    logArtifact('Error', err.stack || err.message);
    botStatus.online = false;
    botStatus.statusText = `Pulse Guardian v6.${resurrectionCount} error ❌`;
    setTimeout(createBot, baseReconnectDelay);
  });
}

// ---------------- Kick off ----------------
createBot();

// ---------------- Global Error Guards ----------------
process.on('uncaughtException', err => {
  logArtifact('Uncaught Exception', err.stack || err.message);
  setTimeout(createBot, baseReconnectDelay);
});

process.on('unhandledRejection', reason => {
  logArtifact('Unhandled Rejection', reason?.stack || reason);
  setTimeout(createBot, baseReconnectDelay);
});
