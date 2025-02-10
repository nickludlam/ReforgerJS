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
      this.logParser = new LogParser(this.config);
      if (!this.logParser) {
        logger.error("LogParser creation failed.");
        return;
      }

      this.logParser.on("event", (eventData) => {
        this.emit("logEvent", eventData);
      });

      // Votekick Start event
      this.logParser.on("voteKickStart", (data) => {
        //logger.verbose(`[voteKickStart event] Raw data: ${JSON.stringify(data)}`);

        if (this.rcon) {
          // Convert incoming playerId to a number
          const playerId = parseInt(data.playerId, 10);

          //logger.verbose(`[voteKickStart event] Current RCON players:\n${JSON.stringify( this.rcon.players, null,2)}`);

          // Attempt to find the player by numeric ID
          const player = this.rcon.players.find((p) => p.id === playerId);

          if (player) {
            const name = player.name || player.uid;
            //logger.verbose(`[voteKickStart event] Found player with ID=${playerId} => name=${player.name}, uid=${player.uid}`);

            if (name) {
              logger.info(`Votekick Started by ${name}`);
              data.playerName = name; // attach to event data
            } else {
              logger.warn(
                `Player found with ID ${playerId} but has no name or UID.`
              );
            }
          } else {
            logger.warn(
              `[voteKickStart event] No matching player for ID ${playerId}. Adding to voteKickStartBuffer.`
            );
            // Add to buffer for retrying
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

        // Attempt to find the player by name
        const player = this.players.find((p) => p.name === playerName);
        if (player) {
          playerUID = player.uid || null;
          if (playerUID) {
            logger.info(
              `Player '${playerName}' (UID: ${playerUID}) has been vote kicked.`
            );
          } else {
            logger.info(`Player '${playerName}' has been vote kicked.`);
          }
        } else {
          logger.info(`Player '${playerName}' has been vote kicked.`);
        }

        this.emit("voteKickVictim", { playerName, group, reason, playerUID });
      });

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
          const existing = this.rcon.players.find(
            (p) => p.name === data.playerName
          );
          if (existing) {
            let updated = false;

            // Update ID if not present
            if (!existing.id && data.playerId) {
              existing.id = parseInt(data.playerId, 10);
              updated = true;
              // logger.verbose(`Updated ID for player: #${existing.number} ${existing.name} - ID: ${existing.id}`);
            }

            // Update UID if not present
            if (!existing.uid && data.playerUid) {
              existing.uid = data.playerUid;
              updated = true;
              // logger.verbose(`Updated UID for player: #${existing.number} ${existing.name} - UID: ${existing.uid}`);
            }

            if (!updated) {
              // logger.verbose(`No updates required for player: #${existing.number} ${existing.name}`);
            }
          } else {
            if (data.playerName && data.playerId && data.playerUid) {
              // Store the new player's id as a number
              this.rcon.players.push({
                name: data.playerName,
                number: parseInt(data.playerId, 10),
                id: parseInt(data.playerId, 10),
                uid: data.playerUid,
                ip: null, // IP might not be available during update
              });
              // logger.verbose(`New player added via update: #${data.playerId} ${data.playerName} - UID: ${data.playerUid}, ID: ${data.playerId}`);
            } else {
              logger.warn(
                `Incomplete playerUpdate data. Skipping. Data: ${JSON.stringify(
                  data
                )}`
              );
            }
          }
        }
        this.emit("playerUpdate", data);
      });

      // *** playerKilled event handler ***
      this.logParser.on("playerKilled", (data) => {
        // Log the incoming event data verbosely
        logger.verbose(
          `[playerKilled event] Received data: ${JSON.stringify(data)}`
        );

        // Check the players list for attacker and victim
        let attackerUID = "missing";
        let victimUID = "missing";

        // If attackerName is "AI", set attackerUID to "AI"
        if (data.attackerName === "AI") {
          attackerUID = "AI";
        } else {
          const attacker = this.players.find(
            (p) => p.name === data.attackerName
          );
          if (attacker) {
            attackerUID = attacker.uid || "missing";
          }
        }

        const victim = this.players.find((p) => p.name === data.victimName);
        if (victim) {
          victimUID = victim.uid || "missing";
        }

        // Prepare the event payload
        const payload = {
          attackerUID,
          attackerName: data.attackerName,
          victimName: data.victimName,
          victimUID,
          friendlyFire: data.friendlyFire,
        };

        logger.verbose(
          `[playerKilled event] Emitting playerKilled with payload: ${JSON.stringify(
            payload
          )}`
        );
        this.emit("playerKilled", payload);

        if (data.friendlyFire) {
          logger.verbose(
            `[playerKilled event] Emitting friendlyTeamKill with payload: ${JSON.stringify(
              payload
            )}`
          );
          this.emit("friendlyTeamKill", payload);
        }
      });

      this.logParser.on("serverHealth", (data) => {
        global.serverFPS = data.fps;
        global.serverMemoryUsage = data.memory;
        global.serverPlayerCount = data.player;
        const memoryMB = (global.serverMemoryUsage / 1024).toFixed(2);
        logger.verbose(
          `Server Health updated: FPS: ${global.serverFPS}, Memory: ${global.serverMemoryUsage} kB (${memoryMB} MB), Player Count: ${global.serverPlayerCount}`
        );
      });

      this.logParser.start();
      logger.info("Log Parser setup complete.");
    } catch (error) {
      logger.error(`Failed to set up Log Parser: ${error.message}`);
    }
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
    logger.verbose(
      `Processing ${this.voteKickStartBuffer.length} buffered voteKick events.`
    );
    const bufferCopy = [...this.voteKickStartBuffer];
    this.voteKickStartBuffer = []; // Clear before processing

    bufferCopy.forEach((data) => {
      if (this.rcon) {
        const playerId = parseInt(data.playerId, 10);
        const player = this.rcon.players.find((p) => p.id === playerId);

        if (player) {
          const name = player.name || player.uid;
          if (name) {
            logger.info(
              `Votekick Started by ${name} (from buffered event) [ID=${playerId}]`
            );
          } else {
            logger.warn(
              `Player found with ID ${playerId} but has no name or UID (buffered event).`
            );
          }
        } else {
          logger.warn(
            `Still no matching player found for playerID ${playerId} (buffered event).`
          );
          // Optionally re-buffer or handle accordingly
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
    logger.warn(
      `Attempting to reconnect to RCON. Attempt ${this.reconnectAttempts}...`
    );

    try {
      this.restartRCON();
      await new Promise((resolve) =>
        setTimeout(resolve, this.currentReconnectDelay)
      );
      this.currentReconnectDelay = Math.min(
        this.currentReconnectDelay * 2,
        this.maxReconnectDelay
      );
    } catch (error) {
      logger.error(
        `Reconnection attempt ${this.reconnectAttempts} failed: ${error.message}`
      );
      await new Promise((resolve) =>
        setTimeout(resolve, this.currentReconnectDelay)
      );
      this.currentReconnectDelay = Math.min(
        this.currentReconnectDelay * 2,
        this.maxReconnectDelay
      );
    }

    this.attemptReconnection();
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
