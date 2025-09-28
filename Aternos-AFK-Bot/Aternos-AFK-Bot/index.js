// Increase max listeners to avoid warnings
require('events').defaultMaxListeners = 30;

const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalBlock } } = require('mineflayer-pathfinder');
const mcData = require('minecraft-data');
const express = require('express');
const fs = require('fs');
const config = require('./settings.json');

const app = express();
const PORT = process.env.PORT || 5000;

// Throttle state trackers
let resurrectionCount = 0;
let lastDisconnectTime = 0;
let lastExitTime = 0;
const baseReconnectDelay = config.utils['auto-reconnect-delay'] || 10000;

let botStatus = {
  online: false,
  lastSeen: null,
  position: null,
  version: null,
  resurrection: 0,
  statusText: 'Pulse Guardian offline ❌'
};

// -------------- Uptime & Webhook ----------------

app.use(express.json());

app.get('/', (req, res) =>
  res.status(200).send('🫀 Pulse Guardian is alive — uptime overlay active.')
);

app.head('/', (req, res) =>
  res.sendStatus(200)
);

// Fallback GET endpoint for hosts that reject HEAD-only
app.get('/ping', (req, res) =>
  res.status(200).send('Pulse Guardian ping response')
);

app.get('/heartbeat', (req, res) =>
  res.status(botStatus.online ? 200 : 503).json(botStatus)
);

app.get('/status.json', (req, res) =>
  res.json(botStatus)
);

app.post('/ur-down', (req, res) => {
  const { alertType, monitor } = req.body;
  if (alertType === 'down') {
    logArtifact('UR Alert', `Monitor "${monitor.friendlyName}" is DOWN — exiting for restart`);
    process.exit(1);
  }
  res.sendStatus(200);
});

const server = app.listen(PORT, '0.0.0.0', () =>
  console.log(`📡 Uptime monitor listening on port ${PORT}`)
);

server.on('error', (err) => {
  logArtifact('HTTP Server Error', err.code || err.message);
});

// -------------- Artifact Logger & Crash Catchers ----------------

function logArtifact(event, detail) {
  const timestamp = new Date().toISOString();
  const entry = `[Pulse Guardian Artifact] ${timestamp} – ${event}: ${detail}\n`;
  console.log(entry.trim());
  fs.appendFileSync('pulse-artifacts.log', entry);
}

process.on('uncaughtException', (err) => {
  logArtifact('Uncaught Exception', err.stack || err.message);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logArtifact('Unhandled Rejection', reason.stack || reason);
  process.exit(1);
});

// -------------- Bot Factory ----------------

function createBot() {
  resurrectionCount++;
  botStatus.resurrection = resurrectionCount;
  logArtifact('Resurrection', `Pulse Guardian v5.3.${resurrectionCount} – Reconnect initiated`);
  console.log(`[Bot] Spawning v5.3.${resurrectionCount}…`);

  const bot = mineflayer.createBot({
    username: config['bot-account'].username,
    password: config['bot-account'].password,
    auth: config['bot-account'].type,
    host: config.server.ip,
    port: config.server.port,
    version: config.server.version
  });

  bot.loadPlugin(pathfinder);
  const mcVersion = mcData(bot.version);
  const defaultMove = new Movements(bot, mcVersion);

  let lastKeepAliveId = null;
  let lastRealActivity = Date.now();

  // Track real activity packets
  bot._client.on('packet', (data, meta) => {
    if (['chat', 'entity_move', 'keep_alive'].includes(meta.name)) {
      lastRealActivity = Date.now();
    }
  });

  // Mirror & synthetic keep-alive
  bot._client.on('keep_alive', (packet) => {
    lastKeepAliveId = packet.keepAliveId;
    try {
      if (bot._client.state === 'play' && packet.keepAliveId != null) {
        bot._client.write('keep_alive', { keepAliveId: packet.keepAliveId });
      }
    } catch (err) {
      logArtifact('KeepAlive Error', err.message);
    }
  });

  setInterval(() => {
    try {
      if (
        bot._client &&
        bot._client.state === 'play' &&
        bot._client.stream &&
        bot._client.stream.writable &&
        lastKeepAliveId != null
      ) {
        bot._client.write('keep_alive', { keepAliveId: lastKeepAliveId });
      }
    } catch (err) {
      logArtifact('Synthetic KeepAlive Error', err.message);
    }
  }, 30000);

  // Handle low-level socket errors with backoff
  bot._client.on('error', (err) => {
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

  // Movement, chat, drift, and fleeing logic
  function continuousDrift() {
    if (!bot.entity || !bot.entity.position) return;
    const { x, y, z } = bot.entity.position;
    const tx = Math.floor(x + (Math.random() * 10 - 5));
    const ty = Math.floor(y);
    const tz = Math.floor(z + (Math.random() * 10 - 5));

    bot.pathfinder.setMovements(defaultMove);
    bot.pathfinder.setGoal(new GoalBlock(tx, ty, tz), true);
    logArtifact('Drift Target', `(${tx}, ${ty}, ${tz})`);

    setTimeout(continuousDrift, Math.random() * 4000 + 3000);
  }

  function simulateHumanPresence() {
    bot.setControlState('jump', true);
    setTimeout(() => bot.setControlState('jump', false), 500);
    const yaw = Math.random() * Math.PI * 2;
    const pitch = (Math.random() - 0.5) * Math.PI;
    bot.look(yaw, pitch, true).catch(() => {});
    setTimeout(simulateHumanPresence, Math.random() * 20000 + 10000);
  }

  function mimicChat() {
    const messages = [
      'Just vibing 🌿',
      'Exploring the terrain...',
      'Anyone online?',
      'Still active 👀',
      'Pulse Guardian reporting in.',
      'What’s up?',
      'Need anything?',
      'Lag spike? Or just me?',
      'I love this biome.',
      'Crafting something cool soon.'
    ];
    try {
      const msg = messages[Math.floor(Math.random() * messages.length)];
      bot.chat(msg);
    } catch (err) {
      logArtifact('Chat Error', err.message);
    }
    setTimeout(mimicChat, Math.random() * 45000 + 30000);
  }

  function fleeFromHostiles() {
    const hostiles = Object.values(bot.entities).filter(e => 
      e.type === 'mob' &&
      ['Zombie','Skeleton','Creeper','Spider','Enderman'].includes(e.mobType) &&
      bot.entity.position.distanceTo(e.position) < 10
    );
    if (hostiles.length) {
      const threat = hostiles[0];
      const dx = bot.entity.position.x - threat.position.x;
      const dz = bot.entity.position.z - threat.position.z;
      const fx = Math.floor(bot.entity.position.x + dx * 2);
      const fy = Math.floor(bot.entity.position.y);
      const fz = Math.floor(bot.entity.position.z + dz * 2);

      bot.pathfinder.setMovements(defaultMove);
      bot.pathfinder.setGoal(new GoalBlock(fx, fy, fz), true);
      logArtifact('Flee', `${threat.mobType} → (${fx}, ${fy}, ${fz})`);
    }
    setTimeout(fleeFromHostiles, 3000);
  }

  // Ghostproof detection
  setInterval(() => {
    if (Date.now() - lastRealActivity > 60000) {
      logArtifact('Ghostproof Trigger', `v5.3.${resurrectionCount} – No activity detected`);
      botStatus.online = false;
      botStatus.statusText = `Pulse Guardian v5.3.${resurrectionCount} ghostproof ❌`;
      process.exit(1);
    }
  }, 30000);

  // -------------- Event Hooks ----------------

  bot.once('spawn', () => {
    botStatus = {
      ...botStatus,
      online: true,
      lastSeen: new Date().toISOString(),
      position: bot.entity.position,
      version: bot.version,
      statusText: `Pulse Guardian v5.3.${resurrectionCount} active ✅`
    };

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
    mimicChat();
    fleeFromHostiles();

    setInterval(() => {
      botStatus.lastSeen = new Date().toISOString();
      botStatus.position = bot.entity.position;
    }, 30000);
  });

  bot.on('goal_reached', () =>
    logArtifact('Movement', `Reached ${bot.entity.position}`)
  );

  bot.on('end', () => {
    logArtifact('Disconnect', 'Bot session ended');
    botStatus.online = false;
    botStatus.lastSeen = new Date().toISOString();
    botStatus.statusText = `Pulse Guardian v5.3.${resurrectionCount} disconnected ❌`;

    // Dynamic backoff on internal reconnects
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

  bot.on('kicked', (reason) => {
    logArtifact('Kick', JSON.stringify(reason));
    botStatus.online = false;
    botStatus.lastSeen = new Date().toISOString();
    botStatus.statusText = `Pulse Guardian v5.3.${resurrectionCount} kicked ❌`;
  });

  bot.on('error', (err) => {
    logArtifact('Error', err.stack || err.message);
    botStatus.online = false;
    botStatus.lastSeen = new Date().toISOString();
    botStatus.statusText = `Pulse Guardian v5.3.${resurrectionCount} error ❌`;
  });
}

// Kick off the first run
createBot();
