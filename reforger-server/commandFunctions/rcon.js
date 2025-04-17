const { EmbedBuilder } = require("discord.js");

module.exports = async (
  interaction,
  serverInstance,
  discordClient,
  extraData = {}
) => {
  // Get the server number from the command options
  const requestedServerNumber = interaction.options.getInteger("server");
  const currentServerNumber = serverInstance.config.server.id;
  
  // Check if this is the correct server instance to handle the command
  if (requestedServerNumber !== currentServerNumber) {
    logger.info(
      `[RCON Command] Ignoring command for server ${requestedServerNumber} (this is server ${currentServerNumber})`
    );
    return;
  }

  // Get the subcommand and options
  const subcommand = interaction.options.getSubcommand();
  const config = serverInstance.config;
  const rconConfig = config.commands.find((cmd) => cmd.command === "rcon");

  if (!rconConfig) {
    return interaction.reply({
      content: "RCON command configuration is missing.",
      ephemeral: true,
    });
  }

  // Get user roles
  const userRoles = interaction.member.roles.cache.map((role) => role.id);

  // Function to get the user's maximum role level
  function getUserMaxRoleLevel(userRoles) {
    let maxLevel = 0;
    for (const [levelKey, roleNameArray] of Object.entries(config.roleLevels)) {
      const numericLevel = parseInt(levelKey, 10);
      if (isNaN(numericLevel)) continue;

      for (const roleName of roleNameArray) {
        const discordRoleID = config.roles[roleName];
        if (discordRoleID && userRoles.includes(discordRoleID)) {
          if (numericLevel > maxLevel) {
            maxLevel = numericLevel;
          }
        }
      }
    }
    return maxLevel;
  }

  // Function to check if user has permission for a specific subcommand
  function hasPermissionForSubcommand(subcommandName) {
    const requiredLevel = rconConfig[subcommandName];
    if (!requiredLevel) {
      return false;
    }
    const userLevel = getUserMaxRoleLevel(userRoles);
    return userLevel >= requiredLevel;
  }

  // Handle the interaction state
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral: true });
  }

  try {
    // Check if RCON is available
    if (!serverInstance.rcon || !serverInstance.rcon.isConnected) {
      return interaction.editReply({
        content: "RCON is not connected to the server.",
        ephemeral: true,
      });
    }

    // Handle restart subcommand
    if (subcommand === "restart") {
      const confirm = interaction.options.getString("confirm");

      if (!hasPermissionForSubcommand("restart")) {
        return interaction.editReply({
          content: "You do not have permission to restart the server.",
          ephemeral: true,
        });
      }

      if (confirm !== "CONFIRM") {
        return interaction.editReply({
          content: "Type CONFIRM to proceed with a restart.",
          ephemeral: true,
        });
      }

      // Log the action
      const user = interaction.user;
      logger.info(
        `[RCON Command] User ${user.username} (${user.id}) issued server restart command`
      );

      // Send the RCON command
      serverInstance.rcon.sendCustomCommand("restart");

      return interaction.editReply({
        content:
          "Server restart command sent. The server will restart shortly.",
        ephemeral: true,
      });
    }

    // Handle shutdown subcommand
    if (subcommand === "shutdown") {
      const confirm = interaction.options.getString("confirm");

      if (!hasPermissionForSubcommand("shutdown")) {
        return interaction.editReply({
          content: "You do not have permission to shut down the server.",
          ephemeral: true,
        });
      }

      if (confirm !== "CONFIRM") {
        return interaction.editReply({
          content: "Type CONFIRM to proceed with a shutdown.",
          ephemeral: true,
        });
      }

      // Log the action
      const user = interaction.user;
      logger.info(
        `[RCON Command] User ${user.username} (${user.id}) issued server shutdown command`
      );

      // Send the RCON command
      serverInstance.rcon.sendCustomCommand("#shutdown");

      return interaction.editReply({
        content:
          "Server shutdown command sent. The server will shut down shortly.",
        ephemeral: true,
      });
    }

    // Handle kick subcommand
    if (subcommand === "kick") {
      const playerId = interaction.options.getString("id");

      if (!hasPermissionForSubcommand("kick")) {
        return interaction.editReply({
          content: "You do not have permission to kick a player.",
          ephemeral: true,
        });
      }

      if (!playerId) {
        return interaction.editReply({
          content: "Player ID is required.",
          ephemeral: true,
        });
      }

      // Create the kick command
      const rconCommand = `#kick ${playerId}`;

      // Log the action
      const user = interaction.user;
      logger.info(
        `[RCON Command] User ${user.username} (${user.id}) issued kick command: ${rconCommand}`
      );

      // Send the RCON command
      serverInstance.rcon.sendCustomCommand(rconCommand);

      return interaction.editReply({
        content: `Player with ID ${playerId} has been kicked from the server.`,
        ephemeral: true,
      });
    }

    // Handle ban subcommand
    if (subcommand === "ban") {
      const action = interaction.options.getString("action");
      const playerId = interaction.options.getString("id");
      const duration = interaction.options.getInteger("duration");
      const reason = interaction.options.getString("reason");

      if (!hasPermissionForSubcommand("ban")) {
        return interaction.editReply({
          content: "You do not have permission to ban players.",
          ephemeral: true,
        });
      }

      if (!playerId) {
        return interaction.editReply({
          content: "Player ID is required.",
          ephemeral: true,
        });
      }

      let rconCommand = "";
      if (action === "remove") {
        rconCommand = `ban remove ${playerId}`;
      } else if (action === "create") {
        if (!duration) {
          return interaction.editReply({
            content: "Ban creation requires a duration (in seconds).",
            ephemeral: true,
          });
        }

        // ban create <id> <duration> [reason]
        if (reason) {
          rconCommand = `#ban create ${playerId} ${duration} ${reason}`;
        } else {
          rconCommand = `#ban create ${playerId} ${duration}`;
        }
      }

      // Log the action
      const user = interaction.user;
      logger.info(
        `[RCON Command] User ${user.username} (${user.id}) issued ban command: ${rconCommand}`
      );

      // Send the RCON command
      serverInstance.rcon.sendCustomCommand(rconCommand);

      return interaction.editReply({
        content: `RCON command sent: \`${rconCommand}\``,
        ephemeral: true,
      });
    }

    // If we get here, it's an unhandled subcommand
    return interaction.editReply({
      content: `Unknown subcommand: ${subcommand}`,
      ephemeral: true,
    });
  } catch (error) {
    logger.error(`[RCON Command] Error: ${error.message}`);
    return interaction.editReply({
      content: "An error occurred while executing the RCON command.",
      ephemeral: true,
    });
  }
};
