const { SlashCommandBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('whois')
        .setDescription('Reforger player information')
        .addStringOption(option =>
            option
                .setName('identifier')
                .setDescription('The type of identifier (beGUID, UUID, Name, or IP)')
                .setRequired(true)
                .addChoices(
                    { name: 'beGUID', value: 'beguid' },
                    { name: 'UUID', value: 'uuid' },
                    { name: 'Name', value: 'name' },
                    { name: 'IP', value: 'ip' }
                )
        )
        .addStringOption(option =>
            option
                .setName('value')
                .setDescription('The value of the chosen identifier')
                .setRequired(true)
        ),
    async execute(interaction) {
        const identifier = interaction.options.getString('identifier');
        const value = interaction.options.getString('value');

        console.log(`Identifier: ${identifier}, Value: ${value}`);

        const commandHandler = require('../commandHandler');
        await commandHandler(interaction, { identifier, value });
    },
};
