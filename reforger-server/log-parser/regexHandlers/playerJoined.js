const { EventEmitter } = require('events');

// This is the sequence of log entries we get when a new player joins:
//
// 00:57:25.897  DEFAULT      : BattlEye Server: Adding player identity=0x00000000, name='Mr Player Name'
// 00:57:25.897  DEFAULT      : BattlEye Server: 'Player #0 Mr Player Name (100.232.104.24:57605) connected'
// 00:57:25.897  DEFAULT      : BattlEye Server: Setting GUID for player identity=0x00000000, GUID=32561118877819724
// 00:57:25.897  DEFAULT      : BattlEye Server: 'Player #0 Mr Player Name - BE GUID: 95ce5996e283db135343dc1a67d3ab25'


class PlayerJoinedHandler extends EventEmitter {
    constructor() {
        super();
        this.lineOneRegex = /^(\d{2}:\d{2}:\d{2}\.\d{3})\s+DEFAULT\s+: BattlEye Server: Adding player identity=(0x[0-9a-fA-F]+), name='(.*?)'/;
        this.lineTwoRegex = /^(\d{2}:\d{2}:\d{2}\.\d{3})\s+DEFAULT\s+: BattlEye Server: 'Player\s+#(\d+)\s+(.*?)\s+\(([^):]+)(?::\d+)?\)\s+connected'/;
        this.lineThreeRegex = /^(\d{2}:\d{2}:\d{2}\.\d{3})\s+DEFAULT\s+: BattlEye Server: Setting GUID for player identity=(0x[0-9a-fA-F]+), GUID=(\d+)/;
        this.lineFourRegex = /^(\d{2}:\d{2}:\d{2}\.\d{3})\s+DEFAULT\s+: BattlEye Server: 'Player\s+#(\d+)\s+.*-\s+BE\s+GUID:\s+([a-fA-F0-9]{32})'/;

        this.pendingJoins = new Map();
    }

    test(line) {
        return this.lineOneRegex.test(line) || this.lineTwoRegex.test(line) || this.lineThreeRegex.test(line) || this.lineFourRegex.test(line);
    }

    processLine(line) {
        // We exploit the fact that all four lines share the same timestamp, so we use that as the map key

        // First line we get sent the player identity and player name
        const matchLineOne = this.lineOneRegex.exec(line);
        if (matchLineOne) {
            const time = matchLineOne[1];
            const playerIdentity = matchLineOne[2];
            const playerName = matchLineOne[3];

            this.pendingJoins.set(time, {
                time,
                playerName,
            });

            return;
        }

        // Second line we get sent the player number, player name and IP
        const matchLineTwo = this.lineTwoRegex.exec(line);
        if (matchLineTwo) {
            const time = matchLineTwo[1];
            const playerNumber = matchLineTwo[2];
            const playerName = matchLineTwo[3];
            let playerIP = matchLineTwo[4];

            playerIP = playerIP.trim();

            const playerData = this.pendingJoins.get(time);
            if (playerData) {
                existingEntry.playerNumber = playerNumber;
                existingEntry.playerIP = playerIP;
            }

            return;
        }

        // Third line we get sent the player identity and GUID (if it's in the logs as a number, it's the Steam ID)
        const matchLineThree = this.lineThreeRegex.exec(line);
        if (matchLineThree) {
            const time = matchLineThree[1];
            const playerIdentity = matchLineThree[2];
            const steamID64 = matchLineThree[3];

            const playerData = this.pendingJoins.get(time);
            if (playerData) {
                playerData.steamID64 = steamID64;
            }
        }

        // Fourth line we get sent the player number, player name and BE GUID
        const matchLineFour = this.lineFourRegex.exec(line);
        if (matchLineFour) {
            const time = matchLineFour[1];
            const beGUID = matchLineFour[3];

            const playerData = this.pendingJoins.get(time);
            if (playerData) {
                playerData.beGUID = beGUID;

                this.emit('playerJoined', playerData);

                this.pendingJoins.delete(time);
            }
        }
    }
}

module.exports = PlayerJoinedHandler;
