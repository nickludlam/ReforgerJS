const { EventEmitter } = require('events');

class PlayerJoinedHandler extends EventEmitter {
    constructor() {
        super();
        this.lineOneRegex = /^(\d{2}:\d{2}:\d{2}\.\d{3})\s+DEFAULT\s+: BattlEye Server: 'Player\s+#(\d+)\s+(.*?)\s+\(([^):]+)(?::\d+)?\)\s+connected'/;
        this.lineThreeRegex = /^\d{2}:\d{2}:\d{2}\.\d{3}\s+DEFAULT\s+: BattlEye Server: 'Player\s+#(\d+)\s+.*-\s+BE\s+GUID:\s+([a-fA-F0-9]{32})'/;

        this.pendingJoins = new Map();
    }

    test(line) {
        return this.lineOneRegex.test(line) || this.lineThreeRegex.test(line);
    }

    processLine(line) {
        const matchLineOne = this.lineOneRegex.exec(line);
        if (matchLineOne) {
            const time = matchLineOne[1];
            const playerNumber = matchLineOne[2];
            const playerName = matchLineOne[3];
            let playerIP = matchLineOne[4];

            playerIP = playerIP.trim();

            this.pendingJoins.set(playerNumber, {
                time,
                playerNumber,
                playerName,
                playerIP,
                beGUID: null,
            });

            return;
        }

        const matchLineThree = this.lineThreeRegex.exec(line);
        if (matchLineThree) {
            const playerNumber = matchLineThree[1];
            const beGUID = matchLineThree[2];

            const playerData = this.pendingJoins.get(playerNumber);
            if (playerData) {
                playerData.beGUID = beGUID;

                this.emit('playerJoined', playerData);

                this.pendingJoins.delete(playerNumber);
            }
        }
    }
}

module.exports = PlayerJoinedHandler;
