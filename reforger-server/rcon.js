const { EventEmitter } = require("events");
const BattleEyeClientReforger = require('./rconClient');

const playerLineRegex = /^(\d+)\s*;\s*([a-z0-9-]+)\s*;\s*(.*)$/i;

class Rcon extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.client = null;
    this.isConnected = false;

    // Persistent list of players across multiple queries
    this.players = [];

    // For partial "players" command response
    this.observedPlayers = [];
    this.isGatheringPlayers = false;
    this.gatherTimer = null;
    this.commandTimeout = null;
    this.awaitingPlayersResponse = false;
  }

  /**
   * Start the RCON connection process.
   * If it fails (login error, etc.), we retry after 5s.
   */
  start() {
    logger.info("Attempting to connect to RCON...");
    this.initClient();
    this.client.connect();
  }

  /**
   * Force a reconnect (used if we want to forcibly close & reconnect)
   */
  restart() {
    if (this.client) {
      this.client.close();
    }
    this.isConnected = false;
    // Clear intervals, watchers if any
    // Then start again
    setTimeout(() => this.start(), 2000);
  }

  /**
   * Build the actual BattleEyeClientReforger instance,
   * attach event handlers (login success/fail, error, timeouts, messageHandler, etc.)
   */
  initClient() {
    const { host, rconPort, rconPassword } = this.config.server;
    this.client = new BattleEyeClientReforger(host, rconPort, rconPassword);

    // Called for *any* RCON message from the server
    this.client.messageHandler = (msg) => {
      this.handleRconMessage(msg);
    };

    // Called if the client times out or forcibly closes
    this.client.timeoutHandler = () => {
      logger.warn("RCON connection timed out or closed.");
      this.isConnected = false;
      // Attempt a reconnect
      setTimeout(() => this.start(), 5000);
    };
  }

  /**
   * Send the 'players' command on an interval
   */
  startSendingPlayersCommand(intervalMs = 30000) {
    setInterval(() => {
      if (this.client && this.client.loggedIn && !this.client.error) {
        // Prepare to gather new data
        this.observedPlayers = [];
        this.isGatheringPlayers = false;
        this.awaitingPlayersResponse = true;

        // If no data arrives within 5s, log an error + finalize
        this.commandTimeout = setTimeout(() => {
          logger.warn('No data received for "players" command within 5s');
          this.finalizePlayers();
          this.awaitingPlayersResponse = false;
        }, 5000);

        // Actually send
        this.client.sendCommand("players");
        logger.verbose('Sent "players" command...');
      } else {
        logger.verbose(
          'RCON not logged in or in error state; skipping "players" command.'
        );
      }
    }, intervalMs);
  }

  /**
   * Merging newly observed players into the persistent list:
   * 1) Remove players not in new list
   * 2) Update existing if name/number changed
   * 3) Add new ones
   */
  mergePlayerLists(newList) {
    // Build a map of newList by name
    const newMap = new Map();
    newList.forEach((p) => {
      newMap.set(p.name, p);
    });

    // Filter out old players not in the new list, or update them
    this.players = this.players.filter((existing) => {
      if (!newMap.has(existing.name)) {
        // This player is no longer on the server
        return false;
      } else {
        // Player still on server; update info
        const updated = newMap.get(existing.name);
        existing.id = updated.id;
        existing.uid = updated.uid;
        // remove from newMap so we don't add duplicates
        newMap.delete(existing.name);
        return true;
      }
    });

    // Add any new players
    for (const [, newPlayer] of newMap) {
      this.players.push(newPlayer);
    }
  }

  /**
   * Called when we decide we've gathered all partial "players" data.
   * Merge it, then emit an event.
   */
  finalizePlayers() {
    this.mergePlayerLists(this.observedPlayers);
    // Verbose log of final player list
    //logger.verbose(`Final player list: ${JSON.stringify(this.players, null, 2)}`);

    // Emit an event so that main.js or others can listen
    this.emit("players", this.players);

    // Clean up local partial data
    this.observedPlayers = [];
    this.isGatheringPlayers = false;
    if (this.gatherTimer) {
      clearTimeout(this.gatherTimer);
      this.gatherTimer = null;
    }
  }

  /**
   * Parse lines for "number ; uid ; name" and store them in observedPlayers
   */
  parsePlayersFromMessage(msg) {
    const lines = msg.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = trimmed.match(playerLineRegex);
      if (match) {
        const [, numberStr, uid, name] = match;
        this.observedPlayers.push({
          id: parseInt(numberStr, 10),
          uid,
          name,
        });
      }
    }
  }

  /**
   * Handle every inbound message from the RCON server
   */
  handleRconMessage(msg) {
    //logger.verbose(`RCON says: ${msg}`);

    // If we were waiting for data from the 'players' command,
    // we can cancel the command timeout because we DID get data
    if (this.awaitingPlayersResponse) {
      if (this.commandTimeout) {
        clearTimeout(this.commandTimeout);
        this.commandTimeout = null;
      }
      this.awaitingPlayersResponse = false;
    }

    // Detect lines that indicate we are about to see a players listing
    if (
      /processing command:\s*players/i.test(msg) ||
      /players on server:/i.test(msg)
    ) {
      this.isGatheringPlayers = true;
      // Typically you'd reset observedPlayers here, but if your server
      // outputs lines *before* "players on server:" that contain data,
      // you might want to keep them. We'll keep it simple:
      // this.observedPlayers = [];
    }

    // If we are in the middle of gathering players data, parse lines
    if (this.isGatheringPlayers) {
      this.parsePlayersFromMessage(msg);

      // Debounce to finalize after no new data in 1s
      if (this.gatherTimer) {
        clearTimeout(this.gatherTimer);
      }
      this.gatherTimer = setTimeout(() => {
        this.finalizePlayers();
      }, 1000);
    }
  }
}

module.exports = Rcon;
