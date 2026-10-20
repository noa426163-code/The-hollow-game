// TeaHack :: The Hollow multiplayer relay server
// Node.js 18+. Rooms are isolated by user-provided room code.
"use strict";
const express = require("express");
const http = require("node:http");
const path = require("node:path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(",") : true },
  maxHttpBufferSize: 1e5,
  pingInterval: 25000,
  pingTimeout: 20000
});
const PORT = Number(process.env.PORT || 3000);
const MAX_ROOMS = 2000;
const MAX_PLAYERS_PER_ROOM = 12;
const rooms = new Map();
app.disable("x-powered-by");
app.use(express.static(path.join(__dirname, "public"), { etag: true, maxAge: "1h" }));
app.get("/health", (_req, res) => res.json({ status: "ok", rooms: rooms.size, uptime: Math.round(process.uptime()) }));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

function safeRoom(value) {
  return String(value || "NIGHT").toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 24) || "NIGHT";
}
function safeName(value) {
  return String(value || "Survivor").replace(/[<>]/g, "").trim().slice(0, 18) || "Survivor";
}
function finiteClamp(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function roomPlayers(room) {
  return [...(rooms.get(room)?.players.values() || [])];
}
function broadcastState(room) {
  io.to(room).emit("room:state", { room, players: roomPlayers(room) });
}
io.on("connection", socket => {
  socket.data.lastUpdate = 0;
  socket.on("room:join", payload => {
    if (socket.data.room) return;
    const room = safeRoom(payload?.room);
    if (!rooms.has(room) && rooms.size >= MAX_ROOMS) {
      socket.emit("server:error", { message: "Server room capacity reached." });
      return;
    }
    const state = rooms.get(room) || { players: new Map(), level: 1, seed: 1 };
    if (state.players.size >= MAX_PLAYERS_PER_ROOM) {
      socket.emit("server:error", { message: "This room is full (12 players maximum)." });
      return;
    }
    rooms.set(room, state);
    socket.data.room = room;
    socket.data.name = safeName(payload?.name);
    socket.join(room);
    const player = {
      id: socket.id,
      name: socket.data.name,
      x: 1.5,
      y: 1.5,
      hp: 100,
      score: 0,
      level: finiteClamp(payload?.level, 1, 100, state.level),
      color: [...socket.id].reduce((a, c) => a + c.charCodeAt(0), 0) % 6
    };
    state.players.set(socket.id, player);
    socket.emit("room:joined", { room, level: state.level });
    broadcastState(room);
    socket.to(room).emit("chat:message", { name: "SYSTEM", text: `${player.name} entered the Hollow.` });
  });
  socket.on("player:update", payload => {
    const room = socket.data.room;
    if (!room || payload?.room !== room) return;
    const now = Date.now();
    if (now - socket.data.lastUpdate < 45) return;
    socket.data.lastUpdate = now;
    const state = rooms.get(room);
    const p = state?.players.get(socket.id);
    if (!p) return;
    p.x = finiteClamp(payload.x, 0, 29.99, p.x);
    p.y = finiteClamp(payload.y, 0, 19.99, p.y);
    p.hp = finiteClamp(payload.hp, 0, 100, p.hp);
    p.score = finiteClamp(payload.score, 0, 1e9, p.score);
    p.level = finiteClamp(payload.level, 1, 100, p.level);
    io.to(room).emit("player:update", p);
  });
  socket.on("level:change", payload => {
    const room = socket.data.room;
    if (!room || payload?.room !== room) return;
    const state = rooms.get(room);
    if (!state) return;
    const next = finiteClamp(payload.level, 1, 100, state.level);
    // Keep all clients in the same sector; server tracks the announced level.
    state.level = Math.max(state.level, next);
    state.seed = finiteClamp(payload.seed, 0, 0xffffffff, state.seed);
    io.to(room).emit("room:level", { level: state.level, seed: state.seed });
  });
  socket.on("disconnect", () => {
    const room = socket.data.room;
    if (!room) return;
    const state = rooms.get(room);
    state?.players.delete(socket.id);
    socket.to(room).emit("player:left", socket.id);
    socket.to(room).emit("chat:message", { name: "SYSTEM", text: `${socket.data.name || "A survivor"} vanished from the room.` });
    if (state && state.players.size === 0) rooms.delete(room);
    else broadcastState(room);
  });
});
server.listen(PORT, "0.0.0.0", () => {
  console.log(`The Hollow server listening on http://localhost:${PORT}`);
});
