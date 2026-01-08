# Secret Hitler Online

A Jackbox-style web implementation of the popular social deduction game Secret Hitler. One device hosts the main display (TV/monitor), while players join from their phones using a room code.

## Features

- **Jackbox-style gameplay**: Host displays on TV, players use phones as controllers
- **5-10 players supported**: Proper role distribution for all player counts
- **Full game mechanics**:
  - Secret role assignment (Liberal/Fascist/Hitler)
  - Night phase with proper information sharing based on player count
  - Voting system with simultaneous reveal
  - Legislative sessions (President discards 1, Chancellor enacts 1)
  - All presidential powers (Investigate, Special Election, Policy Peek, Execution)
  - Veto power after 5 Fascist policies
  - Election tracker with chaos mechanic
- **Spectator mode**: Late joiners or observers can watch
- **Reconnection support**: Disconnected players can rejoin
- **Audio feedback**: Sound effects for key game events
- **Faithful aesthetic**: Propaganda poster style matching the original game

## Deployment on Render

### Quick Deploy

1. Push this code to a GitHub repository
2. Create a new Web Service on Render
3. Connect your repository
4. Use these settings:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Environment**: Node

### render.yaml (Blueprint)

A `render.yaml` file is included for automatic configuration.

## Local Development

```bash
# Install dependencies
npm install

# Start the server
npm start

# Or with auto-reload (development)
npm run dev
```

The server runs on `http://localhost:3000` by default.

## How to Play

### Setup

1. **Host**: Open the game on a TV/computer and go to "Host a Game"
2. **Players**: On their phones, go to "Join a Game" and enter the room code
3. Wait for 5-10 players to join
4. Any player can tap "Start Game" once enough players have joined

### Gameplay

1. **Night Phase**: Fascists (and Hitler in small games) identify each other
2. **Election**: President nominates Chancellor, everyone votes
3. **Legislative Session**: If elected, President and Chancellor enact a policy
4. **Executive Action**: Some Fascist policies grant the President special powers
5. **Win Conditions**:
   - Liberals win: 5 Liberal policies OR kill Hitler
   - Fascists win: 6 Fascist policies OR elect Hitler as Chancellor after 3+ Fascist policies

### Presidential Powers (varies by player count)

| Players | Slot 1 | Slot 2 | Slot 3 | Slot 4 | Slot 5 |
|---------|--------|--------|--------|--------|--------|
| 5-6     | -      | -      | Peek   | Kill   | Kill   |
| 7-8     | -      | Investigate | Election | Kill | Kill |
| 9-10    | Investigate | Investigate | Election | Kill | Kill |

## Tech Stack

- **Backend**: Node.js, Express, Socket.IO
- **Frontend**: Vanilla HTML/CSS/JS
- **Real-time**: WebSocket communication
- **Styling**: Custom CSS with propaganda poster aesthetic

## Credits

Based on the board game **Secret Hitler** by Mike Boxleiter, Tommy Maranges, and Mac Schubert.

Licensed under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)

## License

This implementation is also licensed under CC BY-NC-SA 4.0 per the original game's license requirements.
