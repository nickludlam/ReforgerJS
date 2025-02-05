const fs = require('fs');
const path = require('path');

/**
 * Load all plugins defined in config.plugins from the './plugins' directory.
 * Returns an array of plugin instances.
 */
async function loadPlugins(config) {
    const pluginsDir = path.join(__dirname, 'plugins');
    if (!fs.existsSync(pluginsDir)) {
        logger.error('Plugins directory not found. Please ensure the plugins directory exists.');
        throw new Error('Plugins directory not found');
    }

    const plugins = [];

    for (const plugin of config.plugins) {
        if (plugin.enabled) {
            const pluginPath = path.join(pluginsDir, `${plugin.plugin}.js`);
            if (fs.existsSync(pluginPath)) {
                logger.verbose(`Plugin found and loading: ${plugin.plugin}`);
                try {
                    const PluginClass = require(pluginPath);
                    const pluginInstance = new PluginClass(config);
                    plugins.push(pluginInstance);
                    logger.info(`Plugin successfully loaded: ${plugin.plugin}`);
                } catch (error) {
                    logger.error(`Error loading plugin ${plugin.plugin}: ${error.message}`);
                }
            } else {
                logger.error(`Plugin not found: ${plugin.plugin}. Expected at: ${pluginPath}`);
            }
        }
    }

    return plugins;
}

/**
 * Mount each plugin by invoking its prepareToMount method.
 * @param {Array} plugins - Array of plugin instances.
 * @param {Object} serverInstance - Instance of ReforgerServer.
 * @param {Object} discordClient - Discord client instance.
 */
async function mountPlugins(plugins, serverInstance, discordClient) {
    for (const pluginInstance of plugins) {
        try {
            if (typeof pluginInstance.prepareToMount === 'function') {
                // Pass the serverInstance and discordClient so plugin can access them
                await pluginInstance.prepareToMount(serverInstance, discordClient);
            }
            logger.info(`Plugin mounted successfully: ${pluginInstance.name || 'Unnamed Plugin'}`);
        } catch (error) {
            logger.error(`Error mounting plugin: ${error.message}`);
        }
    }
}

/**
 * Reload all plugins at runtime.
 * @param {Object} config - Global configuration object.
 * @param {Object} serverInstance - Instance of ReforgerServer.
 * @param {Object} discordClient - Discord client instance.
 * @param {Array} currentPlugins - Array of currently loaded plugin instances.
 */
async function reloadPlugins(config, serverInstance, discordClient, currentPlugins) {
    logger.info('Reloading plugins...');

    // First, cleanup existing plugins
    for (const pluginInstance of currentPlugins) {
        if (typeof pluginInstance.cleanup === 'function') {
            try {
                await pluginInstance.cleanup();
                logger.info(`Plugin '${pluginInstance.name || 'Unnamed Plugin'}' cleaned up successfully.`);
            } catch (error) {
                logger.error(`Error during cleanup of plugin '${pluginInstance.name || 'Unnamed Plugin'}': ${error.message}`);
            }
        }
    }

    // Clear the require cache for plugin files to allow reloading
    for (const pluginInstance of currentPlugins) {
        const pluginPath = path.join(__dirname, 'plugins', `${pluginInstance.name}.js`);
        try {
            delete require.cache[require.resolve(pluginPath)];
        } catch (error) {
            logger.error(`Error clearing cache for plugin '${pluginInstance.name || 'Unnamed Plugin'}': ${error.message}`);
        }
    }

    // Load and mount new plugins
    const newPlugins = await loadPlugins(config);
    await mountPlugins(newPlugins, serverInstance, discordClient);

    logger.info('Plugins reloaded successfully.');
    return newPlugins;
}

module.exports = {
    loadPlugins,
    mountPlugins,
    reloadPlugins
};
