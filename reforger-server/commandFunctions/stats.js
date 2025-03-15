const { EmbedBuilder } = require('discord.js');
const mysql = require('mysql2/promise');

module.exports = async (interaction, serverInstance, discordClient, extraData = {}) => {
    const identifier = extraData.identifier;
    const user = interaction.user;
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

        const [rows] = await pool.query(`SELECT * FROM \`${statsTable}\` WHERE playerUID = ?`, [playerUID]);

        if (rows.length === 0) {
            await interaction.editReply(`No stats found for player: ${playerName} (${playerUID})`);
            return;
        }
        const stats = rows[0];

        const metersToKm = meters => (meters / 1000).toFixed(2);
        const kdRatio = stats.deaths > 0 ? (stats.kills / stats.deaths).toFixed(2) : stats.kills;

        const embed = new EmbedBuilder()
            .setTitle("📊 Player Stats")
            .setDescription(`**User:** ${playerName}\n**UUID:** ${playerUID}\n---------------\n`)
            .setColor("#FFA500")
            .setFooter({ text: "Reforger Stats - ZSUGaming" })
            .addFields(
                {
                    name: "**🔸Infantry**",
                    value: `Points: ${stats.sppointss0}\nPlayer Kills: ${stats.kills}\nDeaths: ${stats.deaths}\nK/D: ${kdRatio}\n\nAI Kills: ${stats.ai_kills}\nShots Fired: ${stats.shots}\nGrenades Thrown: ${stats.grenades_thrown}\nDistance Walked: ${metersToKm(stats.distance_walked)} km`
                },
                {
                    name: "**🔸Logistics**",
                    value: `Points: ${stats.sppointss1}\nRoadKills: ${stats.roadkills}\nAI Roadkills: ${stats.ai_roadkills}\nDistance Driven: ${metersToKm(stats.distance_driven)} km\nDistance as Passenger: ${metersToKm(stats.distance_as_occupant)} km`
                },
                {
                    name: "**🔸Medical**",
                    value: `Points: ${stats.sppointss2}\nBandages Applied: ${stats.bandage_self + stats.bandage_friendlies}\nTourniquets Applied: ${stats.tourniquet_self + stats.tourniquet_friendlies}\nSaline Applied: ${stats.saline_self + stats.saline_friendlies}\nMorphine Applied: ${stats.morphine_self + stats.morphine_friendlies}`
                },
                {
                    name: "**❗Warcrimes**",
                    value: `Warcrime Value: ${stats.warcrime_harming_friendlies}\nTeamkills: ${stats.friendly_kills}\nAI TeamKills: ${stats.friendly_ai_kills}\nFriendly Roadkills: ${stats.friendly_roadkills}\nFriendly AI Roadkills: ${stats.friendly_ai_roadkills}`
                }
            );

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        console.error(`[Stats Command] Error: ${error.message}`);
        await interaction.editReply('An error occurred while retrieving stats.');
    }
};
