# ReforgerJS 

## **About**
A 3rd party Javascript framework for monitoring and admining your Arma Reforger server

<br>

## **Using ReforgerJS**
ReforgerJS relies on being able to access the Reforger server log directory in order to parse logs live to collect information. Thus, ReforgerJS must be hosted on the same server box as your Reforger server.

#### Installation
1. [Download ReforgerJS](https://github.com/ZSU-GG-Reforger/ReforgerJS/releases/latest) and unzip the download.
2. Open the unzipped folder in your terminal.
3. Install the dependencies by running `npm install` in your terminal.
4. Configure the `config.json` file. See below for more details.
5. Once you have enabled the commands you wish to run. Before running the bot, Run the command loader `node deploy-commands.js`
6. Start ReforgerJS by running `node index.js` in your terminal.

<br>

## **Configuring ReforgerJS**
<details>
  <summary>Server</summary>

## Server Configuration


  ```json
  "server": {
    "id": 1,
    "name": "SERVER NAME",
    "host": "xxx.xxx.xxx.xxx",
    "queryPort": 00000,
    "rconPort": 00000,
    "rconPassword": "password",
    "logReaderMode": "tail",
    "logDir": "C:/path/to/reforger/log/folder",
  },
  "consoleLogLevel": "info",
  "outputLogLevel": "info",
  ```
* `id` - An integer ID to uniquely identify the server.
* `name` - The Name of the server. Used by several plugins.
* `host` - The IP of the server.
* `queryPort` - The query port of the server.
* `rconPort` - The RCON port of the server.
* `rconPassword` - The RCON password of the server.
* `logReaderMode` - `tail` will read from a local log file, Future plans for `FTP`/`SFTP`
* `logDir` - The folder where your Reforger logs are saved.

* `consoleLogLevel` - Level of logging to be logged to the console
* `outputLogLevel` - Level of logging to be logged to the saved log files
Log Levels: `verbose` | `info` | `warn` | `error`

  ---
</details>

<details>
  <summary>Connectors</summary>

## Connector Configuration

Connectors allow ReforgerJS to communicate with external resources.

##### Discord
Connects to Discord via `discord.js`.
  ```json
  "connectors": {
    "discord": {
      "token": "",
      "clientId":"",
      "guildId": ""
    }
  },
  ```
* `token` - Discord bot login token.
* `clientId` - ClientID of the bot.
* `guildId` - GuildID of the server your are wanting to connect to.


##### Databases
ReforgerJS uses MySQL for data saved by plugins

  ```json
    "mysql": {
      "enabled": false,
      "host": "host",
      "port": 3306,
      "username": "",
      "password": "",
      "database": "",
      "dialect": ""
    }
  ```

  ---
</details>

<details>
  <summary>Commands</summary>

## Discord Commands Configuration

Commands include a permission system. They can be restricted to select discord Roles.

##### Roles
List of Discord Role IDs
  ```json
  "roles": {
    "roleName": "discord RoleID",
    "roleName1": "discord RoleID",
    "roleName2": "discord RoleID",
    "roleName3": "discord RoleID"
  }
  ```
Role names can be customised. These names are used for `roleLevels`


##### RoleLevels
Role levels are the permission levels allocted to your discord roles. For example; Level 1 has full access to every command, Level 3 can only access level 3 or lower commands

  ```json
  "roleLevels": {
    "1": [
      "roleName",
      "roleName1"
    ],
    "2": [
      "roleName2"
    ],
    "3": [
      "roleName3"
    ]
  }
  ```

##### Commands
Discord Slash Commands

  ```json
  "commands": [
    {
      "command": "whois",
      "enabled": false,
      "commandLevel": 3
    }
  ],
  ```
* `command` - Command name, Must match name to the command located in the `commands` folder
* `enabled` - Enabled the command. `deploy-commands` will only load commands that are enabled in teh config
* `commandLevel` - Permission level to allocate command to.

  ---
</details>

### Inspired by SquadJS - Team Silver Sphere
https://github.com/Team-Silver-Sphere/SquadJS