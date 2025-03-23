const { EventEmitter } = require("events");
const BattleEyeClientReforger = require('./rconClient');

const playerLineRegex = /^(\d+)\s*;\s*([a-z0-9-]+)\s*;\s*(.*)$/i;

class Rcon extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.client = null;
    this.isConnected = false;
    this.players = [];
    this.observedPlayers = [];
    this.isGatheringPlayers = false;
    this.gatherTimer = null;
    this.commandTimeout = null;
    this.awaitingPlayersResponse = false;
    
    this.consecutiveTimeouts = 0;
    this.maxConsecutiveTimeouts = 3;
    this.playersIntervalTime = 30000; 
    this.playersInterval = null;
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
    
    if (this.playersInterval) {
      clearInterval(this.playersInterval);
      this.playersInterval = null;
    }
    if (this.commandTimeout) {
      clearTimeout(this.commandTimeout);
      this.commandTimeout = null;
    }
    if (this.gatherTimer) {
      clearTimeout(this.gatherTimer);
      this.gatherTimer = null;
    }
  
    setTimeout(() => this.start(), 2000);
  }
  

  /**
   * Build the actual BattleEyeClientReforger instance,
   * attach event handlers (login success/fail, error, timeouts, messageHandler, etc.)
   */
  initClient() {
    const { host, rconPort, rconPassword } = this.config.server;
    this.client = new BattleEyeClientReforger(host, rconPort, rconPassword);
  
    this.client.loginSuccessHandler = () => {
      logger.info("RCON login successful.");
      this.isConnected = true;
      
      if (this.playersIntervalTime && !this.playersInterval) {
        logger.info(`Restarting players command with interval ${this.playersIntervalTime}ms after reconnection`);
        this.startSendingPlayersCommand(this.playersIntervalTime);
      }
      
      this.emit("connect");
    };
  
    this.client.messageHandler = (msg) => {
      this.handleRconMessage(msg);
    };
  
    this.client.timeoutHandler = () => {
      logger.warn("RCON connection timed out or closed.");
      this.isConnected = false;
      setTimeout(() => this.start(), 5000);
    };
  }

  /**
   * Send the 'players' command on an interval
   */
  startSendingPlayersCommand(intervalMs = 30000) {
    if (this.playersInterval) clearInterval(this.playersInterval); 
    this.playersIntervalTime = intervalMs;
    this.playersInterval = setInterval(() => {
      if (this.client && this.client.loggedIn && !this.client.error) {
        this.observedPlayers = [];
        this.isGatheringPlayers = false;
        this.awaitingPlayersResponse = true;
  
        this.commandTimeout = setTimeout(() => {
          logger.warn(`No data received for "players" command within 5s (Consecutive timeouts: ${this.consecutiveTimeouts + 1})`);
          this.finalizePlayers();
          this.awaitingPlayersResponse = false;
          
          this.consecutiveTimeouts++;
          
          if (this.consecutiveTimeouts >= this.maxConsecutiveTimeouts) {
            logger.error(`"players" command failed ${this.consecutiveTimeouts} times in a row. Restarting RCON connection...`);
            this.restart();
            this.consecutiveTimeouts = 0;
          }
        }, 5000);
  
        this.client.sendCommand("players");
        logger.info('Sent "players" command...');
      } else {
        logger.warn(
          'RCON not logged in or in error state; skipping "players" command.'
        );
      }
    }, intervalMs);
  }

  /**
 * Send a custom command to the RCON server
 * @param {string} command - The command to send
 */
sendCustomCommand(command) {
  if (!this.client || !this.client.loggedIn || this.client.error) {
    logger.warn(`Cannot send command: RCON not connected or in error state.`);
    return;
  }

  logger.info(`Sending custom RCON command: ${command}`);
  this.client.sendCommand(command);
}


  /**
   * Merging newly observed players into the persistent list:
   * 1) Remove players not in new list
   * 2) Update existing if name/number changed
   * 3) Add new ones
   */
  mergePlayerLists(newList) {
    const newMap = new Map();
    newList.forEach(p => newMap.set(p.uid, p));
    
    const currentTime = Date.now();
    
    this.players.forEach(existing => {
      if (newMap.has(existing.uid)) {
        const updated = newMap.get(existing.uid);
        existing.id = updated.id;
        existing.name = updated.name;
        existing.lastSeen = currentTime;
        newMap.delete(existing.uid);
      } else {
        if (!existing.lastSeen) {
          existing.lastSeen = currentTime;
        }
      }
    });
    
    for (const [, newPlayer] of newMap) {
      newPlayer.lastSeen = currentTime;
      this.players.push(newPlayer);
    }
    
    const timeout = 120000;
    this.players = this.players.filter(player => 
      (currentTime - (player.lastSeen || 0)) < timeout
    );
  }
  

  /**
   * Called when we decide we've gathered all partial "players" data.
   * Merge it, then emit an event.
   */
  finalizePlayers() {
    this.mergePlayerLists(this.observedPlayers);
    //logger.verbose(`Final player list: ${JSON.stringify(this.players, null, 2)}`);
  logger.verbose(`Player count: ${this.players.length}`);

    this.emit("players", this.players);

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
    if (this.awaitingPlayersResponse) {
      if (this.commandTimeout) {
        clearTimeout(this.commandTimeout);
        this.commandTimeout = null;
      }
      this.awaitingPlayersResponse = false;
      
      this.consecutiveTimeouts = 0;
    }
  
    if (/processing command:\s*players/i.test(msg) || /players on server:/i.test(msg)) {
      this.isGatheringPlayers = true;
    }
  
    if (this.isGatheringPlayers) {
      this.parsePlayersFromMessage(msg);
  
      if (!this.gatherTimer) {
        this.gatherTimer = setTimeout(() => {
          this.finalizePlayers();
          this.gatherTimer = null;
        }, 1000);
      }
    }
  }
  
}

module.exports = Rcon;
