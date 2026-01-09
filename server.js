const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingTimeout: 60000,
  pingInterval: 25000
});

const publicPath = path.join(__dirname, 'public');
console.log('Static files path:', publicPath);
app.use(express.static(publicPath));

const rooms = new Map();

const ROLE_DISTRIBUTION = {
  5: { liberals: 3, fascists: 1, hitler: 1 },
  6: { liberals: 4, fascists: 1, hitler: 1 },
  7: { liberals: 4, fascists: 2, hitler: 1 },
  8: { liberals: 5, fascists: 2, hitler: 1 },
  9: { liberals: 5, fascists: 3, hitler: 1 },
  10: { liberals: 6, fascists: 3, hitler: 1 }
};

const PRESIDENTIAL_POWERS = {
  '5-6': [null, null, 'policy-peek', 'execution', 'execution'],
  '7-8': [null, 'investigate', 'special-election', 'execution', 'execution'],
  '9-10': ['investigate', 'investigate', 'special-election', 'execution', 'execution']
};

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function shuffleArray(array) {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function createPolicyDeck() {
  const deck = [];
  for (let i = 0; i < 6; i++) deck.push('liberal');
  for (let i = 0; i < 11; i++) deck.push('fascist');
  return shuffleArray(deck);
}

function assignRoles(players) {
  const count = players.length;
  const distribution = ROLE_DISTRIBUTION[count];
  if (!distribution) return null;

  const roles = [];
  for (let i = 0; i < distribution.liberals; i++) roles.push({ team: 'liberal', role: 'liberal' });
  for (let i = 0; i < distribution.fascists; i++) roles.push({ team: 'fascist', role: 'fascist' });
  roles.push({ team: 'fascist', role: 'hitler' });

  const shuffledRoles = shuffleArray(roles);
  players.forEach((player, index) => {
    player.team = shuffledRoles[index].team;
    player.role = shuffledRoles[index].role;
    player.alive = true;
  });

  return players;
}

function getPowerTrack(playerCount) {
  if (playerCount <= 6) return PRESIDENTIAL_POWERS['5-6'];
  if (playerCount <= 8) return PRESIDENTIAL_POWERS['7-8'];
  return PRESIDENTIAL_POWERS['9-10'];
}

function getEligibleChancellors(room) {
  const eligible = [];
  const alivePlayers = room.players.filter(p => p.alive && !p.isSpectator);
  const aliveCount = alivePlayers.length;

  for (const player of alivePlayers) {
    if (player.id === room.gameState.presidentId) continue;
    if (player.id === room.gameState.lastChancellorId) continue;
    if (aliveCount > 5 && player.id === room.gameState.lastPresidentId) continue;
    eligible.push(player.id);
  }
  return eligible;
}

function getNextPresidentId(room) {
  const order = room.gameState.presidentOrder;
  const currentId = room.gameState.presidentId;
  const currentOrderIndex = order.indexOf(currentId);
  
  for (let i = 1; i <= order.length; i++) {
    const nextIndex = (currentOrderIndex + i) % order.length;
    const nextId = order[nextIndex];
    const nextPlayer = room.players.find(p => p.id === nextId);
    if (nextPlayer && nextPlayer.alive && !nextPlayer.isSpectator) {
      return nextId;
    }
  }
  return room.players.find(p => p.alive && !p.isSpectator)?.id;
}

function checkWinCondition(room) {
  const { liberalPolicies, fascistPolicies } = room.gameState;
  if (liberalPolicies >= 5) return { winner: 'liberal', reason: 'Five Liberal Policies enacted!' };
  if (fascistPolicies >= 6) return { winner: 'fascist', reason: 'Six Fascist Policies enacted!' };
  return null;
}

function createRoom(hostSocketId) {
  let code;
  do { code = generateRoomCode(); } while (rooms.has(code));
  const room = { code, hostSocketId, players: [], gameState: null, phase: 'lobby', created: Date.now() };
  rooms.set(code, room);
  return room;
}

function initializeGame(room) {
  const activePlayers = room.players.filter(p => !p.isSpectator);
  if (activePlayers.length < 5 || activePlayers.length > 10) {
    return { error: 'Need 5-10 players to start' };
  }

  assignRoles(activePlayers);
  
  const firstPresidentIndex = Math.floor(Math.random() * activePlayers.length);
  const firstPresident = activePlayers[firstPresidentIndex];
  
  const presidentOrder = [];
  for (let i = 0; i < activePlayers.length; i++) {
    const index = (firstPresidentIndex + i) % activePlayers.length;
    presidentOrder.push(activePlayers[index].id);
  }

  room.gameState = {
    policyDeck: createPolicyDeck(),
    discardPile: [],
    liberalPolicies: 0,
    fascistPolicies: 0,
    electionTracker: 0,
    presidentId: firstPresident.id,
    chancellorId: null,
    lastPresidentId: null,
    lastChancellorId: null,
    presidentOrder,
    votes: {},
    drawnPolicies: [],
    vetoEnabled: false,
    specialElectionReturnId: null,
    powerTrack: getPowerTrack(activePlayers.length),
    investigatedPlayers: [],
    executedPlayers: []
  };

  room.phase = 'night';
  return { success: true };
}

function reshuffleDeckIfNeeded(room) {
  if (room.gameState.policyDeck.length < 3) {
    room.gameState.policyDeck = shuffleArray([...room.gameState.policyDeck, ...room.gameState.discardPile]);
    room.gameState.discardPile = [];
    return true;
  }
  return false;
}

function broadcastGameOver(room, winData) {
  room.phase = 'game-over';
  const gameOverData = {
    ...winData,
    players: room.players.filter(p => !p.isSpectator).map(p => ({ id: p.id, name: p.name, role: p.role, team: p.team }))
  };
  io.to(room.hostSocketId).emit('game-over', gameOverData);
  room.players.forEach(p => {
    const s = io.sockets.sockets.get(p.socketId);
    if (s) s.emit('game-over', gameOverData);
  });
}

function broadcastPlayerList(room) {
  const playerList = {
    players: room.players.map(p => ({ id: p.id, name: p.name, isSpectator: p.isSpectator, connected: !p.disconnected }))
  };
  io.to(room.hostSocketId).emit('player-joined', playerList);
  room.players.forEach(p => {
    const s = io.sockets.sockets.get(p.socketId);
    if (s) s.emit('player-joined', playerList);
  });
}

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('ping', () => socket.emit('pong'));

  socket.on('create-room', (callback) => {
    const room = createRoom(socket.id);
    socket.join(room.code);
    socket.roomCode = room.code;
    socket.isHost = true;
    callback({ success: true, roomCode: room.code });
  });

  socket.on('join-room', ({ roomCode, playerName, isSpectator }, callback) => {
    const code = roomCode.toUpperCase();
    const room = rooms.get(code);
    
    if (!room) return callback({ error: 'Room not found' });

    if (room.phase === 'lobby') {
      const existingPlayer = room.players.find(p => p.name.toLowerCase() === playerName.toLowerCase());
      if (existingPlayer) return callback({ error: 'Name already taken' });
    }

    if (room.phase !== 'lobby' && !isSpectator) {
      const existingPlayer = room.players.find(p => p.name.toLowerCase() === playerName.toLowerCase() && p.disconnected);
      if (existingPlayer) {
        existingPlayer.socketId = socket.id;
        existingPlayer.disconnected = false;
        socket.join(code);
        socket.roomCode = code;
        socket.playerId = existingPlayer.id;
        callback({ success: true, reconnected: true, playerId: existingPlayer.id, role: existingPlayer.role, team: existingPlayer.team, alive: existingPlayer.alive });
        io.to(room.hostSocketId).emit('player-reconnected', { playerId: existingPlayer.id });
        return;
      }
      isSpectator = true;
    }

    if (!isSpectator && room.players.filter(p => !p.isSpectator).length >= 10) {
      return callback({ error: 'Room is full (max 10 players)' });
    }

    const playerId = uuidv4();
    const player = { id: playerId, socketId: socket.id, name: playerName, isSpectator: isSpectator || false, connected: true, disconnected: false, alive: true };
    room.players.push(player);
    socket.join(code);
    socket.roomCode = code;
    socket.playerId = playerId;

    callback({ success: true, playerId, isSpectator: player.isSpectator });
    broadcastPlayerList(room);
  });

  socket.on('start-game', (callback) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return callback({ error: 'Room not found' });
    if (room.phase !== 'lobby') return callback({ error: 'Game already started' });

    const result = initializeGame(room);
    if (result.error) return callback(result);

    callback({ success: true });

    const activePlayers = room.players.filter(p => !p.isSpectator);
    const fascists = activePlayers.filter(p => p.team === 'fascist');

    activePlayers.forEach(player => {
      const playerSocket = io.sockets.sockets.get(player.socketId);
      if (playerSocket) {
        let knownInfo = {};
        if (player.role === 'fascist') {
          knownInfo = { fascists: fascists.map(f => ({ id: f.id, name: f.name, isHitler: f.role === 'hitler' })) };
        } else if (player.role === 'hitler' && activePlayers.length <= 6) {
          knownInfo = { fascists: fascists.filter(f => f.role !== 'hitler').map(f => ({ id: f.id, name: f.name })) };
        }
        playerSocket.emit('game-started', { role: player.role, team: player.team, knownInfo, playerCount: activePlayers.length });
      }
    });

    room.players.filter(p => p.isSpectator).forEach(spectator => {
      const s = io.sockets.sockets.get(spectator.socketId);
      if (s) s.emit('game-started', { isSpectator: true });
    });

    io.to(room.hostSocketId).emit('phase-change', { phase: 'night', playerCount: activePlayers.length });
  });

  socket.on('night-complete', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.hostSocketId !== socket.id) return;

    room.phase = 'election';
    const president = room.players.find(p => p.id === room.gameState.presidentId);
    const eligibleChancellors = getEligibleChancellors(room);

    io.to(room.hostSocketId).emit('phase-change', {
      phase: 'nomination',
      president: { id: president.id, name: president.name },
      eligibleChancellors,
      electionTracker: room.gameState.electionTracker,
      deckCount: room.gameState.policyDeck.length
    });

    const presidentSocket = io.sockets.sockets.get(president.socketId);
    if (presidentSocket) {
      presidentSocket.emit('your-turn', {
        action: 'nominate-chancellor',
        eligiblePlayers: eligibleChancellors.map(id => {
          const p = room.players.find(pl => pl.id === id);
          return { id: p.id, name: p.name };
        })
      });
    }
  });

  socket.on('nominate-chancellor', ({ chancellorId }, callback) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return callback({ error: 'Room not found' });

    const player = room.players.find(p => p.socketId === socket.id);
    if (!player || player.id !== room.gameState.presidentId) return callback({ error: 'Not the president' });

    const eligible = getEligibleChancellors(room);
    if (!eligible.includes(chancellorId)) return callback({ error: 'Invalid chancellor choice' });

    room.gameState.chancellorId = chancellorId;
    room.gameState.votes = {};
    
    const chancellor = room.players.find(p => p.id === chancellorId);
    const president = room.players.find(p => p.id === room.gameState.presidentId);

    callback({ success: true });

    io.to(room.hostSocketId).emit('phase-change', {
      phase: 'voting',
      president: { id: president.id, name: president.name },
      chancellor: { id: chancellor.id, name: chancellor.name }
    });

    room.players.filter(p => p.alive && !p.isSpectator).forEach(p => {
      const s = io.sockets.sockets.get(p.socketId);
      if (s) s.emit('your-turn', { action: 'vote', president: president.name, chancellor: chancellor.name });
    });
  });

  socket.on('cast-vote', ({ vote }, callback) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return callback({ error: 'Room not found' });

    const player = room.players.find(p => p.socketId === socket.id);
    if (!player || !player.alive || player.isSpectator) return callback({ error: 'Cannot vote' });

    room.gameState.votes[player.id] = vote;
    callback({ success: true });

    const alivePlayers = room.players.filter(p => p.alive && !p.isSpectator);
    const voteCount = Object.keys(room.gameState.votes).length;

    io.to(room.hostSocketId).emit('vote-cast', { voterId: player.id, totalVotes: voteCount, totalPlayers: alivePlayers.length });

    if (voteCount === alivePlayers.length) {
      const votes = room.gameState.votes;
      const jaVotes = Object.values(votes).filter(v => v === 'ja').length;
      const neinVotes = Object.values(votes).filter(v => v === 'nein').length;
      const passed = jaVotes > neinVotes;

      const voteResults = alivePlayers.map(p => ({ id: p.id, name: p.name, vote: votes[p.id] }));

      io.to(room.hostSocketId).emit('vote-results', { votes: voteResults, jaVotes, neinVotes, passed });
      room.players.forEach(p => {
        const s = io.sockets.sockets.get(p.socketId);
        if (s) s.emit('vote-results', { votes: voteResults, passed });
      });

      if (passed) {
        if (room.gameState.fascistPolicies >= 3) {
          const chancellor = room.players.find(p => p.id === room.gameState.chancellorId);
          if (chancellor.role === 'hitler') {
            broadcastGameOver(room, { winner: 'fascist', reason: 'Hitler was elected Chancellor!' });
            return;
          }
        }

        room.gameState.lastPresidentId = room.gameState.presidentId;
        room.gameState.lastChancellorId = room.gameState.chancellorId;
        room.gameState.electionTracker = 0;
        room.phase = 'legislative';

        reshuffleDeckIfNeeded(room);
        room.gameState.drawnPolicies = room.gameState.policyDeck.splice(0, 3);

        const president = room.players.find(p => p.id === room.gameState.presidentId);
        io.to(room.hostSocketId).emit('phase-change', { phase: 'legislative-president', president: { id: president.id, name: president.name } });

        const presidentSocket = io.sockets.sockets.get(president.socketId);
        if (presidentSocket) presidentSocket.emit('your-turn', { action: 'discard-policy', policies: room.gameState.drawnPolicies });
      } else {
        room.gameState.electionTracker++;
        
        if (room.gameState.electionTracker >= 3) {
          reshuffleDeckIfNeeded(room);
          const chaosPolicy = room.gameState.policyDeck.shift();
          
          if (chaosPolicy === 'liberal') room.gameState.liberalPolicies++;
          else {
            room.gameState.fascistPolicies++;
            if (room.gameState.fascistPolicies >= 5) room.gameState.vetoEnabled = true;
          }

          room.gameState.electionTracker = 0;
          room.gameState.lastPresidentId = null;
          room.gameState.lastChancellorId = null;

          io.to(room.hostSocketId).emit('chaos', { policy: chaosPolicy, liberalPolicies: room.gameState.liberalPolicies, fascistPolicies: room.gameState.fascistPolicies });

          const winCondition = checkWinCondition(room);
          if (winCondition) { broadcastGameOver(room, winCondition); return; }
        }

        if (room.gameState.specialElectionReturnId) {
          room.gameState.presidentId = room.gameState.specialElectionReturnId;
          room.gameState.specialElectionReturnId = null;
        } else {
          room.gameState.presidentId = getNextPresidentId(room);
        }

        const nextPresident = room.players.find(p => p.id === room.gameState.presidentId);
        const eligibleChancellors = getEligibleChancellors(room);

        io.to(room.hostSocketId).emit('phase-change', {
          phase: 'nomination',
          president: { id: nextPresident.id, name: nextPresident.name },
          eligibleChancellors,
          electionTracker: room.gameState.electionTracker,
          deckCount: room.gameState.policyDeck.length
        });

        const presidentSocket = io.sockets.sockets.get(nextPresident.socketId);
        if (presidentSocket) {
          presidentSocket.emit('your-turn', {
            action: 'nominate-chancellor',
            eligiblePlayers: eligibleChancellors.map(id => {
              const p = room.players.find(pl => pl.id === id);
              return { id: p.id, name: p.name };
            })
          });
        }
      }
    }
  });

  socket.on('president-discard', ({ discardIndex }, callback) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return callback({ error: 'Room not found' });

    const player = room.players.find(p => p.socketId === socket.id);
    if (!player || player.id !== room.gameState.presidentId) return callback({ error: 'Not the president' });
    if (discardIndex < 0 || discardIndex >= room.gameState.drawnPolicies.length) return callback({ error: 'Invalid index' });

    const discarded = room.gameState.drawnPolicies.splice(discardIndex, 1)[0];
    room.gameState.discardPile.push(discarded);
    callback({ success: true });

    const chancellor = room.players.find(p => p.id === room.gameState.chancellorId);
    io.to(room.hostSocketId).emit('phase-change', { phase: 'legislative-chancellor', chancellor: { id: chancellor.id, name: chancellor.name } });

    const chancellorSocket = io.sockets.sockets.get(chancellor.socketId);
    if (chancellorSocket) chancellorSocket.emit('your-turn', { action: 'enact-policy', policies: room.gameState.drawnPolicies, vetoEnabled: room.gameState.vetoEnabled });
  });

  socket.on('chancellor-action', ({ action, enactIndex }, callback) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return callback({ error: 'Room not found' });

    const player = room.players.find(p => p.socketId === socket.id);
    if (!player || player.id !== room.gameState.chancellorId) return callback({ error: 'Not the chancellor' });

    if (action === 'veto') {
      if (!room.gameState.vetoEnabled) return callback({ error: 'Veto not enabled' });

      room.gameState.pendingVeto = true;
      callback({ success: true });

      const president = room.players.find(p => p.id === room.gameState.presidentId);
      io.to(room.hostSocketId).emit('veto-requested', { chancellor: { id: player.id, name: player.name } });

      const presidentSocket = io.sockets.sockets.get(president.socketId);
      if (presidentSocket) presidentSocket.emit('your-turn', { action: 'veto-decision' });
      return;
    }

    if (enactIndex < 0 || enactIndex >= room.gameState.drawnPolicies.length) return callback({ error: 'Invalid index' });

    const enacted = room.gameState.drawnPolicies.splice(enactIndex, 1)[0];
    room.gameState.discardPile.push(...room.gameState.drawnPolicies);
    room.gameState.drawnPolicies = [];

    if (enacted === 'liberal') room.gameState.liberalPolicies++;
    else {
      room.gameState.fascistPolicies++;
      if (room.gameState.fascistPolicies >= 5) room.gameState.vetoEnabled = true;
    }

    callback({ success: true });
    io.to(room.hostSocketId).emit('policy-enacted', { policy: enacted, liberalPolicies: room.gameState.liberalPolicies, fascistPolicies: room.gameState.fascistPolicies });

    const winCondition = checkWinCondition(room);
    if (winCondition) { broadcastGameOver(room, winCondition); return; }

    if (enacted === 'fascist') {
      const powerIndex = room.gameState.fascistPolicies - 1;
      const power = room.gameState.powerTrack[powerIndex];
      
      if (power) {
        room.phase = 'executive';
        const president = room.players.find(p => p.id === room.gameState.presidentId);
        io.to(room.hostSocketId).emit('phase-change', { phase: 'executive', power, president: { id: president.id, name: president.name } });

        const presidentSocket = io.sockets.sockets.get(president.socketId);
        if (presidentSocket) {
          let eligibleTargets = room.players.filter(p => p.alive && !p.isSpectator && p.id !== president.id);
          if (power === 'investigate') eligibleTargets = eligibleTargets.filter(p => !room.gameState.investigatedPlayers.includes(p.id));
          presidentSocket.emit('your-turn', { action: power, eligiblePlayers: eligibleTargets.map(p => ({ id: p.id, name: p.name })) });
        }
        return;
      }
    }

    advanceToNextRound(room);
  });

  socket.on('veto-decision', ({ approve }, callback) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return callback({ error: 'Room not found' });

    const player = room.players.find(p => p.socketId === socket.id);
    if (!player || player.id !== room.gameState.presidentId) return callback({ error: 'Not the president' });

    callback({ success: true });

    if (approve) {
      room.gameState.discardPile.push(...room.gameState.drawnPolicies);
      room.gameState.drawnPolicies = [];
      room.gameState.electionTracker++;
      room.gameState.pendingVeto = false;

      io.to(room.hostSocketId).emit('veto-approved', { electionTracker: room.gameState.electionTracker });

      if (room.gameState.electionTracker >= 3) {
        reshuffleDeckIfNeeded(room);
        const chaosPolicy = room.gameState.policyDeck.shift();
        
        if (chaosPolicy === 'liberal') room.gameState.liberalPolicies++;
        else room.gameState.fascistPolicies++;

        room.gameState.electionTracker = 0;
        room.gameState.lastPresidentId = null;
        room.gameState.lastChancellorId = null;

        io.to(room.hostSocketId).emit('chaos', { policy: chaosPolicy, liberalPolicies: room.gameState.liberalPolicies, fascistPolicies: room.gameState.fascistPolicies });

        const winCondition = checkWinCondition(room);
        if (winCondition) { broadcastGameOver(room, winCondition); return; }
      }

      advanceToNextRound(room);
    } else {
      room.gameState.pendingVeto = false;
      const chancellor = room.players.find(p => p.id === room.gameState.chancellorId);
      io.to(room.hostSocketId).emit('veto-rejected');
      const chancellorSocket = io.sockets.sockets.get(chancellor.socketId);
      if (chancellorSocket) chancellorSocket.emit('your-turn', { action: 'enact-policy', policies: room.gameState.drawnPolicies, vetoEnabled: false });
    }
  });

  socket.on('executive-action', ({ action, targetId }, callback) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return callback({ error: 'Room not found' });

    const player = room.players.find(p => p.socketId === socket.id);
    if (!player || player.id !== room.gameState.presidentId) return callback({ error: 'Not the president' });

    if (action === 'policy-peek') {
      reshuffleDeckIfNeeded(room);
      const topThree = room.gameState.policyDeck.slice(0, 3);
      callback({ success: true, result: { policies: topThree } });
      io.to(room.hostSocketId).emit('policy-peek-complete', { president: player.name });
      advanceToNextRound(room);
      return;
    }

    const target = room.players.find(p => p.id === targetId);
    if (!target) return callback({ error: 'Invalid target' });

    switch (action) {
      case 'investigate':
        room.gameState.investigatedPlayers.push(targetId);
        callback({ success: true, result: { team: target.team } });
        io.to(room.hostSocketId).emit('investigation-complete', { investigator: player.name, target: target.name });
        advanceToNextRound(room);
        break;

      case 'special-election':
        room.gameState.specialElectionReturnId = getNextPresidentId(room);
        room.gameState.presidentId = targetId;
        callback({ success: true });
        io.to(room.hostSocketId).emit('special-election', { newPresident: { id: target.id, name: target.name } });

        const eligibleChancellors = getEligibleChancellors(room);
        io.to(room.hostSocketId).emit('phase-change', {
          phase: 'nomination',
          president: { id: target.id, name: target.name },
          eligibleChancellors,
          electionTracker: room.gameState.electionTracker,
          deckCount: room.gameState.policyDeck.length
        });

        const newPresidentSocket = io.sockets.sockets.get(target.socketId);
        if (newPresidentSocket) {
          newPresidentSocket.emit('your-turn', {
            action: 'nominate-chancellor',
            eligiblePlayers: eligibleChancellors.map(id => {
              const p = room.players.find(pl => pl.id === id);
              return { id: p.id, name: p.name };
            })
          });
        }
        break;

      case 'execution':
        target.alive = false;
        room.gameState.executedPlayers.push(targetId);
        callback({ success: true });
        
        if (target.role === 'hitler') {
          broadcastGameOver(room, { winner: 'liberal', reason: 'Hitler has been assassinated!', executedPlayer: { id: target.id, name: target.name } });
          return;
        }

        io.to(room.hostSocketId).emit('execution-complete', { executedPlayer: { id: target.id, name: target.name } });
        const targetSocket = io.sockets.sockets.get(target.socketId);
        if (targetSocket) targetSocket.emit('you-were-executed');
        advanceToNextRound(room);
        break;
        
      default:
        callback({ error: 'Unknown action' });
    }
  });

  function advanceToNextRound(room) {
    if (room.gameState.specialElectionReturnId) {
      room.gameState.presidentId = room.gameState.specialElectionReturnId;
      room.gameState.specialElectionReturnId = null;
    } else {
      room.gameState.presidentId = getNextPresidentId(room);
    }

    room.phase = 'election';
    const nextPresident = room.players.find(p => p.id === room.gameState.presidentId);
    if (!nextPresident) { console.error('No next president found'); return; }
    
    const eligibleChancellors = getEligibleChancellors(room);

    io.to(room.hostSocketId).emit('phase-change', {
      phase: 'nomination',
      president: { id: nextPresident.id, name: nextPresident.name },
      eligibleChancellors,
      electionTracker: room.gameState.electionTracker,
      deckCount: room.gameState.policyDeck.length
    });

    const presidentSocket = io.sockets.sockets.get(nextPresident.socketId);
    if (presidentSocket) {
      presidentSocket.emit('your-turn', {
        action: 'nominate-chancellor',
        eligiblePlayers: eligibleChancellors.map(id => {
          const p = room.players.find(pl => pl.id === id);
          return { id: p.id, name: p.name };
        })
      });
    }
  }

  socket.on('play-again', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.hostSocketId !== socket.id) return;

    room.phase = 'lobby';
    room.gameState = null;
    room.players.forEach(p => { p.team = null; p.role = null; p.alive = true; });

    io.to(room.code).emit('return-to-lobby');
    broadcastPlayerList(room);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    const room = rooms.get(socket.roomCode);
    if (!room) return;

    if (socket.isHost) {
      io.to(room.code).emit('host-disconnected');
      rooms.delete(room.code);
      return;
    }

    const player = room.players.find(p => p.socketId === socket.id);
    if (player) {
      player.disconnected = true;
      io.to(room.hostSocketId).emit('player-disconnected', { playerId: player.id, playerName: player.name });
    }
  });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/play', (req, res) => res.sendFile(path.join(__dirname, 'public', 'player.html')));
app.get('/health', (req, res) => res.status(200).json({ status: 'ok', rooms: rooms.size }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Secret Hitler server running on port ${PORT}`));
