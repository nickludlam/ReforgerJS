const { EventEmitter } = require("events");

class VoteKickVictimHandler extends EventEmitter {
    constructor() {
        super();
        // Regex to match the "identity" line and the player disconnect line
        this.identityLineRegex = /Disconnecting identity=(0x[0-9A-F]+): group=6 reason=1/; 
        this.playerDisconnectRegex = /BattlEye Server: 'Player #\d+ (.+?) disconnected'/;

        // Map to temporarily store kick events by identity
        this.pendingKicks = new Map();
    }
    test(line) {
        return this.identityLineRegex.test(line) || this.playerDisconnectRegex.test(line);
      }
    processLine(line) {
        // Match the identity line (e.g., "Disconnecting identity=0x00000001: group=6 reason=1")
        const identityMatch = this.identityLineRegex.exec(line);
        if (identityMatch) {
            const identity = identityMatch[1];
            // Add to the pending kicks map with the identity
            this.pendingKicks.set(identity, {
                identity,
                group: 6,
                reason: 1,
                playerName: null, // Will be filled in later
            });
            return; // Processed, exit early
        }

        // Match the player disconnect line (e.g., "Player #1 [DubV] BanditSlav disconnected")
        const playerMatch = this.playerDisconnectRegex.exec(line);
        if (playerMatch) {
            const playerName = playerMatch[1];

            // Look for a matching identity in the pendingKicks map
            for (const [identity, kickData] of this.pendingKicks.entries()) {
                if (!kickData.playerName) {
                    // Update the kickData with the playerName
                    kickData.playerName = playerName;

                    // Emit the event and remove the entry from the map
                    this.emit("voteKickVictim", kickData);
                    this.pendingKicks.delete(identity);
                    return; // Exit after processing
                }
            }
        }
    }
}

module.exports = VoteKickVictimHandler;
