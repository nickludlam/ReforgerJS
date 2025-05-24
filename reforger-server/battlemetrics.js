const { classifyUserQueryInfo } = require('../helpers');


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
        logger.warn(`[${this.name}] BattleMetrics connector is not enabled in the configuration. Connector will be disabled.`);
        return;
      }

      if (!this.config.connectors.battlemetrics.token || this.config.connectors.battlemetrics.token === "") {
        logger.error('BattleMetrics connector configuration is missing the token field.');
        return;
       }

      this.token = this.config.connectors.battlemetrics.token;

      this.isInitialized = true;
      logger.info("BattleMetrics connector initialized");
    } catch (error) {
      logger.error(`Error initializing BattleMetrics connector: ${error}`);
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

  async fetchBMPlayerId(playerIdentifier) {
    if (!this.isInitialized) { return null; }

    // Get the shape of the playerIdentifier using helper classifyUserQueryInfo()
    logger.verbose(`[${this.name}] Fetching BattleMetrics player ID for identifier: ${playerIdentifier}`);
    playerIdentifier = playerIdentifier.trim();
    if (!playerIdentifier || playerIdentifier.length === 0) {
      logger.warn('playerIdentifier is empty or invalid.');
      return null;
    }

    const identifierType = classifyUserQueryInfo(playerIdentifier);
    const validIdentifierTypes = ['playerUID', 'steamID'];
    if (!validIdentifierTypes.includes(identifierType)) {
      logger.warn(`Unsupported identifier type ${identifierType} for identifier ${playerIdentifier}`);
      return null;
    }

    // we need to get ['data']['relationships']['player']['data']['id'] from the response
    const options = {
      type: "identifier",
      attributes: {
        type: identifierType == 'playerUID' ? 'reforgerUUID' : 'steamID', // named differently in BattleMetrics
        identifier: playerIdentifier
      }
    };

    // now use this.makeRequest to fetch the player ID
    try {
      const response = await this.makeRequest('/players/quick-match', 'POST', { data: [options] });
      if (response && response.data && response.data.length > 0) {
        const playerId = response.data[0].relationships.player.data.id;
        logger.info(`BM player ID for identifier ${playerIdentifier}: ${playerId}`);
        return playerId;
      } else {
        logger.warn(`No player found for identifier: ${playerIdentifier}`);
        return null;
      }
    } catch (error) {
      logger.error(`Error fetching BattleMetrics player URL: ${error.message}`);
      return null;
    }
  }

  // Fetch the BattleMetrics player URL using the player identifier
  // This can be either a Reforger UUID or a Steam ID
  async fetchBMPlayerURL(playerIdentifier) {
    if (!this.isInitialized) { return null; }

    logger.verbose(`[${this.name}] Fetching BattleMetrics player URL for identifier: ${playerIdentifier}`);
    const playerId = await this.fetchBMPlayerId(playerIdentifier);
    return playerId ? `https://www.battlemetrics.com/rcon/players/${playerId}` : null;
  }
}

module.exports = BattleMetrics;