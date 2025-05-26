const { EventEmitter } = require("events");
const Rcon = require("./rcon");
const LogParser = require("./log-parser/index");
const logger = require("./logger/logger");

global.serverPlayerCount = 0;
global.serverFPS = 0;
global.serverMemoryUsage = 0;
global.serverLastGameStartTime = null;
global.serverDataLastUpdatedAt = null;

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
    this.pluginInstances = [];
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
      global.serverDataLastUpdatedAt = Date.now();
      // const memoryMB = (global.serverMemoryUsage / 1024).toFixed(2);
      //logger.verbose(`Server Health updated: FPS: ${global.serverFPS}, Memory: ${global.serverMemoryUsage} kB (${memoryMB} MB), Player Count: ${global.serverPlayerCount}`);
    });

    // Game state events
    this.setupGameStateEventHandlers();
  }

  setupVoteKickEventHandlers() {
    // Votekick Start event
    this.logParser.on("voteKickStart", (data) => {
      logger.info(`Votekick Started by ${data.voteOffenderName} (ID: ${data.voteOffenderId}) against ${data.voteVictimName} (ID: ${data.voteVictimId})`);
      
      this.emit("voteKickStart", data);
    });

    // Handle voteKickVictim event
    this.logParser.on("voteKickVictim", (data) => {
      logger.info(`Vote kick succeeded against player '${data.voteVictimName}' (ID: ${data.voteVictimId})`);
      
      this.emit("voteKickVictim", data);
    });
  }

  // Emitted playerJoined event data structure example:
  // {
  //   name: "Player1",
  //   number: 1,
  //   ip: "1.2.3.4",
  //   beGUID: "1234567890abcdef",
  //   steamID: "76561198012345678",
  //   device: "PC"
  // }

  setupPlayerEventHandlers() {
    this.logParser.on("playerJoined", (data) => {
      const { playerName, playerIP, playerNumber, beGUID, steamID, device } = data;
      if (this.rcon) {
        const existing = this.rcon.players.find((p) => p.name === playerName);
        if (existing) {
          existing.ip = playerIP;
          if (beGUID) existing.beGUID = beGUID;
          if (steamID !== undefined) existing.steamID = steamID;
          if (device !== undefined) existing.device = device;
        } else {
          const newPlayer = {
            name: playerName,
            number: playerNumber,
            ip: playerIP,
          };
          if (beGUID) newPlayer.beGUID = beGUID;
          if (steamID !== undefined) newPlayer.steamID = steamID;
          if (device !== undefined) newPlayer.device = device;
          this.rcon.players.push(newPlayer);
        }
      }
      // logger.verbose(`Player joined: ${playerName} (#${playerNumber}) from ${playerIP} - Device: ${device || 'Unknown'}, SteamID: ${steamID || 'None'}, BE GUID: ${beGUID || 'Unknown'}`);
      this.emit("playerJoined", data);
    });

    // Emitted playerDisconnected event data structure example:
    // {
    //    name: "Player1",
    //    number: 1,
    //    ip: "1.2.3.4",
    //    uid: "1234567890abcdef",
    //    beGUID: "1234567890abcdef",
    //    steamID: "76561198012345678",
    //    device: "PC"
    // }
    
    // Don't do this, as we use rcon for live player tracking, and let this players array 
    // time players out differently
    //
    // this.logParser.on("playerDisconnected", (data) => {
    //   const { playerName } = data;
    //   if (this.rcon) {
    //     const playerIndex = this.rcon.players.findIndex((p) => p.name === playerName);
    //     if (playerIndex !== -1) {
    //       const removedPlayer = this.rcon.players.splice(playerIndex, 1)[0];
    //       // add the removePlayer information to data
    //       data.name = removedPlayer.name || null;
    //       data.number = removedPlayer.number || null;
    //       data.ip = removedPlayer.ip || null;
    //       data.uid = removedPlayer.uid || null;
    //       data.beGUID = removedPlayer.beGUID || null;
    //       data.steamID = removedPlayer.steamID || null;
    //       data.device = removedPlayer.device || null;
    //     } else {
    //       logger.warn(`Player disconnected but not found in RCON players list: ${playerName}`);
    //     }
    //   } else {
    //     logger.warn(`Player disconnected but RCON is not initialized: ${playerName}`);
    //   }
    //   this.emit("playerDisconnected", data);
    // });

    // Emitted playerUpdate event data structure example:
    // {
    //    name: "Player1",
    //    number: 1,
    //    ip: "1.2.3.4",
    //    uid: "1234567890abcdef",
    //    beGUID: "1234567890abcdef",
    //    steamID: "76561198012345678",
    //    device: "PC"
    // }

    this.logParser.on("playerUpdate", (data) => {
      if (this.rcon) {
        const existing = this.rcon.players.find((p) => p.name === data.playerName);
        if (existing) {
          if (!existing.id && data.playerId) {
            existing.id = parseInt(data.playerId, 10);
          }
          if (!existing.uid && data.playerUid) {
            existing.uid = data.playerUid;
          }
          // it comes with time, playerId, playerName, playerUid
          // We convert them to the existing player object

          data.name = data.playerName || existing.name || null;
          data.uid = existing.uid || null;
          data.ip = existing.ip || null;
          data.beGUID = existing.beGUID || null;
          data.steamID = existing.steamID || null;
          data.device = existing.device || null;

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
  }

  setupGameStateEventHandlers() {
    // Game Start event
    this.logParser.on("gameStart", (data) => {
      logger.info(`Game started at ${data.time}`);
      global.serverLastGameStartTime = data.time;
      this.emit("gameStart", data);
    });

    // Game End event
    this.logParser.on("gameEnd", (data) => {
      logger.info(`Game ended at ${data.time}`);
      this.emit("gameEnd", data);
    });
  }

  // Listen to the pluginInstance for an event and re-emit it
  registerPluginEvent(event, pluginInstance) {
    pluginInstance.on(event, (data) => {
      logger.verbose(`Rebroadcasting event '${event}' from plugin '${pluginInstance.name || 'Unnamed Plugin'}'`);
      this.emit(event, data);
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
      return (currentTime - event.time) < 1800000;
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
      this.rcon.removeAllListeners('connect');
      
      this.rcon.once('connect', () => {
        logger.info("RCON reconnected successfully in ReforgerServer.");
        this.isReconnecting = false;
        this.reconnectAttempts = 0;
        this.currentReconnectDelay = this.initialReconnectDelay;
        
        if (this.rcon.playersIntervalTime && !this.rcon.playersInterval) {
          logger.info(`Ensuring players command is restarted from ReforgerServer`);
          this.rcon.startSendingPlayersCommand(this.rcon.playersIntervalTime);
        }
      });
      
      this.restartRCON();
      
      this.currentReconnectDelay = Math.min(this.currentReconnectDelay * 2, this.maxReconnectDelay);
    } catch (error) {
      logger.error(`Reconnection attempt ${this.reconnectAttempts} failed: ${error.message}`);
    }
  
    if (this.isReconnecting) {
      setTimeout(() => {
        this.attemptReconnection(); 
      }, this.currentReconnectDelay);
    }
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