const { classifyUserQueryInfo } = require('../helpers');
const logger = require('./logger/logger');


class BattleMetrics {
  constructor(config) {
    if (!config || !config.connectors || !config.connectors.battlemetrics) {
      throw new Error("BattleMetrics configuration is missing");
    }

    const bmConfig = config.connectors.battlemetrics;
    if (
      !bmConfig.token ||
      !bmConfig.orgID ||
      !bmConfig.serverID ||
      !bmConfig.listID
    ) {
      throw new Error(
        "BattleMetrics configuration is incomplete (token, orgID, serverID, or listID missing)"
      );
    }
    this.name = "BattleMetricsAPI";
    this.config = bmConfig;
    this.baseUrl = "https://api.battlemetrics.com";
    this.headers = {
      Authorization: `Bearer ${this.config.token}`,
      "Content-Type": "application/json",
    };

    this.playerIdCache = new Map();
    this.cacheTTL = 30 * 60 * 1000;

    // Store the ban objects in a map for quick access - mapped to the 
    this.banCache = new Map();

    this.initialized = false;
  }

  /**
   * Validate API credentials by fetching organization info
   * @returns {Promise<boolean>} True if validation succeeds, throws error otherwise
   */
  async validateCredentials() {
    try {
      const orgInfo = await this.fetchOrganization(this.config.orgID);
      const orgName = orgInfo.attributes.name;

      logger.info(
        `BattleMetrics API validated successfully for organization: ${orgName}`
      );
      this.initialized = true;
      return true;
    } catch (error) {
      let errorMessage = `BattleMetrics API validation failed: ${error.message}`;

      if (error.response) {
        const status = error.response.status;
        const errorData = error.response.data;

        if (status === 401) {
          errorMessage = `BattleMetrics API validation failed: Invalid API token (401 Unauthorized)`;
        } else if (status === 403) {
          errorMessage = `BattleMetrics API validation failed: Insufficient permissions (403 Forbidden)`;
        } else if (status === 404) {
          errorMessage = `BattleMetrics API validation failed: Organization ID '${this.config.orgID}' not found (404 Not Found)`;
        } else if (status === 429) {
          errorMessage = `BattleMetrics API validation failed: Rate limit exceeded (429 Too Many Requests)`;
        } else {
          errorMessage = `BattleMetrics API validation failed: HTTP ${status} - ${JSON.stringify(
            errorData
          )}`;
        }
      }

      logger.error(errorMessage);
      throw new Error(errorMessage);
    }
  }

  async cleanup() {
    // Cleanup logic if needed
  }

  makeFullURL(endpoint) {
    if (!this.baseUrl || !endpoint) {
      throw new Error("Base URL or endpoint is not defined");
    }
    return `${this.baseUrl}${endpoint}`;
  }

  async makeRequest(url, method = 'GET', body = null) {
    logger.verbose(`[${this.name}] Making request to BattleMetrics: ${url} with method: ${method} and token length of: ${this.config.token.length}`);
    const options = {
      method,
      headers: this.headers,
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

  async fetchOrganization(orgId) {
    const response = await this.makeRequest(this.makeFullURL(`/organizations/${orgId}`));
    logger.verbose(`[${this.name}] Fetched organization info for ID ${orgId}:\n${JSON.stringify(response, null, 2)}`);
    return response.data;
  }

  async fetchBMPlayerId(playerIdentifier) {
    if (!this.initialized) {
      logger.warn('BattleMetrics is not initialized. Cannot fetch player ID.');
      return null;
    }

    // Get the shape of the playerIdentifier using helper classifyUserQueryInfo()
    logger.verbose(`[${this.name}] Fetching BattleMetrics player ID for identifier: ${playerIdentifier}`);
    playerIdentifier = playerIdentifier.trim();
    if (!playerIdentifier || playerIdentifier.length === 0) {
      logger.warn('playerIdentifier is empty or invalid.');
      return null;
    }

    if (this.playerIdCache.has(playerIdentifier)) {
      logger.verbose(`Checking cache for BattleMetrics player ID for playerIdentifier: ${playerIdentifier}`);
      const cachedData = this.playerIdCache.get(playerIdentifier);
      if (Date.now() < cachedData.expiresAt) {
        logger.verbose(
          `Using cached BattleMetrics player ID for playerIdentifier: ${playerIdentifier}`
        );
        return cachedData.bmPlayerId;
      } else {
        this.playerIdCache.delete(playerIdentifier);
      }
    } else {
      logger.verbose(`No cached BattleMetrics player ID for playerIdentifier: ${playerIdentifier}`);
    }

    const identifierType = classifyUserQueryInfo(playerIdentifier);
    const validIdentifierTypes = ['playerUID', 'steamID'];
    if (!validIdentifierTypes.includes(identifierType)) {
      logger.warning(`Unsupported identifier type ${identifierType} for identifier ${playerIdentifier}`);
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
      const response = await this.makeRequest(this.makeFullURL('/players/quick-match'), 'POST', { data: [options] });
      logger.verbose(`[${this.name}] Response from BattleMetrics for player identifier ${playerIdentifier}:\n${JSON.stringify(response, null, 2)}`);

      if (response && response.data && response.data.length > 0) {
        const bmPlayerId = response.data[0].relationships.player.data.id;
        logger.info(`BM player ID for identifier ${playerIdentifier}: ${bmPlayerId}`);

        this.playerIdCache.set(playerIdentifier, {
          bmPlayerId,
          expiresAt: Date.now() + this.cacheTTL,
        });

        return bmPlayerId;
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
    if (!this.initialized) {
      logger.warn('BattleMetrics is not initialized. Cannot fetch player ID.');
      return null;
    }

    logger.verbose(`[${this.name}] Fetching BattleMetrics player URL for identifier: ${playerIdentifier}`);
    const playerId = await this.fetchBMPlayerId(playerIdentifier);

    return playerId ? `https://www.battlemetrics.com/rcon/players/${playerId}` : null;
  }

  async fetchBanList() {
    if (!this.initialized) {
      logger.warn('BattleMetrics is not initialized. Cannot fetch ban list.');
      return [];
    }

    // curl https://api.battlemetrics.com/bans \
    // -G \
    // -d "filter[expired]=false" \
    // -d "filter[exempt]=false" \
    // -d "filter[organization]=25069" \
    // -d "filter[banList]=9f172ad0-9e97-11ee-a3b7-f9dee4010c6b" \
    // -d "page[size]=100" \
    // -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0b2tlbiI6ImNlNWMyYTJmNmZiODljMGQiLCJpYXQiOjE3NTA3ODUyMDIsIm5iZiI6MTc1MDc4NTIwMiwiaXNzIjoiaHR0cHM6Ly93d3cuYmF0dGxlbWV0cmljcy5jb20iLCJzdWIiOiJ1cm46dXNlcjoxMDA2NDkwIn0.fTzpMpYKYa9eh4E_kYOhZK7C4rWroknj4MRR-J9Dpzw"


    const baseOptions = {
      'filter[expired]': false,
      'filter[exempt]': false,
      'filter[organization]': this.config.orgID,
      'filter[banList]': this.config.listID,
      'page[size]': 100
    }

    var done = false;
    var allBans = [];
    var nextPageUrl = null;

    while (!done) {
      try {
        // turn the baseOptions into a query string
        const queryString = new URLSearchParams(baseOptions).toString();
        const url = nextPageUrl || this.makeFullURL(`bans?${queryString}`);
        logger.verbose(`[${this.name}] Fetching BattleMetrics ban list from: ${url}`);
        const response = await this.makeRequest(url);
        if (response && response.data) {
          allBans = allBans.concat(response.data);
          logger.info(`Fetched ${response.data.length} bans from BattleMetrics`);
          // Check if there's a next page
          if (response.links && response.links.next) {
            nextPageUrl = response.links.next;
            logger.verbose(`[${this.name}] Next page URL: ${nextPageUrl}`);
          } else {
            done = true;
            logger.verbose(`[${this.name}] No more pages to fetch.`);
          }
        } else {
          logger.warn(`[${this.name}] No data found in BattleMetrics response.`);
          done = true; // Exit loop if no data is found
        }
      } catch (error) {
        logger.error(`[${this.name}] Error fetching BattleMetrics ban list: ${error.message}`);
        done = true; // Exit loop on error
      }
    }



    // {
    // "meta": {
    //   "active": 464,
    //   "expired": 0,
    //   "total": 464
    // },
    // "links": {
    //   "next": "https://api.battlemetrics.com/bans?filter%5Bexpired%5D=false&filter%5Bexempt%5D=false&filter%5Borganization%5D=25069&filter%5BbanList%5D=9f172ad0-9e97-11ee-a3b7-f9dee4010c6b&page%5Bsize%5D=100&page%5Bkey%5D=2025-05-28T09%3A58%3A59.849Z%2C150678470&page%5Brel%5D=next"
    // },
    // "data": [
    // {
    //   "type": "ban",
    //   "id": "153866004",
    //   "meta": {
    //     "player": "gOONERS"
    //   },
    //   "attributes": {
    //     "id": "153866004",
    //     "uid": "mELjXZLaa",
    //     "timestamp": "2025-06-24T13:53:20.549Z",
    //     "reason": "Intentional team-killing is not tolerated - Expires: {{expires}} - Appeal at: discord.exd.gg",
    //     "note": "<p>Intentional TK, reported by EXD member <span style=\"color: var(--header-primary)\">backifran</span></p>",
    //     "identifiers": [
    //       {
    //         "id": 638745989,
    //         "type": "reforgerUUID",
    //         "private": true,
    //         "lastSeen": "2025-06-24T13:37:08.094Z"
    //       }
    //     ],
    //     "expires": null,
    //     "autoAddEnabled": false,
    //     "nativeEnabled": null,
    //     "orgWide": true
    //   },
    //   "relationships": {
    //     "server": {
    //       "data": {
    //         "type": "server",
    //         "id": "31450723"
    //       }
    //     },
    //     "organization": {
    //       "data": {
    //         "type": "organization",
    //         "id": "25069"
    //       }
    //     },
    //     "player": {
    //       "data": {
    //         "type": "player",
    //         "id": "1187012324"
    //       }
    //     },
    //     "banList": {
    //       "data": {
    //         "type": "banList",
    //         "id": "9f172ad0-9e97-11ee-a3b7-f9dee4010c6b"
    //       }
    //     }
    //   }
    // },
    // ...
    // ]
    // }


  }

}

module.exports = BattleMetrics;