const mysql = require("mysql2/promise");
const { EmbedBuilder } = require("discord.js");

class AltChecker {
  constructor(config) {
    this.config = config;
    this.name = "AltChecker Plugin";
    this.serverInstance = null;
    this.discordClient = null;
    this.channelOrThread = null;
    this.channelId = null;
    this.logAlts = false;
    this.logOnlyOnline = false;
    this.playerIPCache = new Map();
    this.cacheTTL = 5 * 60 * 1000;
  }

  async prepareToMount(serverInstance, discordClient) {
    logger.verbose(`[${this.name}] Preparing to mount...`);
    this.serverInstance = serverInstance;
    this.discordClient = discordClient;
  
    try {
      if (!this.config.connectors || !this.config.connectors.mysql || !this.config.connectors.mysql.enabled) {
        logger.warn(`[${this.name}] MySQL is not enabled in the configuration. Plugin will be disabled.`);
        return;
      }
  
      if (!process.mysqlPool) {
        logger.error(`[${this.name}] MySQL pool is not available. Ensure MySQL is connected before enabling this plugin.`);
        return;
      }
  
      const pluginConfig = this.config.plugins.find(plugin => plugin.plugin === "AltChecker");
      if (!pluginConfig || !pluginConfig.channel) {
        logger.warn(`[${this.name}] Missing 'channel' ID in plugin config. Plugin disabled.`);
        return;
      }
  
      this.channelId = pluginConfig.channel;
      this.logAlts = pluginConfig.logAlts || false;
      this.logOnlyOnline = pluginConfig.logOnlyOnline || false;
  
      const guild = await this.discordClient.guilds.fetch(this.config.connectors.discord.guildId, { cache: true, force: true });
  
      const channelOrThread = await guild.channels.fetch(this.channelId);
      if (!channelOrThread) {
        logger.warn(`[${this.name}] Unable to find channel or thread with ID ${this.channelId}. Plugin disabled.`);
        return;
      }
  
      if (channelOrThread.isThread()) {
        this.channelOrThread = channelOrThread;
      } else if (channelOrThread.isTextBased()) {
        this.channelOrThread = channelOrThread;
      } else {
        logger.warn(`[${this.name}] The specified ID is not a valid text channel or thread. Plugin disabled.`);
        return;
      }
  
      if (!this.channelOrThread.permissionsFor(this.discordClient.user).has("SendMessages")) {
        logger.warn(`[${this.name}] Bot does not have permission to send messages in the channel or thread. Plugin disabled.`);
        return;
      }
  
      this.serverInstance.removeListener("playerJoined", this.handlePlayerJoined);
      this.serverInstance.on("playerJoined", this.handlePlayerJoined.bind(this));
  
      logger.info(`[${this.name}] Initialized and listening to playerJoined events.`);
    } catch (error) {
      logger.error(`[${this.name}] Error during initialization: ${error.stack}`);
    }
  }
  

  async handlePlayerJoined(player) {
    const { playerIP, playerName, beGUID } = player;

    if (!playerIP) {
      logger.warn(`[${this.name}] Player joined without an IP address: ${playerName}`);
      return;
    }

    try {
      // Check cache first
      if (this.playerIPCache.has(playerIP)) {
        logger.verbose(`[${this.name}] Cache hit for IP: ${playerIP}`);
      } else {
        logger.verbose(`[${this.name}] Cache miss for IP: ${playerIP}. Querying database...`);
        const [rows] = await process.mysqlPool.query("SELECT * FROM players WHERE playerIP = ?", [playerIP]);
        this.playerIPCache.set(playerIP, rows);

        // Set timeout to clear cache entry
        setTimeout(() => this.playerIPCache.delete(playerIP), this.cacheTTL);
      }

      const altAccounts = this.playerIPCache.get(playerIP).filter(
        (dbPlayer) => dbPlayer.playerName !== playerName && dbPlayer.beGUID !== beGUID
      );

      if (altAccounts.length === 0) {
        return;
      }

      const playerList = this.serverInstance.players || [];
      const onlineBeGUIDs = new Set(playerList.map((p) => p.beGUID?.trim().toLowerCase()).filter((beGUID) => beGUID));
      let atLeastOneOnline = false;

      altAccounts.forEach((alt) => {
        const normalizedAltBeGUID = alt.beGUID?.trim().toLowerCase();
        if (!normalizedAltBeGUID) {
          alt.online = false;
          return;
        }

        const isOnline = onlineBeGUIDs.has(normalizedAltBeGUID);
        alt.online = isOnline;
        if (isOnline) {
          atLeastOneOnline = true;
        }
      });

      if (this.logOnlyOnline && !atLeastOneOnline) {
        return;
      }

      if (this.logAlts) {
        const embed = new EmbedBuilder()
          .setTitle("Alt Accounts Detected")
          .setDescription(`**Server:** ${this.config.server.name}\n**📡 IP Address:** ${playerIP}`)
          .setColor("#FFA500")
          .addFields(
            { name: "Usernames", value: [`${playerName}`, ...altAccounts.map((alt) => `${alt.playerName || "Unknown"}`)].join("\n"), inline: true },
            { name: "Reforger BE GUID", value: [`${beGUID || "Missing BE GUID"}`, ...altAccounts.map((alt) => `${alt.beGUID || "Missing BE GUID"}`)].join("\n"), inline: true },
            { name: "Online", value: ["Yes", ...altAccounts.map((alt) => (alt.online ? "Yes" : "No"))].join("\n"), inline: true }
          )
          .setFooter({ text: "AltChecker Plugin - ReforgerJS" });

        try {
          await this.channelOrThread.send({ embeds: [embed] });
          logger.info(`[${this.name}] Alt accounts detected and logged for IP: ${playerIP}`);
        } catch (error) {
          logger.error(`[${this.name}] Failed to send embed: ${error.message}`);
        }
      }
    } catch (error) {
      logger.error(`[${this.name}] Error handling playerJoined for '${playerName}': ${error.stack}`);
    }
  }
}

module.exports = AltChecker;
