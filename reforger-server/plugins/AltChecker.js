const { EmbedBuilder } = require("discord.js");
const logger = require("../logger/logger");
const { escapeMarkdown } = require('../../helpers');

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
    this.whitelistBEGUIDs = new Set();
    this.playerIPCache = new Map();
    this.lastBroadcastTime = new Map(); // Store the last broadcast time for each player
    this.mostRecentBEGUIDsAnnounced = new Set();
    this.broadcastSuppressionInterval = 10 * 60 * 1000; // rate limit broadcasts to every 10 minutes
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
      this.whitelistBEGUIDs = pluginConfig.whitelistBEGUIDs ? new Set(pluginConfig.whitelistBEGUIDs.map(guid => guid.toLowerCase())) : this.whitelistBEGUIDs;
      if (this.whitelistBEGUIDs.size > 0) {
        logger.info(`[${this.name}] Loaded ${this.whitelistBEGUIDs.size} whitelist BE GUIDs.`);
      }
  
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
  
      const permissions = await this.channelOrThread.permissionsFor(this.discordClient.user)
      if (permissions === null || !permissions.has("SendMessages")) {
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
    try {
      // If the timestamp is invalid or more than 5 seconds old, ignore it
      if (player.time && (Date.now() - player.time.getTime() > 5000)) {
        return;
      }
    } catch (error) {
      logger.error(`[${this.name}] Error checking player time for '${player?.name}': ${error.stack}`);
      // Also dump the player object for debugging
      logger.verbose(`[${this.name}] Player object: ${JSON.stringify(player, null, 2)}`);
      // Log if player.time is a valid Date object
      if (player.time && !(player.time instanceof Date)) {
        logger.warn(`[${this.name}] player.time is not a valid Date object: ${player.time}`);
        logger.warn(`[${this.name}] player.time type: ${typeof player.time}`);
      }
      // 
      return;
    }

    try {
      const { playerIP, playerName, beGUID } = player;

      if (!playerIP) {
        logger.warn(`[${this.name}] Player joined without an IP address: ${playerName}`);
        return;
      }

      // Early out by checking if the player is in the whitelist
      if (this.whitelistBEGUIDs.size > 0 && this.whitelistBEGUIDs.has(beGUID.toLowerCase())) {
        logger.verbose(`[${this.name}] Player ${playerName} is in the whitelist. Skipping alt check.`);
        return;
      }

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

      // Now populate the lastBroadcastTime for the player and the alts
      const allPlayerBEGUIDs = [beGUID, ...altAccounts.map((alt) => alt.beGUID)];

      // Check this.mostRecentBEGUIDsAnnounced to see if ALL of the BE GUIDs have been announced in the most recent broadcast
      const allBEGUIDsAnnounced = allPlayerBEGUIDs.every((guid) => this.mostRecentBEGUIDsAnnounced.has(guid));
      if (allBEGUIDsAnnounced) {
        logger.verbose(`[${this.name}] All BE GUIDs have been announced recently. Suppressing broadcast.`);
        return;
      }
      // Update this.mostRecentBEGUIDsAnnounced with the current BE GUIDs
      this.mostRecentBEGUIDsAnnounced = new Set(allPlayerBEGUIDs);

      // Now check the lastBroadcastTime for each BE GUID
      const currentTime = Date.now();
      allPlayerBEGUIDs.forEach((guid) => {
        if (this.lastBroadcastTime.has(guid)) {
          const lastTime = this.lastBroadcastTime.get(guid);
          if (currentTime - lastTime < this.broadcastSuppressionInterval) {
            logger.verbose(`[${this.name}] Suppressing broadcast for ${guid} due to interval.`);
            return;
          }
        }
        this.lastBroadcastTime.set(guid, currentTime);
      });

      if (this.logAlts) {
        const embed = new EmbedBuilder()
          .setTitle("Alt Accounts Detected")
          .setDescription(`**Server:** ${this.config.server.name}\n**📡 IP Address:** ${playerIP}`)
          .setColor("#FFA500")
          .addFields(
            { name: "Usernames", value: [`${escapeMarkdown(playerName)}`, ...altAccounts.map((alt) => `${escapeMarkdown(alt.playerName) || "Unknown"}`)].join("\n"), inline: true },
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
      logger.error(`[${this.name}] Error handling playerJoined for '${player?.name}': ${error.stack}`);
    }
  }
}

module.exports = AltChecker;
