const { EmbedBuilder } = require('discord.js');
const { escapeMarkdown, classifyUserQueryInfo } = require('../../helpers');
const logger = require('../logger/logger');

module.exports = async (interaction, serverInstance, discordClient, extraData = {}) => {
    try {
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ ephemeral: true });
        }

        const user = interaction.user;
        const identifier = extraData.identifier.trim();
        const reason = extraData.reason;
        const evidenceUrl = extraData.evidence;
        
        logger.info(`[Evidence Command] User: ${user.username} (ID: ${user.id}) used /evidence with identifier: ${identifier}, reason: ${extraData.reason || 'N/A'}, evidence URL: ${extraData.evidence_url || 'N/A'}`);

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

        if (!reason || reason.length < 5) {
            await interaction.editReply(`Reason is too short. Please provide at least 5 characters.`);
            return;
        }

        const dbField = classifyUserQueryInfo(identifier);

        logger.verbose(`[Evidence Command] Classified identifier: ${identifier} as field: ${dbField}`);

        const validDBFields = ['playerName', 'playerIP', 'playerUID', 'beGUID', 'steamID'];
        if (!validDBFields.includes(dbField)) {
            await interaction.editReply(`Invalid identifier provided: ${identifier}. It must be one of: ${validDBFields.join(', ')}`);
            return;
        }
        logger.verbose(`[Evidence Command] Valid identifier field: ${dbField}`);

        let query;
        let params;
        
        if (dbField === 'playerName') {
            query = `SELECT playerName, playerIP, playerUID, beGUID, steamID, device, lastSeen FROM players WHERE ${dbField} LIKE ?`;
            params = [`%${identifier}%`];
        } else {
            query = `SELECT playerName, playerIP, playerUID, beGUID, steamID, device, lastSeen FROM players WHERE ${dbField} = ?`;
            params = [identifier];
        }

        let player;
        let connection;
        try {
            connection = await pool.getConnection();
            const [rows] = await pool.query(query, params);

            logger.verbose(`[Evidence Command] Database query returned ${rows.length} results for identifier: ${identifier}`);

            if (rows.length === 0) {
                logger.warn(`[Evidence Command] No information found for ${dbField}: ${identifier}`);
                await interaction.editReply(`No information can be found for ${dbField}: ${identifier}`);
                return;
            }

            if (rows.length > 1) {
                logger.warn(`[Evidence Command] Multiple players found for identifier: ${identifier}`);
                let responseMessage = `Found ${rows.length} players matching "${identifier}". You need to be more specific to get a single result.`
                await interaction.editReply(responseMessage);
                return;
            }

            player = rows[0];
        } catch (error) {
            logger.error(`[Evidence Command] Database query error: ${error.message}`);
            await interaction.editReply('An error occurred while querying the database. Please try again later.');
            return;
        } finally {
          connection.release();
        }
        
        // If we're here, we have a single result

        logger.verbose(`[Evidence Command] Found player: ${player.playerName} with Reforger ID: ${player.playerUID}`);

        // use the battlemetrics client to get a URL for the Reforger ID and Steam ID
        const battleMetricsClient = process.battleMetrics;
        // use battleMetricsClient.fetchBMPlayerURL on the playerUID
        const bmReforgerIdURL = await battleMetricsClient.fetchBMPlayerURL(player.playerUID);
        const bmSteamIdURL = player.steamID ? await battleMetricsClient.fetchBMPlayerURL(player.steamID) : null;


        let playerInfo = `Name: ${escapeMarkdown(player.playerName) || 'Missing Player Name'}` +
                          `\nReforger ID: ${player.playerUID || 'Missing UUID'}` + 
                          `\nReforger ID BM URL: ${bmReforgerIdURL || 'Not Found'}`;
        
        if (player.device === 'PC') {
            playerInfo += `\nSteamID: ${player.steamID || 'Not Found'}`;
            if (bmSteamIdURL) {
              playerInfo += `\nSteamID BM URL: ${bmSteamIdURL || 'Not Found'}`;
            }
        }
        // add reason and optional evidence URL
        playerInfo += `\nReason: ${escapeMarkdown(reason) || 'No reason provided'}`;
        if (evidenceUrl) {
            playerInfo += `\nEvidence URL: ${escapeMarkdown(evidenceUrl)}`;
        }

        const fields = [
          {
            name: 'Player details',
            value: playerInfo
          }
        ];
        
        const embed = new EmbedBuilder()
          .setTitle('🧾 Evidence report')
          .setDescription(`Formatted output to be pasted into #evidence-storage\n`)
          .setColor("#00A5FF")
          .setFooter({ text: "EXD ReforgerJS" })
          .addFields(fields);

        logger.verbose(`[Evidence Command] Sending embed with player details for identifier: ${identifier}`);
        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        logger.error(`[Evidence Command] Unexpected error: ${error.message}`);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
                content: 'An unexpected error occurred while executing the command.',
                ephemeral: true
            });
        } else if (interaction.deferred && !interaction.replied) {
            logger.error(`[Evidence Command] Error after deferring reply: ${error.message}`);
            await interaction.editReply('An unexpected error occurred while executing the command.');
        }
    }
};