const { EmbedBuilder } = require('discord.js');
const mysql = require('mysql2/promise');

module.exports = async (interaction, serverInstance, discordClient, extraData = {}) => {
    // Get the UUID from extraData, which now contains all command options
    const uuid = extraData.uuid;
    const user = interaction.user;
    console.log(`[Stats Command] User: ${user.username} (ID: ${user.id}) requested stats for UUID: ${uuid}`);

    // Handle the interaction state
    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: true });
    }

    try {
        const pool = process.mysqlPool || serverInstance.mysqlPool;
        if (!pool) {
            await interaction.editReply('Database connection is not initialized.');
            return;
        }

        // Get the stats table name from command config that was passed through extraData
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

        const [[playerExists]] = await pool.query(r
            `SELECT (EXISTS (SELECT 1 FROM \`${statsTable}\` WHERE playerUID = ?) 
             OR EXISTS (SELECT 1 FROM players WHERE playerUID = ?)) AS existsInDB`,
            [uuid, uuid]
        );
        if (!playerExists.existsInDB) {
            await interaction.editReply(`Player with UUID: ${uuid} could not be found in the database.`);
            return;
        }

        const [rows] = await pool.query(`SELECT * FROM \`${statsTable}\` WHERE playerUID = ?`, [uuid]);

        const [playerRow] = await pool.query(`SELECT playerName FROM players WHERE playerUID = ?`, [uuid]);
        const playerName = (playerRow.length > 0) ? playerRow[0].playerName : 'Unknown Player';

        if (rows.length === 0) {
            await interaction.editReply(`No stats found for UUID: ${uuid}`);
            return;
        }
        const stats = rows[0];

        const metersToKm = meters => (meters / 1000).toFixed(2);
        const kdRatio = stats.deaths > 0 ? (stats.kills / stats.deaths).toFixed(2) : stats.kills;

        const embed = new EmbedBuilder()
            .setTitle("📊 Player Stats")
            .setDescription(`**User:** ${playerName}\n**UUID:** ${uuid}\n---------------\n`)
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