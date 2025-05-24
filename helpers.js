function escapeMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/`/g, '\\`')
    .replace(/~/g, '\\~')
    .replace(/\|/g, '\\|')
    .replace(/>/g, '\\>')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/#/g, '\\#');
}

// Take a string and figure out if it's
// 1) A BE GUID
// 2) A Reforger UUID (playerUID)
// 3) A player name
// 4) An IP address
// 5) A steamID
// and return the type:
// 'beGUID', 'playerUID', 'playerName', 'playerIP', 'steamid' - correspond to the player table columns
function classifyUserQueryInfo(userQueryInfo) {
  if (userQueryInfo.length === 36) {
    // Check if it's a UUID
    const isReforgerUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      userQueryInfo
    );
    if (isReforgerUUID) {
      return 'playerUID';
    }
  }

  // Check if it's a BE GUID - e.g. dbca018c92fa46a84aa535bfef7fd412
  const isBEGUID = /^[0-9a-f]{32}$/i.test(userQueryInfo);
  if (isBEGUID) {
    return 'beGUID';
  }

  // Check if it's a steamid - e.g. 76561199222022742
  const isSteamId = /^7656119[0-9]{10}$/i.test(userQueryInfo);
  if (isSteamId) {
    return 'steamID';
  }
  
  // Check if it's an IP address - e.g. 1.2.3.4
  // ^((25[0-5]|(2[0-4]|1\d|[1-9]|)\d)\.?\b){4}$
  const isIP = /^((25[0-5]|(2[0-4]|1\d|[1-9]|)\d)\.?\b){4}$/i.test(
    userQueryInfo
  );
  if (isIP) {
    return 'playerIP';
  }

  // if none of the above, it's a player name
  return 'playerName';
}

  // Helper to parse log date as UTC
function parseLogDate(dateString) {
  // Expects format: YYYY-MM-DD HH:mm:ss.SSS
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(dateString);
  if (!match) return null;
  const [ , year, month, day, hour, min, sec, ms ] = match.map(Number);
  return new Date(year, month - 1, day, hour, min, sec, ms);
}

// Function to get the user's maximum role level
function getUserMaxRoleLevel(discordUserRoles, config) {
  let maxLevel = 0;
  for (const [levelKey, roleNameArray] of Object.entries(config.roleLevels)) {
    const numericLevel = parseInt(levelKey, 10);
    if (isNaN(numericLevel)) continue;

    for (const roleName of roleNameArray) {
      const discordRoleID = config.roles[roleName];
      if (discordRoleID && discordUserRoles.includes(discordRoleID)) {
        if (numericLevel > maxLevel) {
          maxLevel = numericLevel;
        }
      }
    }
  }
  return maxLevel;
}

module.exports = {
  escapeMarkdown,
  classifyUserQueryInfo,
  parseLogDate
};