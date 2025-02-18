const { EventEmitter } = require('events');

class PlayerJoinedHandler extends EventEmitter {
    constructor() {
        super();
        // Regex for the three types of lines
        this.lineOneRegex = /^(\d{2}:\d{2}:\d{2}\.\d{3})\s+DEFAULT\s+: BattlEye Server: 'Player\s+#(\d+)\s+(.*?)\s+\(([^):]+)(?::\d+)?\)\s+connected'/;
        this.lineThreeRegex = /^\d{2}:\d{2}:\d{2}\.\d{3}\s+DEFAULT\s+: BattlEye Server: 'Player\s+#(\d+)\s+.*-\s+BE\s+GUID:\s+([a-fA-F0-9]{32})'/;

        // Temporary storage for multi-line data
        this.pendingJoins = new Map();
    }

    // New test method to check if the line matches any expected format
    test(line) {
        return this.lineOneRegex.test(line) || this.lineThreeRegex.test(line);
    }

    processLine(line) {
        // Match the first line
        const matchLineOne = this.lineOneRegex.exec(line);
        if (matchLineOne) {
            const time = matchLineOne[1];
            const playerNumber = matchLineOne[2];
            const playerName = matchLineOne[3];
            let playerIP = matchLineOne[4];

            // Ensure the playerIP contains only the IP address without the port
            playerIP = playerIP.trim();

            // Initialize pending data for this player
            this.pendingJoins.set(playerNumber, {
                time,
                playerNumber,
                playerName,
                playerIP, // Port already removed in regex
                beGUID: null, // Will be populated later
            });

            return; // Exit after processing the first line
        }

        // Match the third line for BE GUID
        const matchLineThree = this.lineThreeRegex.exec(line);
        if (matchLineThree) {
            const playerNumber = matchLineThree[1];
            const beGUID = matchLineThree[2];

            // Update the pending data with the BE GUID
            const playerData = this.pendingJoins.get(playerNumber);
            if (playerData) {
                playerData.beGUID = beGUID;

                // Emit the 'playerJoined' event once all data is collected
                this.emit('playerJoined', playerData);

                // Remove the processed player from the pendingJoins map
                this.pendingJoins.delete(playerNumber);
            }
        }
    }
}

module.exports = PlayerJoinedHandler;
