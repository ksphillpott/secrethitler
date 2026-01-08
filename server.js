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

// Serve static files from public directory
const publicPath = path.join(__dirname, 'public');
console.log('Static files path:', publicPath);
app.use(express.static(publicPath));

// Game state storage
const rooms = new Map();

// Role distribution based on player count
const ROLE_DISTRIBUTION = {
  5: { liberals: 3, fascists: 1, hitler: 1 },
  6: { liberals: 4, fascists: 1, hitler: 1 },
  7: { liberals: 4, fascists: 2, hitler: 1 },
  8: { liberals: 5, fascists: 2, hitler: 1 },
  9: { liberals: 5, fascists: 3, hitler: 1 },
  10: { liberals: 6, fascists: 3, hitler: 1 }
};

// Presidential powers based on player count
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
    player.investigated = false;
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
    
    // Term limits
    if (player.id === room.gameState.lastChancellorId) continue;
    if (aliveCount > 5 && player.id === room.gameState.lastPresidentId) continue;
    
    eligible.push(player.id);
  }
  return eligible;
}

function getNextPresidentId(room) {
  const alivePlayers = room.players.filter(p => p.alive && !p.isSpectator);
  const currentIndex = alivePlayers.findIndex(p => p.id === room.gameState.presidentId);
  const nextIndex = (currentIndex + 1) % alivePlayers.length;
  return alivePlayers[nextIndex].id;
}

function checkWinCondition(room) {
  const { liberalPolicies, fascistPolicies } = room.gameState;
  
  if (liberalPolicies >= 5) {
    return { winner: 'liberal', reason: 'Five Liberal Policies enacted!' };
  }
  if (fascistPolicies >= 6) {
    return { winner: 'fascist', reason: 'Six Fascist Policies enacted!' };
  }
  
  // Hitler assassination checked separately during execution
  // Hitler election checked during chancellor confirmation
  
  return null;
}

function createRoom(hostSocketId) {
  let code;
  do {
    code = generateRoomCode();
  } while (rooms.has(code));

  const room = {
    code,
    hostSocketId,
    players: [],
    spectators: [],
    gameState: null,
    phase: 'lobby', // lobby, night, election, legislative, executive, game-over
    created: Date.now()
  };

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
    presidentOrder: activePlayers.map(p => p.id),
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
    room.gameState.policyDeck = shuffleArray([
      ...room.gameState.policyDeck,
      ...room.gameState.discardPile
    ]);
    room.gameState.discardPile = [];
    return true;
  }
  return false;
}

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Keep-alive ping for Render
  socket.on('ping', () => {
    socket.emit('pong');
  });

  // Host creates a new room
  socket.on('create-room', (callback) => {
    const room = createRoom(socket.id);
    socket.join(room.code);
    socket.roomCode = room.code;
    socket.isHost = true;
    callback({ success: true, roomCode: room.code });
  });

  // Player joins a room
  socket.on('join-room', ({ roomCode, playerName, isSpectator }, callback) => {
    const room = rooms.get(roomCode.toUpperCase());
    
    if (!room) {
      return callback({ error: 'Room not found' });
    }

    if (room.phase !== 'lobby' && !isSpectator) {
      // Check for reconnection
      const existingPlayer = room.players.find(p => p.name === playerName && p.disconnected);
      if (existingPlayer) {
        existingPlayer.socketId = socket.id;
        existingPlayer.disconnected = false;
        socket.join(roomCode);
        socket.roomCode = roomCode;
        socket.playerId = existingPlayer.id;
        
        // Send reconnection data
        callback({ 
          success: true, 
          reconnected: true,
          playerId: existingPlayer.id,
          role: existingPlayer.role,
          team: existingPlayer.team
        });
        
        io.to(room.hostSocketId).emit('player-reconnected', { playerId: existingPlayer.id });
        return;
      }
      
      // Force spectator mode for new joiners during active game
      isSpectator = true;
    }

    if (!isSpectator && room.players.filter(p => !p.isSpectator).length >= 10) {
      return callback({ error: 'Room is full (max 10 players)' });
    }

    const playerId = uuidv4();
    const player = {
      id: playerId,
      socketId: socket.id,
      name: playerName,
      isSpectator: isSpectator || false,
      connected: true,
      disconnected: false
    };

    room.players.push(player);
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.playerId = playerId;

    callback({ success: true, playerId, isSpectator: player.isSpectator });

    // Notify host of new player
    io.to(room.hostSocketId).emit('player-joined', {
      players: room.players.map(p => ({
        id: p.id,
        name: p.name,
        isSpectator: p.isSpectator,
        connected: !p.disconnected
      }))
    });
  });

  // Host starts the game
  socket.on('start-game', (callback) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.hostSocketId !== socket.id) {
      return callback({ error: 'Not authorized' });
    }

    const result = initializeGame(room);
    if (result.error) {
      return callback(result);
    }

    callback({ success: true });

    // Send role information to each player
    const activePlayers = room.players.filter(p => !p.isSpectator);
    const fascists = activePlayers.filter(p => p.team === 'fascist');
    const hitler = activePlayers.find(p => p.role === 'hitler');

    activePlayers.forEach(player => {
      const playerSocket = io.sockets.sockets.get(player.socketId);
      if (playerSocket) {
        let knownInfo = {};
        
        if (player.role === 'fascist') {
          // Fascists know each other and Hitler
          knownInfo = {
            fascists: fascists.map(f => ({ id: f.id, name: f.name, isHitler: f.role === 'hitler' }))
          };
        } else if (player.role === 'hitler' && activePlayers.length <= 6) {
          // Hitler knows fascists in 5-6 player games
          knownInfo = {
            fascists: fascists.filter(f => f.role !== 'hitler').map(f => ({ id: f.id, name: f.name }))
          };
        }

        playerSocket.emit('game-started', {
          role: player.role,
          team: player.team,
          knownInfo,
          playerCount: activePlayers.length
        });
      }
    });

    // Send spectator notification
    room.players.filter(p => p.isSpectator).forEach(spectator => {
      const spectatorSocket = io.sockets.sockets.get(spectator.socketId);
      if (spectatorSocket) {
        spectatorSocket.emit('game-started', { isSpectator: true });
      }
    });

    // Notify host to show night phase
    io.to(room.hostSocketId).emit('phase-change', {
      phase: 'night',
      playerCount: activePlayers.length
    });
  });

  // Night phase complete
  socket.on('night-complete', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.hostSocketId !== socket.id) return;

    room.phase = 'election';
    
    const president = room.players.find(p => p.id === room.gameState.presidentId);
    const eligibleChancellors = getEligibleChancellors(room);

    io.to(room.hostSocketId).emit('phase-change', {
      phase: 'nomination',
      president: { id: president.id, name: president.name },
      eligibleChancellors
    });

    // Notify president to nominate
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

  // President nominates chancellor
  socket.on('nominate-chancellor', ({ chancellorId }, callback) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return callback({ error: 'Room not found' });

    const player = room.players.find(p => p.socketId === socket.id);
    if (!player || player.id !== room.gameState.presidentId) {
      return callback({ error: 'Not the president' });
    }

    const eligible = getEligibleChancellors(room);
    if (!eligible.includes(chancellorId)) {
      return callback({ error: 'Invalid chancellor choice' });
    }

    room.gameState.chancellorId = chancellorId;
    room.gameState.votes = {};
    
    const chancellor = room.players.find(p => p.id === chancellorId);
    const president = room.players.find(p => p.id === room.gameState.presidentId);

    callback({ success: true });

    // Notify all players to vote
    io.to(room.hostSocketId).emit('phase-change', {
      phase: 'voting',
      president: { id: president.id, name: president.name },
      chancellor: { id: chancellor.id, name: chancellor.name }
    });

    room.players.filter(p => p.alive && !p.isSpectator).forEach(p => {
      const playerSocket = io.sockets.sockets.get(p.socketId);
      if (playerSocket) {
        playerSocket.emit('your-turn', {
          action: 'vote',
          president: president.name,
          chancellor: chancellor.name
        });
      }
    });
  });

  // Player votes
  socket.on('cast-vote', ({ vote }, callback) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return callback({ error: 'Room not found' });

    const player = room.players.find(p => p.socketId === socket.id);
    if (!player || !player.alive || player.isSpectator) {
      return callback({ error: 'Cannot vote' });
    }

    room.gameState.votes[player.id] = vote;
    callback({ success: true });

    // Check if all votes are in
    const alivePlayers = room.players.filter(p => p.alive && !p.isSpectator);
    const voteCount = Object.keys(room.gameState.votes).length;

    io.to(room.hostSocketId).emit('vote-cast', {
      voterId: player.id,
      totalVotes: voteCount,
      totalPlayers: alivePlayers.length
    });

    if (voteCount === alivePlayers.length) {
      // Reveal votes
      const votes = room.gameState.votes;
      const jaVotes = Object.values(votes).filter(v => v === 'ja').length;
      const neinVotes = Object.values(votes).filter(v => v === 'nein').length;
      const passed = jaVotes > neinVotes;

      const voteResults = alivePlayers.map(p => ({
        id: p.id,
        name: p.name,
        vote: votes[p.id]
      }));

      io.to(room.hostSocketId).emit('vote-results', {
        votes: voteResults,
        jaVotes,
        neinVotes,
        passed
      });

      // Send to all players
      room.players.forEach(p => {
        const playerSocket = io.sockets.sockets.get(p.socketId);
        if (playerSocket && !p.isSpectator) {
          playerSocket.emit('vote-results', { votes: voteResults, passed });
        }
      });

      if (passed) {
        // Check Hitler election win condition
        if (room.gameState.fascistPolicies >= 3) {
          const chancellor = room.players.find(p => p.id === room.gameState.chancellorId);
          if (chancellor.role === 'hitler') {
            room.phase = 'game-over';
            io.to(room.hostSocketId).emit('game-over', {
              winner: 'fascist',
              reason: 'Hitler was elected Chancellor!',
              players: room.players.filter(p => !p.isSpectator).map(p => ({
                id: p.id,
                name: p.name,
                role: p.role,
                team: p.team
              }))
            });
            return;
          }
        }

        room.gameState.lastPresidentId = room.gameState.presidentId;
        room.gameState.lastChancellorId = room.gameState.chancellorId;
        room.gameState.electionTracker = 0;
        room.phase = 'legislative';

        // Draw policies for president
        reshuffleDeckIfNeeded(room);
        room.gameState.drawnPolicies = room.gameState.policyDeck.splice(0, 3);

        const president = room.players.find(p => p.id === room.gameState.presidentId);
        const presidentSocket = io.sockets.sockets.get(president.socketId);
        
        io.to(room.hostSocketId).emit('phase-change', {
          phase: 'legislative-president',
          president: { id: president.id, name: president.name }
        });

        if (presidentSocket) {
          presidentSocket.emit('your-turn', {
            action: 'discard-policy',
            policies: room.gameState.drawnPolicies
          });
        }
      } else {
        // Election failed
        room.gameState.electionTracker++;
        
        if (room.gameState.electionTracker >= 3) {
          // Chaos - enact top policy
          reshuffleDeckIfNeeded(room);
          const chaosPolicy = room.gameState.policyDeck.shift();
          
          if (chaosPolicy === 'liberal') {
            room.gameState.liberalPolicies++;
          } else {
            room.gameState.fascistPolicies++;
            if (room.gameState.fascistPolicies >= 5) {
              room.gameState.vetoEnabled = true;
            }
          }

          room.gameState.electionTracker = 0;
          room.gameState.lastPresidentId = null;
          room.gameState.lastChancellorId = null;

          io.to(room.hostSocketId).emit('chaos', {
            policy: chaosPolicy,
            liberalPolicies: room.gameState.liberalPolicies,
            fascistPolicies: room.gameState.fascistPolicies
          });

          const winCondition = checkWinCondition(room);
          if (winCondition) {
            room.phase = 'game-over';
            io.to(room.hostSocketId).emit('game-over', {
              ...winCondition,
              players: room.players.filter(p => !p.isSpectator).map(p => ({
                id: p.id,
                name: p.name,
                role: p.role,
                team: p.team
              }))
            });
            return;
          }
        }

        // Move to next president
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
          electionTracker: room.gameState.electionTracker
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

  // President discards a policy
  socket.on('president-discard', ({ discardIndex }, callback) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return callback({ error: 'Room not found' });

    const player = room.players.find(p => p.socketId === socket.id);
    if (!player || player.id !== room.gameState.presidentId) {
      return callback({ error: 'Not the president' });
    }

    const discarded = room.gameState.drawnPolicies.splice(discardIndex, 1)[0];
    room.gameState.discardPile.push(discarded);

    callback({ success: true });

    const chancellor = room.players.find(p => p.id === room.gameState.chancellorId);
    const chancellorSocket = io.sockets.sockets.get(chancellor.socketId);

    io.to(room.hostSocketId).emit('phase-change', {
      phase: 'legislative-chancellor',
      chancellor: { id: chancellor.id, name: chancellor.name }
    });

    if (chancellorSocket) {
      chancellorSocket.emit('your-turn', {
        action: 'enact-policy',
        policies: room.gameState.drawnPolicies,
        vetoEnabled: room.gameState.vetoEnabled
      });
    }
  });

  // Chancellor enacts or vetoes
  socket.on('chancellor-action', ({ action, enactIndex }, callback) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return callback({ error: 'Room not found' });

    const player = room.players.find(p => p.socketId === socket.id);
    if (!player || player.id !== room.gameState.chancellorId) {
      return callback({ error: 'Not the chancellor' });
    }

    if (action === 'veto') {
      if (!room.gameState.vetoEnabled) {
        return callback({ error: 'Veto not enabled' });
      }

      room.gameState.pendingVeto = true;
      callback({ success: true });

      const president = room.players.find(p => p.id === room.gameState.presidentId);
      const presidentSocket = io.sockets.sockets.get(president.socketId);

      io.to(room.hostSocketId).emit('veto-requested', {
        chancellor: { id: player.id, name: player.name }
      });

      if (presidentSocket) {
        presidentSocket.emit('your-turn', {
          action: 'veto-decision'
        });
      }
      return;
    }

    // Enact policy
    const enacted = room.gameState.drawnPolicies.splice(enactIndex, 1)[0];
    room.gameState.discardPile.push(...room.gameState.drawnPolicies);
    room.gameState.drawnPolicies = [];

    if (enacted === 'liberal') {
      room.gameState.liberalPolicies++;
    } else {
      room.gameState.fascistPolicies++;
      if (room.gameState.fascistPolicies >= 5) {
        room.gameState.vetoEnabled = true;
      }
    }

    callback({ success: true });

    io.to(room.hostSocketId).emit('policy-enacted', {
      policy: enacted,
      liberalPolicies: room.gameState.liberalPolicies,
      fascistPolicies: room.gameState.fascistPolicies
    });

    // Check win condition
    const winCondition = checkWinCondition(room);
    if (winCondition) {
      room.phase = 'game-over';
      io.to(room.hostSocketId).emit('game-over', {
        ...winCondition,
        players: room.players.filter(p => !p.isSpectator).map(p => ({
          id: p.id,
          name: p.name,
          role: p.role,
          team: p.team
        }))
      });
      return;
    }

    // Check for presidential power
    if (enacted === 'fascist') {
      const powerIndex = room.gameState.fascistPolicies - 1;
      const power = room.gameState.powerTrack[powerIndex];
      
      if (power) {
        room.phase = 'executive';
        const president = room.players.find(p => p.id === room.gameState.presidentId);
        
        io.to(room.hostSocketId).emit('phase-change', {
          phase: 'executive',
          power,
          president: { id: president.id, name: president.name }
        });

        const presidentSocket = io.sockets.sockets.get(president.socketId);
        if (presidentSocket) {
          let eligibleTargets = room.players.filter(p => 
            p.alive && 
            !p.isSpectator && 
            p.id !== president.id
          );

          if (power === 'investigate') {
            eligibleTargets = eligibleTargets.filter(p => 
              !room.gameState.investigatedPlayers.includes(p.id)
            );
          }

          presidentSocket.emit('your-turn', {
            action: power,
            eligiblePlayers: eligibleTargets.map(p => ({ id: p.id, name: p.name }))
          });
        }
        return;
      }
    }

    // Move to next round
    advanceToNextRound(room);
  });

  // President veto decision
  socket.on('veto-decision', ({ approve }, callback) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return callback({ error: 'Room not found' });

    const player = room.players.find(p => p.socketId === socket.id);
    if (!player || player.id !== room.gameState.presidentId) {
      return callback({ error: 'Not the president' });
    }

    callback({ success: true });

    if (approve) {
      // Veto approved - discard both policies
      room.gameState.discardPile.push(...room.gameState.drawnPolicies);
      room.gameState.drawnPolicies = [];
      room.gameState.electionTracker++;
      room.gameState.pendingVeto = false;

      io.to(room.hostSocketId).emit('veto-approved', {
        electionTracker: room.gameState.electionTracker
      });

      if (room.gameState.electionTracker >= 3) {
        // Chaos
        reshuffleDeckIfNeeded(room);
        const chaosPolicy = room.gameState.policyDeck.shift();
        
        if (chaosPolicy === 'liberal') {
          room.gameState.liberalPolicies++;
        } else {
          room.gameState.fascistPolicies++;
        }

        room.gameState.electionTracker = 0;
        room.gameState.lastPresidentId = null;
        room.gameState.lastChancellorId = null;

        io.to(room.hostSocketId).emit('chaos', {
          policy: chaosPolicy,
          liberalPolicies: room.gameState.liberalPolicies,
          fascistPolicies: room.gameState.fascistPolicies
        });

        const winCondition = checkWinCondition(room);
        if (winCondition) {
          room.phase = 'game-over';
          io.to(room.hostSocketId).emit('game-over', {
            ...winCondition,
            players: room.players.filter(p => !p.isSpectator).map(p => ({
              id: p.id,
              name: p.name,
              role: p.role,
              team: p.team
            }))
          });
          return;
        }
      }

      advanceToNextRound(room);
    } else {
      // Veto rejected - chancellor must enact
      room.gameState.pendingVeto = false;
      
      const chancellor = room.players.find(p => p.id === room.gameState.chancellorId);
      const chancellorSocket = io.sockets.sockets.get(chancellor.socketId);

      io.to(room.hostSocketId).emit('veto-rejected');

      if (chancellorSocket) {
        chancellorSocket.emit('your-turn', {
          action: 'enact-policy',
          policies: room.gameState.drawnPolicies,
          vetoEnabled: false
        });
      }
    }
  });

  // Executive actions
  socket.on('executive-action', ({ action, targetId }, callback) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return callback({ error: 'Room not found' });

    const player = room.players.find(p => p.socketId === socket.id);
    if (!player || player.id !== room.gameState.presidentId) {
      return callback({ error: 'Not the president' });
    }

    const target = room.players.find(p => p.id === targetId);
    if (!target) return callback({ error: 'Invalid target' });

    switch (action) {
      case 'investigate':
        room.gameState.investigatedPlayers.push(targetId);
        callback({ 
          success: true, 
          result: { team: target.team }
        });
        
        io.to(room.hostSocketId).emit('investigation-complete', {
          investigator: player.name,
          target: target.name
        });
        break;

      case 'special-election':
        room.gameState.specialElectionReturnId = getNextPresidentId(room);
        room.gameState.presidentId = targetId;
        
        callback({ success: true });
        
        io.to(room.hostSocketId).emit('special-election', {
          newPresident: { id: target.id, name: target.name }
        });

        const eligibleChancellors = getEligibleChancellors(room);
        
        io.to(room.hostSocketId).emit('phase-change', {
          phase: 'nomination',
          president: { id: target.id, name: target.name },
          eligibleChancellors
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
        return;

      case 'policy-peek':
        reshuffleDeckIfNeeded(room);
        const topThree = room.gameState.policyDeck.slice(0, 3);
        
        callback({ 
          success: true,
          result: { policies: topThree }
        });
        
        io.to(room.hostSocketId).emit('policy-peek-complete', {
          president: player.name
        });
        break;

      case 'execution':
        target.alive = false;
        room.gameState.executedPlayers.push(targetId);
        
        callback({ success: true });
        
        // Check if Hitler was killed
        if (target.role === 'hitler') {
          room.phase = 'game-over';
          io.to(room.hostSocketId).emit('game-over', {
            winner: 'liberal',
            reason: 'Hitler has been assassinated!',
            executedPlayer: { id: target.id, name: target.name },
            players: room.players.filter(p => !p.isSpectator).map(p => ({
              id: p.id,
              name: p.name,
              role: p.role,
              team: p.team
            }))
          });
          return;
        }

        io.to(room.hostSocketId).emit('execution-complete', {
          executedPlayer: { id: target.id, name: target.name }
        });

        // Notify executed player
        const targetSocket = io.sockets.sockets.get(target.socketId);
        if (targetSocket) {
          targetSocket.emit('you-were-executed');
        }
        break;
    }

    advanceToNextRound(room);
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

  // Play again
  socket.on('play-again', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.hostSocketId !== socket.id) return;

    // Reset to lobby
    room.phase = 'lobby';
    room.gameState = null;
    room.players.forEach(p => {
      p.team = null;
      p.role = null;
      p.alive = true;
      p.investigated = false;
    });

    io.to(room.code).emit('return-to-lobby');
    
    io.to(room.hostSocketId).emit('player-joined', {
      players: room.players.map(p => ({
        id: p.id,
        name: p.name,
        isSpectator: p.isSpectator,
        connected: !p.disconnected
      }))
    });
  });

  // Disconnection handling
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    
    const room = rooms.get(socket.roomCode);
    if (!room) return;

    if (socket.isHost) {
      // Host disconnected - notify all players
      io.to(room.code).emit('host-disconnected');
      rooms.delete(room.code);
      return;
    }

    const player = room.players.find(p => p.socketId === socket.id);
    if (player) {
      player.disconnected = true;
      
      io.to(room.hostSocketId).emit('player-disconnected', {
        playerId: player.id,
        playerName: player.name
      });
    }
  });
});

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/host', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'host.html'));
});

app.get('/play', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'player.html'));
});

// Health check for Render
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', rooms: rooms.size });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Secret Hitler server running on port ${PORT}`);
});
