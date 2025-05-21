class BattleMetrics {
  constructor(config) {
    this.config = config;
    this.name = "BattleMetrics Connector";
    this.isInitialized = false;
    this.serverInstance = null;
    this.baseURL = "https://api.battlemetrics.com";
  }

  async prepareToMount(serverInstance) {
    await this.cleanup();
    this.serverInstance = serverInstance;

    try {
      if (!this.config.connectors || !this.config.connectors.battlemetrics || !this.config.connectors.battlemetrics.enabled) {
        return;
      }

      const pluginConfig = this.config.plugins.find(plugin => plugin.plugin === 'BattleMetrics');
      if (!pluginConfig || !pluginConfig.enabled) {
        logger.warn("BattleMetrics plugin is not enabled in the configuration.");
        return;
      }

      // 
      if (!this.config.connectors.battlemetrics.token || this.config.connectors.battlemetrics.token === "") {
        logger.error('BattleMetrics configuration is missing the token field.');
        return;
       }

      this.token = this.config.connectors.battlemetrics.token;

      this.isInitialized = true;
      logger.info("BattleMetrics plugin initialized");
    } catch (error) {
      logger.error(`Error initializing BattleMetrics plugin: ${error}`);
    }
  }

  async cleanup() {
    // Cleanup logic if needed
  }

  async makeRequest(endpoint, method = 'GET', body = null) {
    const url = `${this.baseURL}${endpoint}`;
    logger.verbose(`[${this.name}] Making request to BattleMetrics: ${url} with method: ${method} and token length of: ${this.token.length}`);
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`
      }
    };
    if (body) {
      options.body = JSON.stringify(body);
    }
    try {
      const response = await fetch(url, options);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}: ${response.statusText}`);
      }
      return await response.json();
    } catch (error) {
      logger.error(`Error making request to BattleMetrics: ${error.message}`);
      throw error;
    }
  }

  async fetchBMPlayerId(reforgerUUID) {
    if (!this.isInitialized) { return null; }

    // we need to get ['data']['relationships']['player']['data']['id'] from the response
    const options = {
      type: 'identifier',
      attributes: {
        type: 'reforgerUUID',
        identifier: reforgerUUID
      }
    };
    // now use this.makeRequest to fetch the player ID
    try {
      const response = await this.makeRequest('/players/quick-match', 'POST', { data: [options] });
      if (response && response.data && response.data.length > 0) {
        const playerId = response.data[0].relationships.player.data.id;
        logger.info(`Player ID for Reforger UUID ${reforgerUUID}: ${playerId}`);
        return playerId;
      } else {
        logger.warn(`No player found for Reforger UUID: ${reforgerUUID}`);
        return null;
      }
    } catch (error) {
      logger.error(`Error fetching BattleMetrics player URL: ${error.message}`);
      return null;
    }
  }

  async fetchBMPlayerURL(reforgerUUID) {
    if (!this.isInitialized) { return null; }

    logger.verbose(`[${this.name}] Fetching BattleMetrics player URL for Reforger UUID: ${reforgerUUID}`);
    const playerId = await this.fetchBMPlayerId(reforgerUUID);
    return playerId ? `https://www.battlemetrics.com/rcon/players/${playerId}` : null;
  }
}

module.exports = BattleMetrics;