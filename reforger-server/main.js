const { EventEmitter } = require("events");
const Rcon = require("./rcon");
const LogParser = require("./log-parser/index");

// Global values accessible from other parts of the code
global.serverPlayerCount = 0;
global.serverFPS = 0;
global.serverMemoryUsage = 0;

class ReforgerServer extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.players = [];
    this.rcon = null;
    this.logParser = null;
    this.voteKickStartBuffer = [];
    this.bufferTimeout = 3000;
    this.isReconnecting = false;
    this.maxReconnectAttempts = Infinity;
    this.reconnectAttempts = 0;
    this.initialReconnectDelay = 5000;
    this.maxReconnectDelay = 60000;
    this.currentReconnectDelay = this.initialReconnectDelay;
  }

  setupRCON() {
    try {
      if (this.rcon) {
        this.rcon.removeAllListeners();
      }
      
      this.rcon = new Rcon(this.config);

      this.rcon.on("connect", () => { 
        logger.info("RCON connected successfully.");
        this.isReconnecting = false;
        this.reconnectAttempts = 0;
        this.currentReconnectDelay = this.initialReconnectDelay;
      });

      this.rcon.on("error", (err) => { 
        logger.error(`RCON error: ${err.message}`);
      });

      this.rcon.on("close", () => { 
        logger.warn("RCON connection closed.");
        this.handleRconDisconnection();
      });

      this.rcon.on("players", (updatedPlayers) => { 
        this.players = updatedPlayers; 
        this.emit("players", this.players);
      });

      logger.info("RCON setup complete.");
    } catch (error) {
      logger.error(`Failed to set up RCON: ${error.message}`);
      this.handleRconDisconnection();
    }
  }

  connectRCON() {
    if (!this.rcon) {
      logger.error("RCON is not initialized. Call setupRCON() first.");
      return;
    }
    this.rcon.start();
  }

  restartRCON() {
    if (!this.rcon) {
      logger.error("RCON is not initialized. Call setupRCON() first.");
      return;
    }
    logger.warn("Restarting RCON...");
    this.rcon.restart();
  }

  startSendingPlayersCommand(interval = 30000) {
    if (!this.rcon) {
      logger.error("RCON is not initialized. Call setupRCON() first.");
      return;
    }
    this.rcon.startSendingPlayersCommand(interval);
  }

  setupLogParser() {
    try {
      if (this.logParser) {
        this.logParser.removeAllListeners();
        this.logParser.unwatch();
      }

      this.logParser = new LogParser("console.log", this.config.server);
      if (!this.logParser) {
        logger.error("LogParser creation failed.");
        return;
      }

      this.setupLogParserEventHandlers();
      
      this.logParser.watch();
      logger.info("Log Parser setup complete.");
    } catch (error) {
      logger.error(`Failed to set up Log Parser: ${error.message}`);
    }
  }

  setupLogParserEventHandlers() {
    // General log events
    this.logParser.on("event", (eventData) => {
      this.emit("logEvent", eventData);
    });

    // Vote kick events
    this.setupVoteKickEventHandlers();

    // Player-related events
    this.setupPlayerEventHandlers();

    // Server health events
    this.logParser.on("serverHealth", (data) => {
      global.serverFPS = data.fps;
      global.serverMemoryUsage = data.memory;
      global.serverPlayerCount = data.player;
      const memoryMB = (global.serverMemoryUsage / 1024).toFixed(2);
      //logger.verbose(`Server Health updated: FPS: ${global.serverFPS}, Memory: ${global.serverMemoryUsage} kB (${memoryMB} MB), Player Count: ${global.serverPlayerCount}`);
    });

    // Game state events
    this.setupGameStateEventHandlers();
  }

  setupVoteKickEventHandlers() {
    // Votekick Start event
    this.logParser.on("voteKickStart", (data) => {
      if (this.rcon) {
        const playerId = parseInt(data.playerId, 10);
        const player = this.rcon.players.find((p) => p.id === playerId);

        if (player) {
          const name = player.name || player.uid;
          if (name) {
            logger.info(`Votekick Started by ${name}`);
            data.playerName = name;
          } else {
            logger.warn(`Player found with ID ${playerId} but has no name or UID.`);
          }
        } else {
          logger.warn(
            `[voteKickStart event] No matching player for ID ${playerId}. Adding to voteKickStartBuffer.`
          );
          this.voteKickStartBuffer.push(data);
          setTimeout(() => {
            this.processVoteKickStartBuffer();
          }, this.bufferTimeout);
        }
      }
      this.emit("voteKickStart", data);
    });

    // Handle voteKickVictim event
    this.logParser.on("voteKickVictim", (data) => {
      const { playerName, group, reason } = data;
      let playerUID = null;

      const player = this.players.find((p) => p.name === playerName);
      if (player) {
        playerUID = player.uid || null;
        if (playerUID) {
          logger.info(`Player '${playerName}' (UID: ${playerUID}) has been vote kicked.`);
        } else {
          logger.info(`Player '${playerName}' has been vote kicked.`);
        }
      } else {
        logger.info(`Player '${playerName}' has been vote kicked.`);
      }
      this.emit("voteKickVictim", { playerName, group, reason, playerUID });
    });
  }

  setupPlayerEventHandlers() {
    this.logParser.on("playerJoined", (data) => {
      const { playerName, playerIP, playerNumber, beGUID } = data;
      if (this.rcon) {
        const existing = this.rcon.players.find((p) => p.name === playerName);
        if (existing) {
          existing.ip = playerIP;
          if (beGUID) existing.beGUID = beGUID;
        } else {
          const newPlayer = {
            name: playerName,
            number: playerNumber,
            ip: playerIP,
          };
          if (beGUID) newPlayer.beGUID = beGUID;
          this.rcon.players.push(newPlayer);
        }
      }
      this.emit("playerJoined", data);
    });

    this.logParser.on("playerUpdate", (data) => {
      if (this.rcon) {
        const existing = this.rcon.players.find((p) => p.name === data.playerName);
        if (existing) {
          let updated = false;
          if (!existing.id && data.playerId) {
            existing.id = parseInt(data.playerId, 10);
            updated = true;
          }
          if (!existing.uid && data.playerUid) {
            existing.uid = data.playerUid;
            updated = true;
          }
        } else {
          if (data.playerName && data.playerId && data.playerUid) {
            this.rcon.players.push({
              name: data.playerName,
              id: parseInt(data.playerId, 10),
              uid: data.playerUid,
              ip: null,
            });
          } else {
            logger.warn(
              `Incomplete playerUpdate data. Skipping. Data: ${JSON.stringify(data)}`
            );
          }
        }
      }
      this.emit("playerUpdate", data);
    });

    this.logParser.on("playerKilled", (data) => {
      logger.verbose(`[playerKilled event] Received data: ${JSON.stringify(data)}`);

      let attackerUID = "missing";
      let victimUID = "missing";

      if (data.attackerName === "AI") {
        attackerUID = "AI";
      } else {
        const attacker = this.players.find((p) => p.name === data.attackerName);
        if (attacker) {
          attackerUID = attacker.uid || "missing";
        }
      }

      const victim = this.players.find((p) => p.name === data.victimName);
      if (victim) {
        victimUID = victim.uid || "missing";
      }

      const payload = {
        attackerUID,
        attackerName: data.attackerName,
        victimName: data.victimName,
        victimUID,
        friendlyFire: data.friendlyFire,
      };

      logger.verbose(
        `[playerKilled event] Emitting playerKilled with payload: ${JSON.stringify(payload)}`
      );
      this.emit("playerKilled", payload);

      if (data.friendlyFire) {
        logger.verbose(
          `[playerKilled event] Emitting friendlyTeamKill with payload: ${JSON.stringify(payload)}`
        );
        this.emit("friendlyTeamKill", payload);
      }
    });
  }

  setupGameStateEventHandlers() {
    // Game Start event
    this.logParser.on("gameStart", (data) => {
      logger.info(`Game started at ${data.time}`);
      this.emit("gameStart", data);
    });

    // Game End event
    this.logParser.on("gameEnd", (data) => {
      logger.info(`Game ended at ${data.time}`);
      this.emit("gameEnd", data);
    });
  }

  handleRconDisconnection() {
    if (this.isReconnecting) {
      return;
    }
    this.isReconnecting = true;
    this.reconnectAttempts = 0;
    this.currentReconnectDelay = this.initialReconnectDelay;
    this.attemptReconnection();
  }

  processVoteKickStartBuffer() {
    const currentTime = Date.now();
    
    this.voteKickStartBuffer = this.voteKickStartBuffer.filter(event => {
      return (currentTime - event.timestamp) < 1800000; // 30 minutes
    });

    logger.verbose(`Processing ${this.voteKickStartBuffer.length} buffered voteKick events.`);

    const bufferCopy = [...this.voteKickStartBuffer];
    this.voteKickStartBuffer = [];

    bufferCopy.forEach((data) => {
      if (this.rcon) {
        const playerId = parseInt(data.playerId, 10);
        const player = this.rcon.players.find((p) => p.id === playerId);

        if (player) {
          logger.info(`Votekick Started by ${player.name || player.uid} (buffered) [ID=${playerId}]`);
        } else {
          logger.warn(`Still no matching player for ID ${playerId} (buffered event).`);
        }
      }
      this.emit("voteKickStart", data);
    });
  }

  async attemptReconnection() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error("Max RCON reconnection attempts reached. Giving up.");
      return;
    }

    this.reconnectAttempts += 1;
    logger.warn(`Attempting to reconnect to RCON. Attempt ${this.reconnectAttempts}...`);

    try {
      this.restartRCON();
      this.currentReconnectDelay = Math.min(this.currentReconnectDelay * 2, this.maxReconnectDelay);
    } catch (error) {
      logger.error(`Reconnection attempt ${this.reconnectAttempts} failed: ${error.message}`);
    }

    setTimeout(() => {
      this.attemptReconnection(); 
    }, this.currentReconnectDelay);
  }

  initialize() {
    try {
      this.setupRCON();
      this.connectRCON();
      this.setupLogParser();
      logger.info("ReforgerServer initialized successfully.");
    } catch (error) {
      logger.error(`Failed to initialize ReforgerServer: ${error.message}`);
      throw error;
    }
  }
}

module.exports = ReforgerServer;