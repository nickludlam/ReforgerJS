const { SlashCommandBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('stats')
        .setDescription('Retrieve player statistics by UUID')
        .addStringOption(option =>
            option
                .setName('uuid')
                .setDescription('The UUID of the player')
                .setRequired(true)
        ),
    async execute(interaction) {
        const uuid = interaction.options.getString('uuid');
        console.log(`UUID: ${uuid}`);

        const commandHandler = require('../commandHandler');
        await commandHandler(interaction, { uuid });
    },
};
