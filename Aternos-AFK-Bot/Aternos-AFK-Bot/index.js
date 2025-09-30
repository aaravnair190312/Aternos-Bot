// index.js — Pulse Guardian v6.7.4 “The Sleepproof Sentinel”

require('events').defaultMaxListeners = 30;

const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalNear } } = require('mineflayer-pathfinder');
const mcData = require('minecraft-data');
const express = require('express');
const fs = require('fs');
const fetch = require('node-fetch');

const config = require('./settings.json');

const app = express();
const PORT = process.env.PORT || 5000;

let resurrectionCount = 0;
let lastReconnect = 0;
const baseReconnectDelay = config.utils["auto-reconnect-delay"];
const MIN_RECONNECT_DELAY = 30000;

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

function logArtifact(event, detail) {
  const timestamp = new Date().toISOString();
  const entry = `[Pulse Guardian Artifact] ${timestamp} – ${event}: ${detail}\n`;
  if (config.utils["chat-log"]) console.log(entry.trim());
  try { fs.appendFileSync('pulse-artifacts.log', entry); } catch {}
}

async function wakeGuard(url) {
  try {
    const res = await fetch(url);
    if (res.status === 503 || res.status === 502) {
      logArtifact('WakeGuard', 'Render waking up… retrying in 15s');
      await new Promise(r => setTimeout(r, config.utils["wake-guard"]?.["retry-delay"] || 15000));
      return await fetch(url);
    }
    return res;
  } catch (err) {
    logArtifact('WakeGuard Error', err.message);
    return null;
  }
}

function safeReconnect() {
  const now = Date.now();
  if (now - lastReconnect < MIN_RECONNECT_DELAY) {
    logArtifact('Reconnect', 'Skipping reconnect to avoid spam storm');
    return;
  }
  lastReconnect = now;
  const jitter = Math.floor(Math.random() * 5000);
  setTimeout(createBot, baseReconnectDelay + jitter);
}

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

  // === Patched Wander with online guard ===
  function wander() {
    if (!bot.player || !bot.entity?.position || !botStatus.online) {
      logArtifact('Wander Skip', 'Server offline or bot not spawned, skipping wander()');
      return;
    }

    const base = bot.entity.position;
    const dx = (Math.random() - 0.5) * 8;
    const dz = (Math.random() - 0.5) * 8;
    const x = Math.floor(base.x + dx);
    const y = Math.floor(base.y);
    const z = Math.floor(base.z + dz);

    bot.pathfinder.setMovements(defaultMove);
    bot.pathfinder.setGoal(new GoalNear(x, y, z, 1));

    const yaw = Math.random() * Math.PI * 2;
    const pitch = (Math.random() - 0.5) * 0.5;
    bot.look(yaw, pitch, true).catch(() => {});

    logArtifact('Wander', `Moving to (${x},${y},${z}) yaw=${yaw.toFixed(2)} pitch=${pitch.toFixed(2)}`);

    setTimeout(wander, 10000 + Math.random()*10000);
  }

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

  // === Hardened Guards ===
  let lastPos = null;
  setInterval(() => {
    if (!bot.entity?.position || !botStatus.online) return;
    const pos = bot.entity.position;
    if (lastPos && pos.distanceTo(lastPos) < 1) {
      logArtifact('Watchdog', 'Bot stuck, forcing wander() restart');
      wander();
    }
    lastPos = pos;
  }, 20000);

  bot.on('goal_reached', () => logArtifact('Pathfinder', 'Goal reached'));
  bot.on('path_update', (r) => {
    if (r.status === 'noPath') {
      logArtifact('Pathfinder', 'No path, retrying wander()');
      wander();
    }
  });

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

    if (config.utils["pulse-loop"]?.enabled) {
      setInterval(async () => {
        try {
          const res = await wakeGuard(`http://localhost:${PORT}/heartbeat`);
          if (res) {
            logArtifact('PulseLoop', `Self-ping → ${res.status}`);
          }
        } catch (err) {
          logArtifact('PulseLoop Error', err.message);
        }
      }, config.utils["pulse-loop"].interval || 120000);
    }
  });

  bot.on('respawn', () => {
    logArtifact('Respawn', 'Bot respawned, restarting wander()');
    wander();
  });

  bot.on('end', () => {
    logArtifact('Disconnect', 'Bot session ended');
    botStatus.online = false;
    botStatus.statusText = `Pulse Guardian v6.${resurrectionCount} disconnected ❌`;
    if (config.utils["auto-reconnect"]) safeReconnect();
  });

  bot.on('kicked', reason => {
    logArtifact('Kick', JSON.stringify(reason));
    botStatus.online = false;
    botStatus.statusText = `Pulse Guardian v6.${resurrectionCount} kicked ❌`;
    if (config.utils["auto-reconnect"]) safeReconnect();
  });

  bot.on('error', err => {
    logArtifact('Error', err.stack || err.message);
    botStatus.online = false;
    botStatus.statusText = `Pulse Guardian v6.${resurrectionCount} error ❌`;
    if (config.utils["auto-reconnect"]) safeReconnect();
  });
}

createBot();

process.on('uncaughtException', err => {
  logArtifact('Uncaught Exception', err.stack || err.message);
  if (config.utils["auto-reconnect"]) safeReconnect();
});

process.on('unhandledRejection', reason => {
  logArtifact('Unhandled Rejection', reason?.stack || reason);
  if (config.utils["auto-reconnect"]) safeReconnect();
});


