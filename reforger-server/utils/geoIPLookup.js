/**
 * GeoIP Lookup Service
 * Provides country lookup functionality using MaxMind GeoLite2 database
 * with caching to prevent repeated database reads
 */
const fs = require('fs');
const path = require('path');
const { Reader } = require('@maxmind/geoip2-node');

class GeoIPLookup {
  constructor() {
    this.reader = null;
    this.cache = new Map();
    this.initializationAttempted = false;
  }

  /**
   * Initialize the GeoIP database reader
   * @param {string} customDbPath Optional custom path to the GeoIP database file
   * @returns {boolean} Whether initialization was successful
   */
  initialize(customDbPath = null) {
    if (this.reader) {
      return true; // Already initialized
    }

    if (this.initializationAttempted) {
      return false; // Already tried and failed
    }

    this.initializationAttempted = true;

    this.filename = 'GeoLite2-Country.mmdb'; // Default filename
    try {
      // Try to locate the database file in various potential locations
      const potentialPaths = [
        customDbPath,
        path.resolve(__dirname, `../../${this.filename}`),             // From the ReforgerJS directory
        path.resolve(__dirname, `../${this.filename}`),                // From the reforger-server directory
        `/usr/local/share/GeoIP/${this.filename}`,                     // Common Linux location
        `/usr/share/GeoIP/${this.filename}`                           // Another common Linux location
      ].filter(Boolean); // Remove null entries

      let dbBuffer = null;
      let foundPath = null;

      for (const dbPath of potentialPaths) {
        try {
          if (fs.existsSync(dbPath)) {
            dbBuffer = fs.readFileSync(dbPath);
            foundPath = dbPath;
            break;
          }
        // eslint-disable-next-line no-unused-vars
        } catch (err) {
          // Continue to next path
        }
      }

      if (!dbBuffer) {
        console.error('[GeoIPLookup] Could not find GeoIP database file.');
        return false;
      }

      console.log(`[GeoIPLookup] Successfully loaded GeoIP database from: ${foundPath}`);
      this.reader = Reader.openBuffer(dbBuffer);
      
      // Add a test lookup to verify structure and log it for debugging
      
      // try {
      //   const testIP = '8.8.8.8'; // Google DNS as test
        
      //   // Try to use an appropriate lookup method
      //   let result;
      //   if (typeof this.reader.get === 'function') {
      //     result = this.reader.get(testIP);
      //   } else if (typeof this.reader.country === 'function') {
      //     result = this.reader.country(testIP);
      //   } else if (typeof this.reader.lookup === 'function') {
      //     result = this.reader.lookup(testIP);
      //   } else {
      //     throw new Error('No suitable lookup method found on reader');
      //   }
        
      //   console.log(`[GeoIPLookup] Test lookup for ${testIP}:`, 
      //     JSON.stringify(result, null, 2)
      //   );
      // } catch (testError) {
      //   console.error(`[GeoIPLookup] Test lookup error: ${testError.message}`);
      // }
      return true;
    } catch (error) {
      console.error(`[GeoIPLookup] Error initializing GeoIP database: ${error.message}`);
      return false;
    }
  }

  /**
   * Get country information for an IP address
   * @param {string} ip The IP address to look up
   * @returns {Object|null} Country information or null if lookup failed
   */
  getCountryInfo(ip) {
    if (!ip || ip === 'localhost' || ip === '127.0.0.1') {
      return { country: { names: { en: 'Local Network' } } };
    }

    // Check cache first
    if (this.cache.has(ip)) {
      return this.cache.get(ip);
    }

    // Initialize if needed
    if (!this.reader && !this.initialize()) {
      return null;
    }

    try {
      // Use reflection to list all the methods on the reader
      const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(this.reader));
      console.log(`[GeoIPLookup] Available methods on reader: ${methods.join(', ')}`); 

      // Use the appropriate method based on what's available
      let result;
      if (typeof this.reader.get === 'function') {
        result = this.reader.get(ip);
      } else if (typeof this.reader.country === 'function') {
        result = this.reader.country(ip);
      } else if (typeof this.reader.lookup === 'function') {
        result = this.reader.lookup(ip);
      } else {
        throw new Error('No suitable lookup method found on reader');
      }
      
      // Cache the result
      this.cache.set(ip, result);
      return result;
    } catch (error) {
      // Don't cache errors
      console.error(`[GeoIPLookup] Error looking up IP address ${ip}: ${error.message}`);
      return null;
    }
  }

  /**
   * Get the country name for an IP address
   * @param {string} ip The IP address to look up
   * @param {string} language The language code, default 'en'
   * @returns {string} Country name or 'Unknown'
   */
  getCountryName(ip, language = 'en') {
    if (!ip) return 'Unknown';
    
    const countryInfo = this.getCountryInfo(ip);
    
    if (!countryInfo) {
      return 'Unknown';
    }
    
    // Handle different possible response structures
    const country = countryInfo.country || countryInfo.registered_country || {};
    const names = country.names || {};
    return names[language] || names.en || 'Unknown';
  }

  /**
   * Get both country name and ISO code for an IP address
   * @param {string} ip The IP address to look up
   * @returns {Object} Object with country name and ISO code
   */
  getCountryData(ip) {
    if (!ip) return { name: 'Unknown', isoCode: '' };
    
    const countryInfo = this.getCountryInfo(ip);
    
    if (!countryInfo) {
      return { name: 'Unknown', isoCode: '' };
    }
    
    // Handle different possible response structures and fields
    // MaxMind GeoIP2 databases can have different response formats
    const country = countryInfo.country || countryInfo.registered_country || {};
    const names = country.names || {};
    
    // Try various possible field names for ISO code
    const isoCode = country.iso_code || country.isoCode || country.code || '';
    
    // Log the structure if we're having trouble with it
    if (!names.en && Object.keys(countryInfo).length > 0) {
      console.log('[GeoIPLookup] Unexpected response structure:', JSON.stringify(countryInfo, null, 2));
    }
    
    return {
      name: names.en || 'Unknown',
      isoCode: isoCode
    };
  }
}

// Create and export a singleton instance
const geoIPLookup = new GeoIPLookup();

module.exports = geoIPLookup;
