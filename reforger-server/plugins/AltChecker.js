const { EmbedBuilder } = require("discord.js");
const logger = require("../logger/logger");
const { escapeMarkdown } = require('../../helpers');
const BattlemetricsSync = require("./BattlemetricsSync");
// const { classifyUserQueryInfo } = require("../../helpers");

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

    // this.steamAPIKey = null;
    // this.vacBanCache = new Map(); // Cache for VAC bans
    // this.vacBanCacheTTL = 48 * 60 * 60 * 100 // 48 hours
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

      // if (pluginConfig.steamAPIKey) {
      //   this.steamAPIKey = pluginConfig.steamAPIKey;
      //   logger.info(`[${this.name}] Using provided Steam API key for VAC ban queries.`);
      // } else {
      //   logger.warn(`[${this.name}] No Steam API key provided. VAC ban queries will not be available.`);
      // }
  
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


  // async querySteamAPIForVACBans(steamIDs) {
  //   if (!this.steamAPIKey) {
  //     logger.warn(`[${this.name}] No Steam API key provided. VAC ban query will not be performed.`);
  //     return null;
  //   }

  //   // Validate the steamIDs array
  //   if (!Array.isArray(steamIDs) || steamIDs.length === 0) {
  //     logger.warn(`[${this.name}] No valid Steam IDs provided for VAC ban query.`);
  //     return null;
  //   }

  //   // use classifyUserQueryInfo on each element of the array to ensure they are all valid steamIDs
  //   const validSteamIDs = steamIDs.filter(steamID => {
  //     const type = classifyUserQueryInfo(steamID);
  //     if (type === 'steamID') {
  //       return true;
  //     } else {
  //       logger.warn(`[${this.name}] Invalid Steam ID provided: ${steamID}. Expected format is 7656119[0-9]{10}.`);
  //       return false;
  //     }
  //   });

  //   if (validSteamIDs.length != steamIDs.length) {
  //     logger.warn(`[${this.name}] Some Steam IDs were invalid and will be excluded from the query.`);
  //   }

  //   // First concatenate the steamIDs into a comma-separated string
  //   const steamIDString = validSteamIDs.join(",");
  //   logger.verbose(`[${this.name}] Querying Steam API for VAC bans for Steam IDs: ${steamIDString}`);

  //   try {
  //     const response = await fetch(`http://api.steampowered.com/ISteamUser/GetPlayerBans/v1/?key=${this.steamAPIKey}&steamids=${steamIDString}`);
  //     if (!response.ok) {
  //       logger.error(`[${this.name}] Failed to fetch VAC ban data: ${response.statusText}`);
  //       return null;
  //     }
  //     const data = await response.json();
  //     if (!data || !data.players || data.players.length === 0) {
  //       logger.warn(`[${this.name}] No VAC ban data found for Steam IDs: ${steamIDString}`);
  //       return null;
  //     } 

  //     // The data structure looks like this:
  //     // {
  //     //  "players":[
  //     //    {
  //     //      "SteamId":"76561198410103743",
  //     //      "CommunityBanned":false,
  //     //      "VACBanned":false,
  //     //      "NumberOfVACBans":0,
  //     //      "DaysSinceLastBan":0,
  //     //      "NumberOfGameBans":0,
  //     //      "EconomyBan":"none"
  //     //    }
  //     //  ]
  //     // }
    
  //     // Now filter the players array to only include those with more than 3 VAC bans or a recent ban
  //     const vacBanData = data.players.map(player => {
  //       return {
  //         steamID: player.SteamId,
  //         vacBanned: player.VACBanned,
  //         numberOfVACBans: player.NumberOfVACBans,
  //         daysSinceLastBan: player.DaysSinceLastBan,
  //         numberOfGameBans: player.NumberOfGameBans,
  //         economyBan: player.EconomyBan,
  //         communityBanned: player.CommunityBanned
  //       };
  //     }).filter(player => {
  //       // Our metric for reporting a True is whether they have more than 3 VAC bans,
  //       // or the most recent ban is less than 365 days old
  //       return player.vacBanned && (player.numberOfVACBans > 3 || player.daysSinceLastBan < 365);
  //     });
  //     if (vacBanData.length > 0) {
  //       logger.info(`[${this.name}] Significant VAC bans detected for Steam IDs: ${steamIDString}`);
  //       logger.info(`[${this.name}] VAC ban data: ${JSON.stringify(vacBanData)}`);
  //     } else {
  //       logger.info(`[${this.name}] No significant VAC bans detected for Steam IDs: ${steamIDString}`);
  //     }

  //     // Now the data structure looks like this:
  //     // [
  //     //   {
  //     //     steamID: "76561198410103743",
  //     //     vacBanned: true,
  //     //     numberOfVACBans: 4,
  //     //     daysSinceLastBan: 100,
  //     //     numberOfGameBans: 0,
  //     //     economyBan: "none",
  //     //     communityBanned: false
  //     //   },
  //     //   ...
  //     // ]

  //     return vacBanData;
  //   } catch (error) {
  //     logger.error(`[${this.name}] Error querying Steam API for VAC bans: ${error.stack}`);
  //     return null;
  //   }
  // }

  // playerVACBansOverThreshold(vacBanObject) {
  //   // A single VAC ban object of the form:
  //   // {
  //   //   steamID: "76561198410103743",
  //   //   vacBanned: true,
  //   //   numberOfVACBans: 4,
  //   //   daysSinceLastBan: 100,
  //   //   numberOfGameBans: 0,
  //   //   economyBan: "none",
  //   //   communityBanned: false
  //   // }

  //   // Check if the player has more than 3 VAC bans or the most recent ban is less than 365 days old
  //   if (vacBanObject && (vacBanObject.numberOfGameBans > 3 || vacBanObject.daysSinceLastBan < 365)) {
  //     return true;
  //   }
  //   return false;
  // }

  // // This will return true if the player has more than 3 VAC bans or the most recent ban is less than 365 days old
  // async playersHasSignificantVACBans(steamIDArray) {
  //   if (!this.steamAPIKey) {
  //     return null;
  //   }

  //   // use classifyUserQueryInfo on each element of the array to ensure they are all valid steamIDs
  //   const validSteamIDs = steamIDArray.filter(steamID => {
  //     const type = classifyUserQueryInfo(steamID);
  //     if (type === 'steamID') {
  //       return true;
  //     } else {
  //       logger.warn(`[${this.name}] Invalid Steam ID provided: ${steamID}. Expected format is 7656119[0-9]{10}.`);
  //       return false;
  //     }
  //   });

  //   if (validSteamIDs.length === 0) {
  //     logger.warn(`[${this.name}] No valid Steam IDs provided for VAC ban check.`);
  //     return false;
  //   }

  //   var missingSteamIDs = validSteamIDs.filter(steamID => !this.vacBanCache.has(steamID));

  //   if (missingSteamIDs.length > 0) {
  //     logger.verbose(`[${this.name}] Missing Steam IDs in cache: ${missingSteamIDs.join(", ")}`);
  //     // Query the Steam API for VAC bans
  //     const vacBanData = await this.querySteamAPIForVACBans(missingSteamIDs);
  //     if (!vacBanData) {
  //       logger.warn(`[${this.name}] Failed to get VAC ban data from Steam API for Steam IDs: ${missingSteamIDs.join(", ")}`);
  //     } else {
  //       // Cache the VAC ban data
  //       vacBanData.forEach(player => {
  //         this.vacBanCache.set(player.steamID, player);
  //         // Set a timeout to clear the cache entry after the TTL
  //         setTimeout(() => this.vacBanCache.delete(player.steamID), this.vacBanCacheTTL);
  //       });
  //       logger.verbose(`[${this.name}] Cached VAC ban data for Steam IDs: ${missingSteamIDs.join(", ")}`);
  //     }
  //   } else {
  //     // logger.verbose(`[${this.name}] All Steam IDs are already in cache: ${validSteamIDs.join(", ")}`);
  //   }

  //   const steamIDsWithSignificantBans = validSteamIDs.filter(steamID => {
  //     const cachedData = this.vacBanCache.get(steamID);
  //     if (cachedData && this.playerVACBansOverThreshold(cachedData)) {
  //       logger.verbose(`[${this.name}] Significant VAC bans found for Steam ID: ${steamID}`);
  //       return true;
  //     }
  //     return false;
  //   });

  //   return steamIDsWithSignificantBans;
  // }
  
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
        // logger.verbose(`[${this.name}] Cache miss for IP: ${playerIP}. Querying database...`);
        const [rows] = await process.mysqlPool.query("SELECT * FROM players WHERE playerIP = ?", [playerIP]);
        this.playerIPCache.set(playerIP, rows);

        // Set timeout to clear cache entry
        setTimeout(() => this.playerIPCache.delete(playerIP), this.playerIPCacheTTL);
      }

      const primaryAccount = this.playerIPCache.get(playerIP).find(
        (dbPlayer) => dbPlayer.beGUID === beGUID
      );

      // Check if this player has an active ban
      if (this.battleMetricsSyncPlugin && primaryAccount && primaryAccount.playerUID) {
        const playerBans = await this.battleMetricsSyncPlugin.getBansByReforgerUUIDs([primaryAccount.playerUID]);
        if (playerBans && playerBans.length > 0) {
          // Filter to keep only permanent or active bans
          const activeBans = playerBans.filter((ban) => ban.expiresAt === null || (ban.expiresAt && ban.expiresAt > new Date()));
          if (activeBans.length > 0) {
            logger.info(`[${this.name}] Player ${playerName} has one or more active bans. Skipping alt check.`);
            return;
          }
        }
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
        // logger.verbose(`[${this.name}] Fetching bans for alt accounts of player ${playerName} with IP ${playerIP} using reforger UUIDs: ${reforgerIDs.join(", ")}`);
        // Fetch bans for the reforger UUIDs
        const fetchedBans = await this.battleMetricsSyncPlugin.getBansByReforgerUUIDs(reforgerIDs);
        if (fetchedBans && fetchedBans.length > 0) {
          // Filter to keep only permanent or active bans
          const activeBans = fetchedBans.filter((ban) => ban.expiresAt === null || (ban.expiresAt && ban.expiresAt > new Date()));
          if (activeBans.length > 0) {
            bans.push(...activeBans);
            logger.info(`[${this.name}] Found ${activeBans.length} active bans for alt accounts of player ${playerName} with IP ${playerIP}.`);
          }
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
        const oldestBan = bans[bans.length - 1];
        // now fetch the player name using the identifier of the ban
        const bannedPlayerName = altAccounts.find((alt) => alt.reforgerIDs === oldestBan.identifier)?.playerName || "Unknown player name";
        
        const link = oldestBan.identifier ? `https://www.battlemetrics.com/rcon/players?filter%5Bsearch%5D=${oldestBan.identifier}&method=quick&redirect=1` : "No link available";

        description += `\n\n**Oldest Ban:** ${bannedPlayerName}`
        description += `\n**Reason:** ${oldestBan.reason || "No reason provided"}`;
        description += `\n**Expires At:** ${oldestBan.expiresAt ? oldestBan.expiresAt.toISOString() : "Never"}`;
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
