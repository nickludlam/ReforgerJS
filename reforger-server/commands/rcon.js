const { SlashCommandBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('rcon')
        .setDescription('Manage server via RCON')
        // .addSubcommand(subcommand =>
        //     subcommand
        //         .setName('restart')
        //         .setDescription('Restart the server')
        //         .addStringOption(option =>
        //             option.setName('confirm')
        //                 .setDescription('Type CONFIRM to proceed')
        //                 .setRequired(true)
        //         )
        // )
        .addSubcommand(subcommand =>
            subcommand
                .setName('shutdown')
                .setDescription('Performs a full shutdown/restart of the server')
                .addStringOption(option =>
                    option.setName('confirm')
                        .setDescription('Type CONFIRM to proceed')
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('whois')
                .setDescription('Queries the player list for a specific player')
                .addStringOption(option =>
                    option.setName('identifier')
                        .setDescription('Either a Reforger ID or a player name')
                        .setRequired(true)
                )
        )
        // .addSubcommand(subcommand =>
        //     subcommand
        //         .setName('kick')
        //         .setDescription('Kick a player')
        //         .addStringOption(option =>
        //             option.setName('id')
        //                 .setDescription('Player ID')
        //                 .setRequired(true)
        //         )
        // )
        // .addSubcommand(subcommand =>
        //     subcommand
        //         .setName('ban')
        //         .setDescription('Manage player bans')
        //         .addStringOption(option =>
        //             option.setName('action')
        //                 .setDescription('Create or remove a ban')
        //                 .setRequired(true)
        //                 .addChoices(
        //                     { name: 'Create', value: 'create' },
        //                     { name: 'Remove', value: 'remove' }
        //                 )
        //         )
        //         .addStringOption(option =>
        //             option.setName('id')
        //                 .setDescription('Player ID')
        //                 .setRequired(true)
        //         )
        //         .addIntegerOption(option =>
        //             option.setName('duration')
        //                 .setDescription('Ban duration in seconds (for create)')
        //                 .setRequired(false)
        //         )
        //         .addStringOption(option =>
        //             option.setName('reason')
        //                 .setDescription('Reason for ban (optional)')
        //                 .setRequired(false)
        //         )
        // )
};
