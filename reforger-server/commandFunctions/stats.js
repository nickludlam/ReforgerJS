const { EmbedBuilder } = require('discord.js');
const { escapeMarkdown } = require('../../helpers');

module.exports = async (interaction, serverInstance, discordClient, extraData = {}) => {
    const identifier = extraData.identifier;
    const user = interaction.user;
    const requestedServer = extraData.server;
    console.log(`[Stats Command] User: ${user.username} (ID: ${user.id}) requested stats for identifier: ${identifier}`);

    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: true });
    }

    try {
        const pool = process.mysqlPool || serverInstance.mysqlPool;
        if (!pool) {
            await interaction.editReply('Database connection is not initialized.');
            return;
        }

        const statsConfig = extraData.commandConfig || serverInstance.config.commands.find(c => c.command === 'stats');
        if (!statsConfig || !statsConfig.statsTable) {
            await interaction.editReply('Stats command is not properly configured.');
            return;
        }
        const statsTable = statsConfig.statsTable;

        const [statsTableCheck] = await pool.query(`SHOW TABLES LIKE ?`, [statsTable]);
        const [playersTableCheck] = await pool.query(`SHOW TABLES LIKE 'players'`);
        if (!statsTableCheck.length || !playersTableCheck.length) {
            await interaction.editReply('Required tables (players/stats) are missing in the database.');
            return;
        }

        const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
        
        let playerUID;
        let playerName;

        if (isUUID) {
            playerUID = identifier;
            
            const [[playerExists]] = await pool.query(
                `SELECT (EXISTS (SELECT 1 FROM \`${statsTable}\` WHERE playerUID = ?) 
                 OR EXISTS (SELECT 1 FROM players WHERE playerUID = ?)) AS existsInDB`,
                [playerUID, playerUID]
            );
            
            if (!playerExists.existsInDB) {
                await interaction.editReply(`Player with UUID: ${playerUID} could not be found in the database.`);
                return;
            }
            
            const [playerRow] = await pool.query(`SELECT playerName FROM players WHERE playerUID = ?`, [playerUID]);
            playerName = (playerRow.length > 0) ? playerRow[0].playerName : 'Unknown Player';
        } else {
            const [matchingPlayers] = await pool.query(
                `SELECT playerUID, playerName FROM players WHERE playerName LIKE ?`,
                [`%${identifier}%`]
            );
            
            if (matchingPlayers.length === 0) {
                await interaction.editReply(`No players found with name containing: ${identifier}`);
                return;
            } else if (matchingPlayers.length > 1) {
                const displayCount = Math.min(matchingPlayers.length, 3);
                let responseMessage = `Found ${matchingPlayers.length} players matching "${identifier}". `;
                
                if (matchingPlayers.length > 3) {
                    responseMessage += `Showing first 3 results. Please refine your search or use a UUID instead.\n\n`;
                } else {
                    responseMessage += `Please use one of the following UUIDs for a specific player:\n\n`;
                }
                
                for (let i = 0; i < displayCount; i++) {
                    const player = matchingPlayers[i];
                    responseMessage += `${i+1}. ${player.playerName} - UUID: ${player.playerUID}\n`;
                }
                
                await interaction.editReply(responseMessage);
                return;
            } else {
                playerUID = matchingPlayers[0].playerUID;
                playerName = matchingPlayers[0].playerName;
            }
        }

        // This requires the command choices to line up with the server names in the database, as configured by DBLogStats.serverName
        const filterServerName = requestedServer || 'all';

        logger.verbose(`[Stats Command] Fetching ${playerName} (${playerUID}) stats on server: ${filterServerName}`);

        // Now perform a query, and either filter by playerUID AND serverName, or just playerUID if the serverName is 'all'
        const query = filterServerName === 'all'
          ? `SELECT * FROM \`${statsTable}\` WHERE playerUID = ?`
          : `SELECT * FROM \`${statsTable}\` WHERE playerUID = ? AND server_name = ?`;
        const params = filterServerName === 'all'
          ? [playerUID]
          : [playerUID, filterServerName];
        const [rows] = await pool.query(query, params);

        if (rows.length === 0) {
            await interaction.editReply(`No stats found for player: ${playerName} (${playerUID})`);
            return;
        }

        logger.verbose(`[Stats Command] Found ${rows.length} rows for player: ${playerName} (${playerUID})`);

        // Rather than getting one row back, we now get multiple rows, and we need to sum them up
        // Define a set of operations to perform for each stat
        const operations = {
            session_duration: 'sum',
            sppointss0: 'sum', // Infantry Points
            sppointss1: 'sum', // Logistics Points
            sppointss2: 'sum', // Medical Points
            warcrimes: 'sum',
            distance_walked: 'sum',            
            kills: 'sum',
            ai_kills: 'sum',
            shots: 'sum',
            grenades_thrown: 'sum',
            friendly_kills: 'sum',
            friendly_ai_kills: 'sum',
            deaths: 'sum',
            distance_driven: 'sum',
            roadkills: 'sum',
            friendly_roadkills: 'sum',
            ai_roadkills: 'sum',
            friendly_ai_roadkills: 'sum',
            distance_as_occupant: 'sum',
            bandage_self: 'sum',
            bandage_friendlies: 'sum',
            tourniquet_self: 'sum',
            tourniquet_friendlies: 'sum',
            saline_self: 'sum',
            saline_friendlies: 'sum',
            morphine_self: 'sum',
            morphine_friendlies: 'sum',
            warcrime_harming_friendlies: 'sum',
        };

        const stats = rows.reduce((acc, row) => {
            for (const key in row) {
                if (operations[key] === 'sum') {
                    acc[key] = (acc[key] || 0) + row[key];
                } else {
                    acc[key] = row[key];
                }
            }
            return acc;
        }, {});

        const metersToKm = meters => (meters / 1000).toFixed(2);
        const kdRatio = stats.deaths > 0 ? (stats.kills / stats.deaths).toFixed(2) : stats.kills;

        // Now check for the seed_tracker table, and query for this player UID
        const [seedTrackerCheck] = await pool.query(`SHOW TABLES LIKE 'seed_tracker'`);
        if (seedTrackerCheck.length) {
            const query = filterServerName === 'all'
              ? `SELECT * FROM seed_tracker WHERE playerUID = ?`
              : `SELECT * FROM seed_tracker WHERE playerUID = ? AND serverName = ?`;
            const params = filterServerName === 'all'
              ? [playerUID]
              : [playerUID, filterServerName];
            const [seedRows] = await pool.query(query, params);

            if (seedRows.length > 0) {
                stats.seedValue = seedRows.reduce((acc, row) => { return acc + row.seedValue; }, 0);
            } else {
                stats.seedValue = 0;
            }
        }

        // Now check if the seeder role is assigned to the player by checking against the SeedTrackerBasic config key `discordSeederRoleId`
        const seederRoleId = serverInstance.config.plugins.find(p => p.plugin === 'SeedTrackerBasic')?.discordSeederRoleId;
        if (seederRoleId) {
            const guild = await discordClient.guilds.fetch(serverInstance.config.connectors.discord.guildId);
            const member = await guild.members.fetch(user.id);
            if (member && member.roles.cache.has(seederRoleId)) {
                stats.isSeeder = true;
            } else {
                stats.isSeeder = false;
            }
        }

        const fields = [
          {
              name: "**🔸Infantry**",
              value: `Points: ${parseInt(stats.sppointss0)}\nPlayer Kills: ${stats.kills}\nDeaths: ${stats.deaths}\nK/D: ${kdRatio}\n\nAI Kills: ${stats.ai_kills}\nShots Fired: ${stats.shots}\nGrenades Thrown: ${stats.grenades_thrown}\nDistance Walked: ${metersToKm(stats.distance_walked)} km`
          },
          {
              name: "**🔸Logistics**",
              value: `Points: ${parseInt(stats.sppointss1)}\nRoadKills: ${stats.roadkills}\nAI Roadkills: ${stats.ai_roadkills}\nDistance Driven: ${metersToKm(stats.distance_driven)} km\nDistance as Passenger: ${metersToKm(stats.distance_as_occupant)} km`
          },
          {
              name: "**🔸Medical**",
              value: `Points: ${parseInt(stats.sppointss2)}\nBandages Applied: ${stats.bandage_self + stats.bandage_friendlies}\nTourniquets Applied: ${stats.tourniquet_self + stats.tourniquet_friendlies}\nSaline Applied: ${stats.saline_self + stats.saline_friendlies}\nMorphine Applied: ${stats.morphine_self + stats.morphine_friendlies}`
          },
          {
              name: "**❗Warcrimes**",
              value: `Warcrime Value: ${stats.warcrime_harming_friendlies}\nTeamkills: ${stats.friendly_kills}\nAI TeamKills: ${stats.friendly_ai_kills}\nFriendly Roadkills: ${stats.friendly_roadkills}\nFriendly AI Roadkills: ${stats.friendly_ai_roadkills}`
          }
        ];

        // If the player is a seeder, add the seed value to the embed
        if (stats.isSeeder) {
            fields.push({
                name: "**🌱 Seeder**",
                value: `Minutes tracked as a seeder: ${stats.seedValue}`
            });
        }
        
        fields.push({
            name: "**🕒 Playtime**",
            value: `Total Playtime: ${Math.floor(stats.session_duration / (60 * 60))} hours`
        });

        // TODO: Improve this to work with the command configuration in commands/stats.js
        const serverDisplayName = filterServerName.replace(/([a-z])([0-9])/g, '$1 $2');

        const titleSuffix = filterServerName === 'all' ? ' across all servers' : ` for ${serverDisplayName}`;

        const embed = new EmbedBuilder()
            .setTitle("📊 Player Stats" + titleSuffix)
            .setDescription(`**User:** ${escapeMarkdown(playerName)}\n**UUID:** ${playerUID}\n---------------\n`)
            .setColor("#FFA500")
            .setFooter({ text: "Stats collected by ReforgerJS" })
            .addFields(fields);

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        console.error(`[Stats Command] Error: ${error.message}`);
        await interaction.editReply('An error occurred while retrieving stats.');
    }
};
