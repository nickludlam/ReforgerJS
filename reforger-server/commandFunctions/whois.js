const { escapeMarkdown, classifyUserQueryInfo } = require('../../helpers');
const geoIPLookup = require('../utils/geoIPLookup');
const BattlemetricsSync = require('../plugins/BattlemetricsSync');

// Initialize the GeoIP database reader
const geoipInitialized = geoIPLookup.initialize();
if (!geoipInitialized) {
    logger.warn('[Whois Command] GeoIP database could not be initialized. Country information will not be available.');
}

module.exports = async (interaction, serverInstance, discordClient, extraData = {}) => {
    try {
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ ephemeral: true });
        }
        
        // Make sure the GeoIP database is initialized
        if (!geoIPLookup.reader) {
            const initResult = geoIPLookup.initialize();
            if (!initResult) {
                logger.warn('[Whois Command] GeoIP database could not be initialized during command execution. Country information will not be available.');
            }
        }

        const bmSyncPlugin = serverInstance.pluginInstances.find((plugin) => plugin instanceof BattlemetricsSync);

        const user = interaction.user;
        const identifier = extraData.identifier.trim();
        
        logger.info(`[Whois Command] User: ${user.username} (ID: ${user.id}) used /whois with identifier: ${identifier}`);

        if (!serverInstance.config.connectors ||
            !serverInstance.config.connectors.mysql ||
            !serverInstance.config.connectors.mysql.enabled) {
            await interaction.editReply('MySQL is not enabled in the configuration. This command cannot be used.');
            return;
        }

        const pool = process.mysqlPool || serverInstance.mysqlPool;

        if (!pool) {
            await interaction.editReply('Database connection is not initialized.');
            return;
        }

        if (identifier.length < 3) {
            await interaction.editReply(`Identifier ${identifier} is too short. Please provide at least 3 characters.`);
            return;
        }

        const dbField = classifyUserQueryInfo(identifier);

        const validDBFields = ['playerName', 'playerIP', 'playerUID', 'beGUID', 'steamID'];
        if (!validDBFields.includes(dbField)) {
            await interaction.editReply(`Invalid identifier provided: ${identifier}.`);
            return;
        }

        try {
            let query;
            let params;
            
            if (dbField === 'playerName') {
                query = `
                    SELECT DISTINCT playerName, playerIP, playerUID, beGUID, steamID, device, lastSeen,
                          CASE
                              WHEN LOWER(playerName) = LOWER(?) THEN 1  -- Exact match
                              WHEN LOWER(playerName) LIKE LOWER(?) THEN 2  -- Partial match
                              ELSE 3  -- Other matches
                          END AS matchRank
                    FROM players
                    WHERE LOWER(playerName) LIKE LOWER(?)
                    ORDER BY matchRank, lastSeen DESC
                `;
                params = [identifier, `%${identifier}%`, `%${identifier}%`];
            } else {
                query = `SELECT playerName, playerIP, playerUID, beGUID, steamID, device, lastSeen FROM players WHERE ${dbField} = ?`;
                params = [identifier];
            }



            const [rows] = await pool.query(query, params);

            if (rows.length === 0) {
                await interaction.editReply(`No information can be found for ${dbField}: ${identifier}`);
                return;
            }

            const maxResults = 5;

            if (rows.length > 1) {
                const displayCount = Math.min(rows.length, maxResults);
                let responseMessage = `Found ${rows.length} players matching "${identifier}".\n\n`;
                
                if (rows.length > maxResults) {
                    responseMessage += `Showing first ${maxResults} results. Please refine your search for more specific results.\n\n`;
                }
                
                for (let i = 0; i < displayCount; i++) {
                    const player = rows[i];
                    
                    // Get country information if IP is available
                    let countryInfo = '';
                    if (player.playerIP) {
                        const country = geoIPLookup.getCountryData(player.playerIP);
                        // dump the country data to the console for debugging
                        logger.debug(`[Whois Command] Country data for IP ${player.playerIP}: ${JSON.stringify(country)}`);
                        if (country && country.name !== 'Unknown') {
                            countryInfo = ` (${country.name})`;
                        }
                    }
                    
                    let playerDetails = `${i+1}. **${escapeMarkdown(player.playerName) || 'Unknown'}**\n` +
                                        `   Reforger UUID: ${player.playerUID || 'Missing'}\n` +
                                        `   IP: ${player.playerIP || 'Missing'}${countryInfo}\n` +
                                        `   Device: ${player.device || 'Not Found'}\n` + 
                                        `   Last Seen: ${player.lastSeen || 'Not Found'}`;
                    
                    responseMessage += playerDetails + '\n';
                }
                
                await interaction.editReply(responseMessage);
                return;
            }

            // If we're here, we have a single result

            const bmReforgerURL = `https://www.battlemetrics.com/rcon/players?filter%5Bsearch%5D=${rows[0].playerUID}&method=quick&redirect=1`
            const bmSteamURL = rows[0].steamID ? `https://www.battlemetrics.com/rcon/players?filter%5Bsearch%5D=${rows[0].steamID}&method=quick&redirect=1` : null;

            var banDetails = '';
            const bans = await bmSyncPlugin.getBanByReforgerUUIDs([rows[0].playerUID]);
            if (bans && bans.length > 0) {
              logger.info(`[Whois Command] Found ${bans.length} bans for Reforger UUID: ${rows[0].playerUID}`);
              banDetails = bans.map((ban) => {
                const note = ban.note ? ban.note.replace(/<\/?[^>]+(>|$)/g, '') : '';
                const noteTruncated = note.length > 100 ? note.substring(0, 100) + '...' : note;

                return `**Reason:** ${ban.reason || 'No reason provided'}\n` +
                       `**Note:** ${noteTruncated}\n` +
                       `**Expires At:** ${ban.expiresAt ? ban.expiresAt.toISOString() : 'Never'}\n`
              }).join('\n\n');
              banDetails = `**Bans for Reforger UUID ${rows[0].playerUID}:**\n\n` + banDetails;
              banDetails.trim();
              logger.verbose(`[Whois Command] Ban details: ${banDetails}`);
            }
            

            const embeds = [];
            let currentEmbed = {
                title: 'Reforger Lookup Directory',
                description: `🔍 Whois: ${identifier}\n\n`,
                color: 0xFFA500,
                fields: [],
                footer: {
                    text: 'ReforgerJS'
                }
            };

            rows.forEach((player) => {
                let playerInfo = `Name: ${escapeMarkdown(player.playerName) || 'Missing Player Name'}` +
                                 `\nReforger ID: ${player.playerUID || 'Missing UUID'}`;
                playerInfo +=  `\nbe GUID: ${player.beGUID || 'Missing beGUID'}`;
                
                // Add IP address with country information
                const ipAddress = player.playerIP || 'Missing IP Address';
                let countryInfo = '';
                
                if (player.playerIP) {
                    const country = geoIPLookup.getCountryData(player.playerIP);
                    if (country && country.name !== 'Unknown') {
                        countryInfo = ` (${country.name}${country.isoCode ? ` [${country.isoCode}]` : ''})`;
                    }
                }
                
                playerInfo += `\nIP Address: ${ipAddress}${countryInfo}` +
                              `\nDevice: ${player.device || 'Not Found'}`;
                
                if (player.device === 'PC') {
                    playerInfo += `\nSteamID: ${player.steamID || 'Not Found'}`;
                }
                playerInfo += `\nLast connected: ${player.lastSeen || 'Not Found'}`;
                
                // Check if they are playing on this server
                const playerList = serverInstance.players || [];
                const isOnline = playerList.some((p) => p.beGUID?.trim().toLowerCase() === player.beGUID?.trim().toLowerCase());
                const playerIsOnlineLine = isOnline ? 'Currently Online' : 'Currently Offline';
                playerInfo += `\nStatus: ${playerIsOnlineLine}`;

                if (banDetails) {
                    playerInfo += `\n\n${banDetails}\n`;
                }

                if (bmReforgerURL) {
                    playerInfo += `\n[BattleMetrics Reforger ID Lookup](${bmReforgerURL})`;
                }
                if (bmSteamURL) {
                    playerInfo += `\n[BattleMetrics SteamID Lookup](${bmSteamURL})`;
                }

                const playerData = {
                    name: 'Player details',
                    value: playerInfo
                };

                currentEmbed.fields.push(playerData);

                const embedLength = JSON.stringify(currentEmbed).length;
                if (embedLength >= 5900) {
                    embeds.push(currentEmbed);
                    currentEmbed = {
                        title: 'Reforger Lookup Directory (Continued)',
                        description: '',
                        color: 0xFFA500,
                        fields: [],
                        footer: {
                            text: 'ReforgerJS'
                        }
                    };
                }
            });

            if (currentEmbed.fields.length > 0) {
                embeds.push(currentEmbed);
            }

            for (const embed of embeds) {
                if (embeds.indexOf(embed) === 0) {
                    await interaction.editReply({ embeds: [embed] });
                } else {
                    await interaction.followUp({ embeds: [embed], ephemeral: true });
                }
            }
        } catch (queryError) {
            logger.error(`[Whois Command] Database query error: ${queryError.message}`);
            await interaction.editReply('An error occurred while querying the database.');
        }
    } catch (error) {
        logger.error(`[Whois Command] Unexpected error: ${error.message}`);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
                content: 'An unexpected error occurred while executing the command.',
                ephemeral: true
            });
        } else if (interaction.deferred && !interaction.replied) {
            await interaction.editReply('An unexpected error occurred while executing the command.');
        }
    }
};