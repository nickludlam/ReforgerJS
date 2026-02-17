const { parseLogDate } = require('../../../helpers');
const { EventEmitter } = require('events');

class PlayerDisconnectedHandler extends EventEmitter {
    constructor() {
        super();
        // 2025-05-08 20:45:31.153  DEFAULT      : BattlEye Server: 'Player #283 Cat disconnected'
        this.lineDisconnectedPlayer = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+DEFAULT\s+: BattlEye Server: 'Player\s+#(\d+)\s+(.*?)\s+disconnected'/;        
    }

    test(line) {
        return this.lineDisconnectedPlayer.test(line)
    }

    processLine(line) {
        const matchLineRemovingPlayer = this.lineDisconnectedPlayer.exec(line);
        if (matchLineRemovingPlayer) {
            const time = parseLogDate(matchLineRemovingPlayer[1]);
            // const playerConnectionNumber = matchLineRemovingPlayer[2];
            const playerName = matchLineRemovingPlayer[3];

            const playerData = {
              time,
              playerName,
            };
            this.emit('playerDisconnected', playerData);
            return;
        }
    }
}

module.exports = PlayerDisconnectedHandler;