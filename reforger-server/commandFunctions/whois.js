const mysql = require("mysql2/promise");

module.exports = async (interaction, serverInstance, discordClient, extraData = {}) => {
    try {
        const user = interaction.user;
        const identifier = extraData.identifier;
        const value = extraData.value;
        
        logger.info(`[Whois Command] User: ${user.username} (ID: ${user.id}) used /whois with Identifier: ${identifier}, Value: ${value}`);

        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ ephemeral: true });
        }

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

        const fieldMap = {
            beguid: 'beGUID',
            uuid: 'playerUID',
            name: 'playerName',
            ip: 'playerIP'
        };

        const dbField = fieldMap[identifier.toLowerCase()];

        if (!dbField) {
            await interaction.editReply(`Invalid identifier provided: ${identifier}.`);
            return;
        }

        try {
            const [rows] = await pool.query(
                `SELECT playerName, playerIP, playerUID, beGUID FROM players WHERE ?? = ?`,
                [dbField, value]
            );

            if (rows.length === 0) {
                await interaction.editReply(`No information can be found for ${identifier}: ${value}`);
                return;
            }

            const embeds = [];
            let currentEmbed = {
                title: 'Reforger Lookup Directory',
                description: `🔍 Whois: ${value}\n\n`,
                color: 0xFFA500,
                fields: [],
                footer: {
                    text: 'ReforgerJS'
                }
            };

            rows.forEach((player, index) => {
                const playerData = {
                    name: `Player ${index + 1}`,
                    value: `Name: ${player.playerName || 'Missing Player Name'}\n` +
                           `IP Address: ${player.playerIP || 'Missing IP Address'}\n` +
                           `Reforger UUID: ${player.playerUID || 'Missing UUID'}\n` +
                           `be GUID: ${player.beGUID || 'Missing beGUID'}`
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