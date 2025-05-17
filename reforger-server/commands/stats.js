const { SlashCommandBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('stats')
        .setDescription('Retrieve player statistics by UUID or name')
        .addStringOption(option =>
            option
                .setName('identifier')
                .setDescription('The UUID or Username of the player')
                .setRequired(true)
        )
        .addStringOption(option =>
                    option.setName('server')
                        .setDescription('Which server to query')
                        .setRequired(true)
                        .addChoices(
                            { name: 'All', value: 'all' },
                            { name: 'Server 1', value: 'server1' },
                            { name: 'Server 2', value: 'server2' },
                        )
                )
};
