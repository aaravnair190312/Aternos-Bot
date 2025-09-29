// index.js

// ─────────────────────────────────────────────────────────────────────────────
// Increase max listeners to avoid EventEmitter warnings
// ─────────────────────────────────────────────────────────────────────────────
require('events').defaultMaxListeners = 30;

const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalBlock } } = require('mineflayer-pathfinder');
const mcData    = require('minecraft-data');
const express   = require('express');
const fs        = require('fs');

// ---------------- Env-only Config ----------------
const config = {
  "bot-account": {
    username: process.env.BOT_USER,
    password: process.env.BOT_PASS || "",
    type:     process.env.BOT_AUTH || "mojang"
  },
  server: {
    ip:      process.env.MC_HOST,
    port:    parseInt(process.env.MC_PORT, 10),
    version: process.env.MC_VERSION
  },
  position: {
    enabled: process.env.POS_ENABLED === "true",
    x:       parseFloat(process.env.POS_X) || 0,
    y:       parseFloat(process.env.POS_Y) || 0,
    z:       parseFloat(process.env.POS_Z) || 0
  },
  utils: {
    "auto-auth": {
      enabled:  process.env.AUTO_AUTH === "true",
      password: process.env.AUTO_AUTH_PASS || ""
    },
    "anti-afk": {
      enabled: process.env.ANTI_AFK === "true",
      sneak:   true,
      jump:    true,
      rotate:  true
    },
    "chat-messages": {
      enabled:      process.env.CHAT_MESSAGES === "true",
      repeat:       true,
      "repeat-delay": parseInt(process.env.CHAT_REPEAT_DELAY || "60", 10),
      messages:     (process.env.CHAT_MESSAGES_LIST || "").split(",").filter(Boolean)
    },
    "chat-log":          process.env.CHAT_LOG !== "false",
    "auto-reconnect":    process.env.AUTO_RECONNECT !== "false",
    "auto-reconnect-delay":
                         parseInt(process.env.RECONNECT_DELAY || "10000", 10),
    "status-endpoint":   process.env.STATUS_ENDPOINT || "/status.json"
  }
};

// ---------------- Express Heartbeat & Status ----------------
const app  = express();
const PORT = process.env.PORT || 5000;

let resurrectionCount   = 0;
let lastDisconnectTime  = 0;
let lastExitTime        = 0;
const baseReconnectDelay = config.utils["auto-reconnect-delay"];

let botStatus = {
  online:      false,
  lastSeen:    null,
  position:    null,
  version:     null,
  resurrection: 0,
  statusText:  'Pulse Guardian offline ❌'
};

app.use(express.json());
app.get('/',            (req,res) => res.status(200).send('🫀 Pulse Guardian is alive — uptime overlay active.'));
app.head('/',           (req,res) => res.sendStatus(200));
app.get('/ping',        (req,res) => res.status(200).send('Pulse Guardian ping response'));
app.get('/heartbeat',   (req,res) => res.status(botStatus.online ? 200 : 503).json(botStatus));
app.get(config.utils["status-endpoint"], (req,res) => res.json(botStatus));

const server = app.listen(PORT, '0.0.0.0', () =>
  console.log(`📡 Uptime monitor listening on port ${PORT}`)
);
server.on('error', err => logArtifact('HTTP Server Error', err.code || err.message));

// ---------------- Artifact Logger ----------------
function logArtifact(event, detail) {
  const timestamp = new Date().toISOString();
  const entry = `[Pulse Guardian Artifact] ${timestamp} – ${event}: ${detail}\n`;
  if (config.utils["chat-log"]) console.log(entry.trim());
  try { fs.appendFileSync('pulse-artifacts.log', entry); } catch {}
}

process.on('uncaughtException', err => {
  logArtifact('Uncaught Exception', err.stack || err.message);
  process.exit(1);
});
process.on('unhandledRejection', reason => {
  logArtifact('Unhandled Rejection', reason?.stack || reason);
  process.exit(1);
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers: replace deprecated mobType and detect hostility
// ─────────────────────────────────────────────────────────────────────────────
function getMobType(entity) {
  return entity.displayName || entity.name || 'unknown';
}
function isHostile(type) {
  return ['zombie','skeleton','creeper','spider','enderman']
    .includes(type.toLowerCase());
}

// ---------------- Bot Factory & Reconnect Logic ----------------
function createBot() {
  resurrectionCount++;
  botStatus.resurrection = resurrectionCount;
  logArtifact('Resurrection', `Pulse Guardian v5.3.${resurrectionCount} – Reconnect initiated`);
  console.log(`[Bot] Spawning v5.3.${resurrectionCount}…`);

  const bot = mineflayer.createBot({
    username: config["bot-account"].username,
    password: config["bot-account"].password,
    auth:     config["bot-account"].type,
    host:     config.server.ip,
    port:     config.server.port,
    version:  config.server.version
  });

  bot.loadPlugin(pathfinder);
  const mcVersion   = mcData(bot.version);
  const defaultMove = new Movements(bot, mcVersion);

  let lastKeepAliveId  = null;
  let lastRealActivity = Date.now();

  // Track real activity packets
  bot._client.on('packet', (data, meta) => {
    if (['chat','entity_move','keep_alive'].includes(meta.name)) {
      lastRealActivity = Date.now();
    }
  });

  // Mirror incoming keep-alive
  bot._client.on('keep_alive', packet => {
    lastKeepAliveId = packet.keepAliveId;
    try {
      if (bot._client.state === 'play' && packet.keepAliveId != null) {
        bot._client.write('keep_alive', { keepAliveId: packet.keepAliveId });
      }
    } catch (err) {
      logArtifact('KeepAlive Error', err.message);
    }
  });

  // Synthetic keep-alive every 30s
  setInterval(() => {
    try {
      if (bot._client.state === 'play' && lastKeepAliveId != null) {
        bot._client.write('keep_alive', { keepAliveId: lastKeepAliveId });
      }
    } catch (err) {
      logArtifact('Synthetic KeepAlive Error', err.message);
    }
  }, 30000);

  // Handle socket errors with exponential backoff
  bot._client.on('error', err => {
    logArtifact('Socket Error', err.code || err.message);
    if (err.code === 'ECONNRESET') {
      const now = Date.now();
      let exitDelay = baseReconnectDelay;
      if (lastExitTime && now - lastExitTime < 60000) {
        exitDelay *= 2;
        logArtifact('Exit Throttle', `Delaying exit by ${exitDelay}ms`);
      } else {
        logArtifact('Exit Delay', `Delaying exit by ${exitDelay}ms`);
      }
      lastExitTime = now;
      setTimeout(() => process.exit(1), exitDelay);
    }
  });

  // ──────────────── Behavior Routines ──────────────────
  function continuousDrift() {
    try {
      if (bot.entity?.position) {
        const { x,y,z } = bot.entity.position;
        const tx = Math.floor(x + (Math.random()*10 - 5));
        const ty = Math.floor(y);
        const tz = Math.floor(z + (Math.random()*10 - 5));
        bot.pathfinder.setMovements(defaultMove);
        bot.pathfinder.setGoal(new GoalBlock(tx, ty, tz), true);
        logArtifact('Drift Target', `(${tx}, ${ty}, ${tz})`);
      }
    } catch (err) {
      logArtifact('Drift Error', err.message);
    }
    setTimeout(continuousDrift, Math.random()*4000 + 3000);
  }

  function simulateHumanPresence() {
    try {
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 500);
      const yaw   = Math.random() * Math.PI * 2;
      const pitch = (Math.random() - 0.5) * Math.PI;
      bot.look(yaw, pitch, true).catch(() => {});
    } catch (err) {
      logArtifact('Jump/Look Error', err.message);
    }
    setTimeout(simulateHumanPresence, Math.random()*20000 + 10000);
  }

  function mimicChat() {
    if (!config.utils['chat-messages'].enabled) return;
    try {
      const msgs = config.utils['chat-messages'].messages;
      bot.chat(msgs[Math.floor(Math.random()*msgs.length)]);
    } catch (err) {
      logArtifact('Chat Error', err.message);
    }
    const delayMs = (config.utils['chat-messages']['repeat-delay'] || 60) * 1000;
    setTimeout(mimicChat, Math.random()*delayMs + delayMs);
  }

  function fleeFromHostiles() {
    try {
      const threats = Object.values(bot.entities).filter(e => {
        if (!e?.position) return false;
        const type = getMobType(e);
        return isHostile(type) &&
               bot.entity.position.distanceTo(e.position) < 10;
      });
      if (threats.length) {
        const threat = threats[0];
        const { x,y,z } = bot.entity.position;
        const dx = x - threat.position.x;
        const dz = z - threat.position.z;
        const fx = Math.floor(x + dx * 2);
        const fy = Math.floor(y);
        const fz = Math.floor(z + dz * 2);
        bot.pathfinder.setMovements(defaultMove);
        bot.pathfinder.setGoal(new GoalBlock(fx, fy, fz), true);
        logArtifact('Flee', `${getMobType(threat)} → (${fx}, ${fy}, ${fz})`);
      }
    } catch (err) {
      logArtifact('Flee Error', err.message);
    }
    setTimeout(fleeFromHostiles, 3000);
  }

  function antiAfkLoop() {
    if (!config.utils['anti-afk'].enabled) return;
    try {
      bot.setControlState('sneak', true);
      setTimeout(() => bot.setControlState('sneak', false), 1000);
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 300);
      const yaw   = Math.random() * Math.PI * 2;
      const pitch = (Math.random() - 0.5) * Math.PI;
      bot.look(yaw, pitch, true).catch(() => {});
    } catch (err) {
      logArtifact('Anti-AFK Error', err.message);
    }
    setTimeout(antiAfkLoop, Math.random()*15000 + 10000);
  }

  // Ghostproof detection
  const ghostproofInterval = setInterval(() => {
    if (Date.now() - lastRealActivity > 60000) {
      logArtifact('Ghostproof Trigger', `v5.3.${resurrectionCount} – No activity detected`);
      botStatus.online     = false;
      botStatus.statusText = `Pulse Guardian v5.3.${resurrectionCount} ghostproof ❌`;
      clearInterval(ghostproofInterval);
      process.exit(1);
    }
  }, 30000);

  // ─────────────── Event Hooks on spawn and lifecycle ─────────────────
  bot.once('spawn', () => {
    botStatus = {
      ...botStatus,
      online:     true,
      lastSeen:   new Date().toISOString(),
      position:   bot.entity.position,
      version:    bot.version,
      statusText: `Pulse Guardian v5.3.${resurrectionCount} active ✅`
    };

    // Auto‐auth if enabled
    if (config.utils['auto-auth'].enabled) {
      const pwd = config.utils['auto-auth'].password;
      try {
        bot.chat(`/register ${pwd} ${pwd}`);
        bot.chat(`/login ${pwd}`);
      } catch (err) {
        logArtifact('Auth Chat Error', err.message);
      }
    }

    continuousDrift();
    simulateHumanPresence();
    antiAfkLoop();
    if (config.utils['chat-messages'].enabled) mimicChat();
    fleeFromHostiles();

    // Position init if enabled
    if (config.position.enabled) {
      try {
        const { x,y,z } = config.position;
        bot.pathfinder.setMovements(defaultMove);
        bot.pathfinder.setGoal(new GoalBlock(Math.floor(x), Math.floor(y), Math.floor(z)), true);
        logArtifact('Position Init', `Targeting (${x}, ${y}, ${z})`);
      } catch (err) {
        logArtifact('Position Error', err.message);
      }
    }

    // Update botStatus every 30s
    setInterval(() => {
      botStatus.lastSeen  = new Date().toISOString();
      botStatus.position  = bot.entity.position;
    }, 30000);
  });

  bot.on('goal_reached', () =>
    logArtifact('Movement', `Reached ${bot.entity.position}`)
  );

  bot.on('end', () => {
    logArtifact('Disconnect', 'Bot session ended');
    botStatus.online     = false;
    botStatus.lastSeen   = new Date().toISOString();
    botStatus.statusText = `Pulse Guardian v5.3.${resurrectionCount} disconnected ❌`;
    const now     = Date.now();
    let delay     = baseReconnectDelay;
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
    botStatus.online     = false;
    botStatus.lastSeen   = new Date().toISOString();
    botStatus.statusText = `Pulse Guardian v5.3.${resurrectionCount} kicked ❌`;
  });

  bot.on('error', err => {
    logArtifact('Error', err.stack || err.message);
    botStatus.online     = false;
    botStatus.lastSeen   = new Date().toISOString();
    botStatus.statusText = `Pulse Guardian v5.3.${resurrectionCount} error ❌`;
  });
}  // ────────────────────────────────────────────────────────────────────────────

createBot();
```
