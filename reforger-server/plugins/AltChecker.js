const { EmbedBuilder } = require("discord.js");
const logger = require("../logger/logger");
const { escapeMarkdown } = require('../../helpers');
const BattlemetricsSync = require("./BattlemetricsSync");

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
    this.playerIPCacheTTL = 5 * 60 * 1000; // 5 minutes

    this.lastBroadcastTime = new Map(); // Store the last broadcast time for each player
    this.broadcastSuppressionIntervalMinutes = 20 * 60 * 1000; // rate limit broadcasts to every 10 minutes

    this.recentAnnounceCacheTTL = 60 * 60 * 1000; // 60 minutes
    this.recentAnnouncePurgeInterval = null;

    this.roleNotificationId = null; // If we should send a notification to the Discord team 

    this.battleMetricsSyncPlugin = null;
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
  
      const bmPlugin = serverInstance.pluginInstances.find((plugin) => plugin instanceof BattlemetricsSync);
      if (bmPlugin) {
        this.battleMetricsSyncPlugin = bmPlugin;
        logger.verbose(`[${this.name}] Found BattlemetricsSync plugin instance.`);
      }

      this.roleNotificationId = pluginConfig.roleNotificationId || null;

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

  periodicPugeOldCacheEntries() {
    // Purge old entries every 30 minutes
    this.recentAnnouncePurgeInterval = setInterval(() => {
      this.purgeOldCacheEntries();
    }, this.recentAnnounceCacheTTL);
    logger.verbose(`[${this.name}] Periodic purge of old cache entries set to every ${this.recentAnnounceCacheTTL / 60000} minutes.`);
  }

  purgeOldCacheEntries() {
    const now = Date.now();
    // Now purge old entries from lastBroadcastTime
    for (const [guid, lastTime] of this.lastBroadcastTime.entries()) {
      // Check if the last broadcast time is older than the suppression interval
      if (now - lastTime > this.recentAnnounceCacheTTL) {
        this.lastBroadcastTime.delete(guid);
        logger.verbose(`[${this.name}] Purged last broadcast time for BE GUID: ${guid}`);
      }
    }
  }
  
  async handlePlayerJoined(player) {
    try {
      // If the timestamp is invalid or more than 1 minute old, ignore it
      if (player.time && (Date.now() - player.time.getTime() > 60000)) {
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
        setTimeout(() => this.playerIPCache.delete(playerIP), this.playerIPCacheTTL);
      }

      const altAccounts = this.playerIPCache.get(playerIP).filter(
        (dbPlayer) => dbPlayer.playerName !== playerName && dbPlayer.beGUID !== beGUID
      );

      if (altAccounts.length === 0) {
        return;
      }

      // get a list of the reforger UUIDs for the altAccounts
      const reforgerIDs = altAccounts.map((alt) => alt.playerUID).filter((uid) => uid);

      const bans = [];
      if (this.battleMetricsSyncPlugin) {
        logger.verbose(`[${this.name}] Fetching bans for alt accounts of player ${playerName} with IP ${playerIP} using reforger UUIDs: ${reforgerIDs.join(", ")}`);
        // Fetch bans for the reforger UUIDs
        const fetchedBans = await this.battleMetricsSyncPlugin.getBanByReforgerUUIDs(reforgerIDs);
        if (fetchedBans && fetchedBans.length > 0) {
          bans.push(...fetchedBans);
          logger.info(`[${this.name}] Found ${fetchedBans.length} bans for alt accounts of player ${playerName} with IP ${playerIP}.`);
        }
      } else {
        logger.warn(`[${this.name}] BattlemetricsSync plugin is not available. Cannot fetch bans for alt accounts.`);
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

      // Now check the lastBroadcastTime for each BE GUID, and suppress the broadcast if it was sent within the suppression interval
      const currentTime = Date.now();
      allPlayerBEGUIDs.forEach((guid) => {
        if (this.lastBroadcastTime.has(guid)) {
          const lastTime = this.lastBroadcastTime.get(guid);
          if (currentTime - lastTime < this.broadcastSuppressionIntervalMinutes) {
            logger.verbose(`[${this.name}] Suppressing broadcast for ${guid} due to interval.`);
            this.lastBroadcastTime.set(guid, currentTime); // Update the last broadcast time
            return;
          } else {
            this.lastBroadcastTime.set(guid, currentTime);
          }
        }
      });

      const title = bans.length > 0 ? `🚨 Potential Ban Evasion Detected 🚨` : `Potential Alt Accounts Detected`;
      var description = `**Server:** ${this.config.server.name}\n**📡 IP Address:** ${playerIP}`

      if (bans.length > 0) {
        // Get the oldest ban, which is at the end, and add to the description
        const lastBan = bans[-1];
        // now fetch the player name using the identifier of the ban
        const bannedPlayerName = altAccounts.find((alt) => alt.beGUID === lastBan.identifier)?.playerName || "Unknown";
        const link = lastBan.identifier ? `https://www.battlemetrics.com/rcon/players?filter%5Bsearch%5D=${lastBan.identifier}&method=quick&redirect=1` : "No link available";

        description += `\n\n**Oldest Ban:** ${bannedPlayerName}`
        description += `\n**Reason:** ${lastBan.reason || "No reason provided"}`;
        description += `\n**Expires At:** ${lastBan.expiresAt ? lastBan.expiresAt.toISOString() : "Never"}`;
        description += `\n**Link:** ${link})`;
      }

      const fields = [
        { name: "Usernames", value: [`${escapeMarkdown(playerName)}`, ...altAccounts.map((alt) => `${escapeMarkdown(alt.playerName) || "Unknown"}`)].join("\n"), inline: true },
        { name: "BE GUID", value: [`${beGUID || "Missing BE GUID"}`, ...altAccounts.map((alt) => `${alt.beGUID || "Missing BE GUID"}`)].join("\n"), inline: true },
        { name: "Online", value: ["Yes", ...altAccounts.map((alt) => (alt.online ? "Yes" : "No"))].join("\n"), inline: true }
      ]

      var teamPingMessage = null;
      if (bans.length > 0) {
        const roleMention = `<@&${this.roleNotificationId}>`;
        teamPingMessage = `${roleMention} Attention! Potential ban evasion detected by player **${escapeMarkdown(playerName)}** with IP **${playerIP}**. Please investigate.`;
      }

      if (this.logAlts) {
        const embed = new EmbedBuilder()
          .setTitle(title)
          .setDescription(description)
          .setColor("#FFA500")
          .addFields(fields)
          .setFooter({ text: "EXD ReforgerJS customised by Bewilderbeest" });

        try {
          if (bans.length === 0) {
            await this.channelOrThread.send({ embeds: [embed] });
          } else {
            await this.channelOrThread.send({ embeds: [embed], content: teamPingMessage });
          }

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
