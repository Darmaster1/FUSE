# FUSE – Enhanced Edition

Real-time multiplayer bomb-passing browser game. Built with Node.js + Express + Socket.IO.

## Quick Start (Local)


## How to Play

1. One player **creates a room** and shares the room code
2. Other players **join the room** using the code
3. Players mark themselves as **ready**
4. Host **starts the game** (requires ≥ 3 players, ≥ 50% ready)
5. Someone gets the 💣 — the timer ticks down!
6. **Pass** the bomb to others (timer halves on each pass)
7. **Cut** the wire to shave off 2 seconds (risky!)
8. **Use power-ups** strategically
9. When the timer hits 0 — BOOM! That player loses a life
10. Last player standing wins!

## Power-Ups

| Power-Up | Effect |
|---|---|
| 🛡️ Shield | Absorbs one explosion — no damage |
| ❄️ Freeze | Freezes the bomb timer for 5 seconds |
| 🔄 Reflect | Bounces back the next incoming pass |
| 👁️ Peek | Reveals the current timer to you |
| ⏪ Rewind | Adds 5 seconds back to the timer |
| ↩️ Pass Back | Instantly passes the bomb back to whoever sent it |

## Game Settings (Host Configurable)

| Setting | Default | Range |
|---|---|---|
| Starting Lives | 3 | 1–5 |
| Min Players | 3 | 2–10 |
| Max Players | 10 | — |
| Timer Range | 6–18 sec | — |
| Power-Ups | Enabled | — |
## Folder Structure

```
fuse-standalone/
├── server.js          # Complete game server (Node.js + Express + Socket.IO)
├── package.json       # Dependencies
├── README.md          # This file
└── public/
    └── index.html     # Complete mobile-first game UI (vanilla JS)
```

## Tech Stack

- **Backend**: Node.js + Express 4 + Socket.IO 4
- **Frontend**: Vanilla HTML/CSS/JavaScript (no build step needed)
- **Real-time**: WebSockets via Socket.IO

