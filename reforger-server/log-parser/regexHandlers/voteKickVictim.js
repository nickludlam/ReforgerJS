const { EventEmitter } = require("events");

class VoteKickVictimHandler extends EventEmitter {
    constructor() {
        super();
        this.identityLineRegex = /Disconnecting identity=(0x[0-9A-F]+): group=6 reason=1/; 
        this.playerDisconnectRegex = /BattlEye Server: 'Player #\d+ (.+?) disconnected'/;

        this.pendingKicks = new Map();
    }
    test(line) {
        return this.identityLineRegex.test(line) || this.playerDisconnectRegex.test(line);
      }
    processLine(line) {
        const identityMatch = this.identityLineRegex.exec(line);
        if (identityMatch) {
            const identity = identityMatch[1];
            this.pendingKicks.set(identity, {
                identity,
                group: 6,
                reason: 1,
                playerName: null,
            });
            return;
        }

        const playerMatch = this.playerDisconnectRegex.exec(line);
        if (playerMatch) {
            const playerName = playerMatch[1];

            for (const [identity, kickData] of this.pendingKicks.entries()) {
                if (!kickData.playerName) {
                    kickData.playerName = playerName;

                    this.emit("voteKickVictim", kickData);
                    this.pendingKicks.delete(identity);
                    return;
                }
            }
        }
    }
}

module.exports = VoteKickVictimHandler;
