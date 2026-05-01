const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

// ─── Game Data ───────────────────────────────────────────────────────────────
const rooms = new Map();
const socketToRoom = new Map();

const DEFAULT_SETTINGS = {
  startingLives: 3,
  minPlayers: 3,
  maxPlayers: 10,
  roundsToWin: 1,
  powerUpsEnabled: true,
  timerRange: [6, 18],
};

const POWER_UPS = ["shield", "freeze", "reflect", "peek", "rewind", "passback"];

// ─── Helpers ─────────────────────────────────────────────────────────────────
function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "FUSE";
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function createRoom() {
  let code = genCode();
  while (rooms.has(code)) code = genCode();
  const room = {
    roomCode: code,
    hostId: "",
    state: "lobby",
    players: {},
    settings: { ...DEFAULT_SETTINGS },
    bomb: null,
    roundActive: false,
    tickInterval: null,
    pendingReflect: null,
    roundWins: {},
  };
  rooms.set(code, room);
  return room;
}

function addPlayer(room, id, name) {
  const isFirst = Object.keys(room.players).length === 0;
  const skinId = (Object.keys(room.players).length % 8) + 1;
  const player = {
    id, name: name.slice(0, 20), lives: room.settings.startingLives,
    isAlive: true, isHost: isFirst, isReady: false, skinId,
    powerUp: null, hasBomb: false, lastSenderId: null, joinedAt: Date.now(),
  };
  if (isFirst) room.hostId = id;
  room.players[id] = player;
  room.roundWins[id] = 0;
  return player;
}

function removePlayer(room, id) {
  delete room.players[id];
  delete room.roundWins[id];
}

function reassignHost(room) {
  const sorted = Object.values(room.players).sort((a, b) => a.joinedAt - b.joinedAt);
  if (!sorted.length) return null;
  sorted[0].isHost = true;
  room.hostId = sorted[0].id;
  return sorted[0].id;
}

function getAlive(room) {
  return Object.values(room.players).filter(p => p.isAlive);
}

function randomAlive(room, excludeId) {
  const list = getAlive(room).filter(p => p.id !== excludeId);
  if (!list.length) return null;
  return list[Math.floor(Math.random() * list.length)];
}

function assignPowerUps(room) {
  if (!room.settings.powerUpsEnabled) return;
  const count = Object.keys(room.players).length <= 4 ? 1 : 2;
  for (const p of Object.values(room.players)) {
    if (!p.powerUp) {
      for (let i = 0; i < count; i++) {
        p.powerUp = POWER_UPS[Math.floor(Math.random() * POWER_UPS.length)];
      }
    }
  }
}

function startRound(room) {
  for (const p of Object.values(room.players)) {
    p.lives = room.settings.startingLives;
    p.isAlive = true; p.hasBomb = false;
    p.lastSenderId = null; p.powerUp = null;
  }
  assignPowerUps(room);
  const holder = randomAlive(room);
  if (!holder) return;
  const [min, max] = room.settings.timerRange;
  const timer = Math.floor(Math.random() * (max - min + 1)) + min;
  holder.hasBomb = true;
  room.bomb = { holderId: holder.id, timer, initialTimer: timer, lastSenderId: null, isFrozen: false, freezeEndTime: null };
  room.roundActive = true;
  room.state = "inGame";
}

function resetBomb(room, excludeId) {
  const holder = randomAlive(room, excludeId);
  if (!holder || !room.bomb) return;
  for (const p of Object.values(room.players)) p.hasBomb = false;
  const [min, max] = room.settings.timerRange;
  const timer = Math.floor(Math.random() * (max - min + 1)) + min;
  holder.hasBomb = true;
  room.bomb = { holderId: holder.id, timer, initialTimer: timer, lastSenderId: null, isFrozen: false, freezeEndTime: null };
}

function broadcastRoom(room) {
  const pub = {
    roomCode: room.roomCode, hostId: room.hostId, state: room.state,
    settings: room.settings, roundWins: room.roundWins, roundActive: room.roundActive,
    players: Object.fromEntries(Object.entries(room.players).map(([id, p]) => [id, {
      id: p.id, name: p.name, lives: p.lives, isAlive: p.isAlive, isHost: p.isHost,
      isReady: p.isReady, skinId: p.skinId, hasBomb: p.hasBomb, powerUp: p.powerUp,
    }])),
  };
  io.to(room.roomCode).emit("roomUpdate", pub);
}

function sendTimer(room) {
  if (!room.bomb) return;
  io.to(room.bomb.holderId).emit("bombTimer", {
    timer: room.bomb.timer, isFrozen: room.bomb.isFrozen, initialTimer: room.bomb.initialTimer,
  });
}

function handleExplosion(room) {
  if (!room.bomb) return;
  const holder = room.players[room.bomb.holderId];
  if (!holder) return;

  let shieldUsed = false;
  if (holder.powerUp === "shield") {
    holder.powerUp = null; shieldUsed = true;
    io.to(room.roomCode).emit("explosion", { playerId: holder.id, skinId: holder.skinId, shieldUsed: true });
  } else {
    holder.lives -= 1;
    if (holder.lives <= 0) { holder.isAlive = false; holder.hasBomb = false; }
    io.to(room.roomCode).emit("explosion", { playerId: holder.id, skinId: holder.skinId, shieldUsed: false, livesRemaining: holder.lives });
  }

  const alive = getAlive(room);
  if (alive.length <= 1) { endRound(room, alive[0]?.id ?? null); return; }
  resetBomb(room, shieldUsed ? undefined : holder.id);
  broadcastRoom(room);
  sendTimer(room);
}

function endRound(room, winnerId) {
  if (room.tickInterval) { clearInterval(room.tickInterval); room.tickInterval = null; }
  room.roundActive = false; room.state = "postRound"; room.bomb = null;
  if (winnerId && room.roundWins[winnerId] !== undefined) room.roundWins[winnerId]++;
  io.to(room.roomCode).emit("roundEnd", { winnerId, roundWins: room.roundWins });
  broadcastRoom(room);
}

function startTick(room) {
  if (room.tickInterval) clearInterval(room.tickInterval);
  room.tickInterval = setInterval(() => {
    if (!room.bomb || !room.roundActive) return;
    const now = Date.now();
    if (room.bomb.isFrozen && room.bomb.freezeEndTime) {
      if (now >= room.bomb.freezeEndTime) { room.bomb.isFrozen = false; room.bomb.freezeEndTime = null; }
      else { sendTimer(room); return; }
    }
    room.bomb.timer -= 1;
    sendTimer(room);
    if (room.bomb.timer <= 0) handleExplosion(room);
  }, 1000);
}

// ─── Socket Events ────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  socket.on("createRoom", ({ name }) => {
    const room = createRoom();
    const player = addPlayer(room, socket.id, name);
    socketToRoom.set(socket.id, room.roomCode);
    socket.join(room.roomCode);
    socket.emit("roomCreated", { roomCode: room.roomCode, playerId: socket.id, player });
    broadcastRoom(room);
  });

  socket.on("joinRoom", ({ code, name }) => {
    const room = rooms.get(code?.toUpperCase());
    if (!room) { socket.emit("error", { message: "Room not found" }); return; }
    if (room.state !== "lobby") { socket.emit("error", { message: "Game already in progress" }); return; }
    if (Object.keys(room.players).length >= room.settings.maxPlayers) { socket.emit("error", { message: "Room is full" }); return; }
    const player = addPlayer(room, socket.id, name);
    socketToRoom.set(socket.id, room.roomCode);
    socket.join(room.roomCode);
    socket.emit("roomJoined", { roomCode: room.roomCode, playerId: socket.id, player });
    broadcastRoom(room);
  });

  socket.on("toggleReady", () => {
    const room = rooms.get(socketToRoom.get(socket.id));
    if (!room || room.state !== "lobby") return;
    const p = room.players[socket.id];
    if (p) { p.isReady = !p.isReady; broadcastRoom(room); }
  });

  socket.on("startGame", () => {
    const room = rooms.get(socketToRoom.get(socket.id));
    if (!room || room.hostId !== socket.id) return;
    const players = Object.values(room.players);
    if (players.length < room.settings.minPlayers) { socket.emit("error", { message: `Need at least ${room.settings.minPlayers} players` }); return; }
    const readyCount = players.filter(p => p.isReady).length;
    if (readyCount < Math.ceil(players.length * 0.5)) { socket.emit("error", { message: "At least 50% of players must be ready" }); return; }
    startRound(room); broadcastRoom(room); startTick(room); sendTimer(room);
  });

  socket.on("kickPlayer", ({ targetId }) => {
    const room = rooms.get(socketToRoom.get(socket.id));
    if (!room || room.hostId !== socket.id || targetId === socket.id || room.state === "inGame") return;
    io.to(targetId).emit("kicked");
    const ts = io.sockets.sockets.get(targetId);
    ts?.leave(room.roomCode);
    socketToRoom.delete(targetId);
    removePlayer(room, targetId);
    broadcastRoom(room);
  });

  socket.on("updateSettings", (newSettings) => {
    const room = rooms.get(socketToRoom.get(socket.id));
    if (!room || room.hostId !== socket.id || room.state !== "lobby") return;
    Object.assign(room.settings, newSettings);
    broadcastRoom(room);
  });

  socket.on("cutBomb", () => {
    const room = rooms.get(socketToRoom.get(socket.id));
    if (!room?.bomb || !room.roundActive || room.bomb.holderId !== socket.id) return;
    const p = room.players[socket.id];
    if (!p?.isAlive) return;
    const t = room.bomb.timer;
    if (Math.random() < Math.max(0, 40 - 1.5 * t) / 100) { handleExplosion(room); return; }
    room.bomb.timer = Math.max(1, room.bomb.timer - 2);
    sendTimer(room);
    io.to(room.roomCode).emit("bombCut", { playerId: socket.id });
  });

  socket.on("passBomb", ({ targetId }) => {
    const room = rooms.get(socketToRoom.get(socket.id));
    if (!room?.bomb || !room.roundActive || room.bomb.holderId !== socket.id || targetId === socket.id) return;
    const from = room.players[socket.id];
    const to = room.players[targetId];
    if (!from?.isAlive || !to?.isAlive) return;
    from.hasBomb = false; to.hasBomb = true;
    room.bomb.lastSenderId = socket.id; room.bomb.holderId = targetId;
    to.lastSenderId = socket.id;
    room.bomb.timer = Math.floor(room.bomb.timer / 2);
    broadcastRoom(room); sendTimer(room);
    io.to(room.roomCode).emit("bombPassed", { fromId: socket.id, toId: targetId, timer: room.bomb.timer });
  });

  socket.on("usePowerUp", () => {
    const room = rooms.get(socketToRoom.get(socket.id));
    if (!room?.bomb || !room.roundActive) return;
    const p = room.players[socket.id];
    if (!p?.isAlive || !p.powerUp) return;
    const pu = p.powerUp;

    if (pu === "freeze" && !room.bomb.isFrozen) {
      room.bomb.isFrozen = true; room.bomb.freezeEndTime = Date.now() + 5000;
      io.to(room.roomCode).emit("bombFrozen", { playerId: socket.id, duration: 5 });
    } else if (pu === "reflect") {
      room.pendingReflect = { playerId: socket.id, senderId: room.bomb.lastSenderId ?? "", expiresAt: Date.now() + 2000 };
      io.to(room.roomCode).emit("reflectPending", { playerId: socket.id });
    } else if (pu === "peek") {
      socket.emit("peekResult", { timer: room.bomb.timer });
    } else if (pu === "rewind" && room.bomb.timer < room.bomb.initialTimer) {
      room.bomb.timer = Math.min(room.bomb.timer + 5, room.bomb.initialTimer);
      sendTimer(room); io.to(room.roomCode).emit("bombRewound", { playerId: socket.id });
    } else if (pu === "passback" && room.bomb.holderId === socket.id) {
      const senderId = room.bomb.lastSenderId;
      const sender = senderId ? room.players[senderId] : null;
      if (!sender?.isAlive) { socket.emit("error", { message: "Original sender unavailable" }); return; }
      p.hasBomb = false; sender.hasBomb = true;
      room.bomb.holderId = senderId; room.bomb.lastSenderId = socket.id;
      room.bomb.timer = Math.floor(room.bomb.timer / 2);
      broadcastRoom(room); sendTimer(room);
      io.to(room.roomCode).emit("bombPassed", { fromId: socket.id, toId: senderId, timer: room.bomb.timer });
    }

    p.powerUp = null;
    broadcastRoom(room);
  });

  socket.on("restartMatch", () => {
    const room = rooms.get(socketToRoom.get(socket.id));
    if (!room || room.hostId !== socket.id || room.state !== "postRound") return;
    if (room.tickInterval) { clearInterval(room.tickInterval); room.tickInterval = null; }
    for (const id of Object.keys(room.roundWins)) room.roundWins[id] = 0;
    room.state = "lobby"; room.roundActive = false; room.bomb = null;
    for (const p of Object.values(room.players)) {
      p.lives = room.settings.startingLives; p.isAlive = true;
      p.hasBomb = false; p.isReady = false; p.powerUp = null; p.lastSenderId = null;
    }
    broadcastRoom(room);
  });

  socket.on("disconnect", () => {
    const code = socketToRoom.get(socket.id);
    if (!code) return;
    socketToRoom.delete(socket.id);
    const room = rooms.get(code);
    if (!room) return;
    const wasHost = room.hostId === socket.id;
    const hadBomb = room.bomb?.holderId === socket.id;
    const bombTimer = room.bomb?.timer;
    removePlayer(room, socket.id);
    if (!Object.keys(room.players).length) { rooms.delete(code); return; }
    if (wasHost) {
      reassignHost(room);
      io.to(room.roomCode).emit("hostChanged", { newHostId: room.hostId });
    }
    if (hadBomb && room.roundActive && room.bomb) {
      const newHolder = randomAlive(room);
      if (newHolder) {
        for (const p of Object.values(room.players)) p.hasBomb = false;
        newHolder.hasBomb = true;
        room.bomb.holderId = newHolder.id;
        if (bombTimer !== undefined) room.bomb.timer = bombTimer;
        sendTimer(room);
      }
    }
    if (room.roundActive) {
      const alive = getAlive(room);
      if (alive.length <= 1) { endRound(room, alive[0]?.id ?? null); return; }
    }
    broadcastRoom(room);
  });
});

httpServer.listen(PORT, () => {
  console.log(`\n🎮 FUSE – Enhanced Edition`);
  console.log(`🚀 Server running at http://localhost:${PORT}`);
  console.log(`📱 Open on your phone or share the URL on your local network\n`);
});
