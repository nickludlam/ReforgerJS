const mysql = require("mysql2/promise");

class VoteLogs {
  constructor(config) {
    this.config = config;
    this.name = "VoteLogs Plugin";
    this.isInitialized = false;
    this.serverInstance = null;
  }

  async prepareToMount(serverInstance) {
    await this.cleanup();
    this.serverInstance = serverInstance;

    try {
      if (
        !this.config.connectors ||
        !this.config.connectors.mysql ||
        !this.config.connectors.mysql.enabled
      ) {
        return;
      }

      if (!process.mysqlPool) {
        return;
      }

      const pluginConfig = this.config.plugins.find(
        (plugin) => plugin.plugin === "VoteLogs"
      );
      if (!pluginConfig || !pluginConfig.enabled) {
        return;
      }

      await this.setupSchema();
      
      this.serverInstance.on("voteKickStart", this.handleVoteKickStart.bind(this));
      this.serverInstance.on("voteKickVictim", this.handleVoteKickVictim.bind(this));
      
      this.isInitialized = true;
      logger.info("VoteLogs plugin initialized");
    } catch (error) {
      logger.error(`Error initializing VoteLogs plugin: ${error}`);
    }
  }

  async setupSchema() {
    const createVoteOffendersTable = `
      CREATE TABLE IF NOT EXISTS VoteOffenders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        offenderName VARCHAR(255) NULL,
        offenderUID VARCHAR(255) NULL,
        victimName VARCHAR(255) NULL,
        victimUID VARCHAR(255) NULL,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_offender_victim (offenderUID, victimUID)
      );
    `;

    const createVoteVictimsTable = `
      CREATE TABLE IF NOT EXISTS VoteVictims (
        id INT AUTO_INCREMENT PRIMARY KEY,
        victimName VARCHAR(255) NULL,
        victimUID VARCHAR(255) NULL,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_victim (victimUID)
      );
    `;

    try {
      const connection = await process.mysqlPool.getConnection();
      await connection.query(createVoteOffendersTable);
      await connection.query(createVoteVictimsTable);
      connection.release();
      logger.verbose("VoteLogs database schema setup complete");
    } catch (error) {
      logger.error(`Error setting up VoteLogs schema: ${error}`);
      throw error;
    }
  }

  findPlayerUID(playerName, playerId) {
    if (!this.serverInstance || !this.serverInstance.players || !Array.isArray(this.serverInstance.players)) {
      return null;
    }

    const player = this.serverInstance.players.find(
      (p) => (p.name === playerName && p.id?.toString() === playerId?.toString())
    );

    if (player && player.uid) {
      logger.verbose(`Found player ${playerName} with exact match by name and ID`);
      return player.uid;
    }

    const playerByName = this.serverInstance.players.find(p => p.name === playerName);
    if (playerByName && playerByName.uid) {
      logger.verbose(`Found player ${playerName} by name only`);
      return playerByName.uid;
    }

    const playerById = this.serverInstance.players.find(p => p.id?.toString() === playerId?.toString());
    if (playerById && playerById.uid) {
      logger.verbose(`Found player with ID ${playerId} by ID only`);
      return playerById.uid;
    }

    logger.warn(`Could not find UID for player name: ${playerName}, ID: ${playerId}`);
    return null;
  }

  async handleVoteKickStart(data) {
    if (!data || !data.voteOffenderName || !data.voteVictimName) {
      logger.warn("Insufficient data for vote kick start logging");
      return;
    }

    try {
      const time = data.time ? new Date(data.time) : null;
      // If this is more than 5 seconds in the past, ignore it
      if (time && time.getTime() < Date.now() - 5000) {
        logger.warn("Vote kick start time is more than 5 seconds in the past, ignoring");
        return;
      }

      const offenderName = data.voteOffenderName || null;
      const offenderId = data.voteOffenderId || null;
      const victimName = data.voteVictimName || null;
      const victimId = data.voteVictimId || null;
      
      const offenderUID = this.findPlayerUID(offenderName, offenderId);
      const victimUID = this.findPlayerUID(victimName, victimId);
    
      const insertQuery = `
        INSERT INTO VoteOffenders 
        (offenderName, offenderUID, victimName, victimUID, timestamp)
        VALUES (?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP));
      `;

      await process.mysqlPool.query(insertQuery, [
        offenderName,
        offenderUID,
        victimName,
        victimUID,
        time
      ]);
      
      logger.info(`Vote kick initiated by ${offenderName} against ${victimName} logged to database`);
    } catch (error) {
      logger.error(`Error logging vote kick start: ${error}`);
    }
  }

  async handleVoteKickVictim(data) {
    if (!data || !data.voteVictimName) {
      logger.warn("Insufficient data for vote kick victim logging");
      return;
    }

    try {
      const victimName = data.voteVictimName || null;
      const victimId = data.voteVictimId || null;
      
      const victimUID = this.findPlayerUID(victimName, victimId);

      if (victimName) {
        const insertQuery = `
          INSERT INTO VoteVictims 
          (victimName, victimUID)
          VALUES (?, ?);
        `;

        await process.mysqlPool.query(insertQuery, [
          victimName,
          victimUID
        ]);
        
        logger.info(`Vote kick succeeded against ${victimName} logged to database`);
      }
    } catch (error) {
      logger.error(`Error logging vote kick victim: ${error}`);
    }
  }

  async cleanup() {
    if (this.serverInstance) {
      this.serverInstance.removeAllListeners("voteKickStart");
      this.serverInstance.removeAllListeners("voteKickVictim");
      this.serverInstance = null;
    }
    this.isInitialized = false;
    logger.verbose("VoteLogs plugin cleanup complete");
  }
}

module.exports = VoteLogs;