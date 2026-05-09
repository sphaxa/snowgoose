const https = require('https');
const fs = require('fs');
const express = require('express');
require('dotenv').config();
const { Rcon } = require('rcon-client');
const axios = require('axios');
const { NodeSSH } = require('node-ssh');

module.exports = {
  meta: {
    name: "Serverstate v2",
    enabled: true
  },
  data: {},
  async execute(client) {
    console.log('[SERVERSTATE MODULE] Fetching server data from API...');

    // Map for message handling (keyed by channel ID)
    let channelServers = {};
    // Map for the RCON endpoint (keyed by ip:port)
    let serverAddressMap = {};
    // List of allowable SSH commands
    let sshCmdAllowlist = ['start', 'stop', 'update', 'details'];
    // Per-server RCON queues (keyed by ip:port) to prevent concurrent connection collisions
    const rconQueues = {};

    let hardcodedChannelIds = [];
    let publicChannelIds = [];
    const app = express();
    app.use(express.json());

    // **Load PFX Certificate**
    const options = {
      pfx: fs.readFileSync('C:/certs/mycert_fullchain.pfx'),
      requestCert: false,
      passphrase: "root"
    };

    async function fetchServerData() {
      try {
        let servers1 = [];
        let servers2 = [];

        try {
          const response = await axios.get('https://frag.to/api/servers/all-sg', {
            headers: { 'X-Api-Key': process.env.API_KEY }
          });
          servers1 = response.data;
        } catch (error) {
          console.warn('[SERVERSTATE MODULE] Warning: Failed to fetch from frag.to API:', error.message);
        }

        try {
          const response2 = await axios.get('https://2.frag.to/api/servers/all-sg', {
            headers: { 'X-Api-Key': process.env.API_KEY }
          });
          servers2 = response2.data;
        } catch (error) {
          console.warn('[SERVERSTATE MODULE] Warning: Failed to fetch from 2.frag.to API:', error.message);
        }

        const servers = [...servers1, ...servers2];

        console.log(servers);

        // Reset maps so removed servers don't linger
        channelServers = {};
        serverAddressMap = {};

        servers.forEach(server => {
          const [ip, port] = server.address.split(':');
          const serverData = { 
            name: server.name, 
            ip, 
            port: parseInt(port), 
            password: server.rconPassword,
            sshUsername: server.machineUsername,
            sshPassword: server.machinePassword
          };

          // Use matchroomId as the key for channelServers (for message handling)
          channelServers[server.matchroomId] = serverData;
          // Also store the server data by ip:port for the RCON API
          serverAddressMap[`${ip}:${port}`] = serverData;
        });

        // These arrays now store the channel IDs for the two types of channels
        hardcodedChannelIds = servers.map(server => server.matchroomId);
        publicChannelIds = servers.map(server => server.publicChannelId);

        console.log('[SERVERSTATE MODULE] Successfully fetched server data.');
      } catch (error) {
        console.error('[SERVERSTATE MODULE] Error processing server data:', error);
      }
    }

    await fetchServerData();

    // Refresh server data every 5 minutes so stale/removed servers don't persist
    setInterval(() => {
      console.log('[SERVERSTATE MODULE] Refreshing server data...');
      fetchServerData();
    }, 5 * 60 * 1000);

    // Dedupe concurrent on-miss refreshes — many requests for the same unknown
    // server should only trigger one refetch, not N.
    let refreshInFlight = null;
    function refreshServerData() {
      if (!refreshInFlight) {
        refreshInFlight = fetchServerData().finally(() => {
          refreshInFlight = null;
        });
      }
      return refreshInFlight;
    }

    // Returns the tail of the promise chain for a given server, creating it if needed
    function getRconQueue(serverKey) {
      if (!rconQueues[serverKey]) {
        rconQueues[serverKey] = Promise.resolve();
      }
      return rconQueues[serverKey];
    }

    // Enqueues an RCON command for a server so concurrent requests don't collide
    function enqueueRcon(server, command) {
      console.log(`[SERVERSTATE MODULE] Enqueuing RCON command for ${server.ip}:${server.port} -> ${command}`);
      const key = `${server.ip}:${server.port}`;
      const next = getRconQueue(key).then(() => sendRconCommand(server, command));
      // Prevent a failed command from killing the queue for that server
      rconQueues[key] = next.catch(() => {});
      return next;
    }

    async function sendRconCommand(server, command) {
      let rcon;
      try {
        rcon = await Rcon.connect({
          host: server.ip,
          port: server.port,
          password: server.password,
          timeout: 5000  // 5s connect timeout — prevents hung servers from blocking the queue
        });

        rcon.on('error', (error) => {
          console.error(`[RCON] Connection error for ${server.ip}:${server.port}:`, error);
        });

        const response = await rcon.send(command);

        console.log(`[RCON] Response from ${server.ip}:${server.port}:`, response);
        return response;
      } catch (error) {
        console.error(`[RCON] Error sending command to ${server.ip}:${server.port}:`, error);
        return null;
      } finally {
        // Only close in finally — avoids the double rcon.end() bug
        if (rcon) {
          try {
            await rcon.end();
          } catch (err) {
            console.error(`[RCON] Error closing connection to ${server.ip}:${server.port}:`, err);
          }
        }
      }
    }

    async function sendSshCommand(server, command) {
      // Sanity check
      if (!sshCmdAllowlist.includes(command)) {
        return null;
      }

      let sshClient;
      let output = null;

      try {
        sshClient = new NodeSSH();

        await sshClient.connect({
          host: server.ip,
          port: 22,
          username: server.sshUsername,
          password: server.sshPassword
        });

        console.log(`[SSH] Connection established to ${server.name}`);

        let fullCommand = "./cs2server ";

        if (command === "details") {
          fullCommand = "TERM=xterm-256color " + fullCommand
            + `details | grep Status | tail -1 | awk -F':\\t' '{print $2}'`;
        } else {
          fullCommand += command;
        }

        fullCommand += ` | sed -r "s/\\x1B\\[([0-9]{1,3}(;[0-9]{1,3})*)?[mGK]//g"`;

        console.log(`[SSH] Executing command on ${server.name}: ${fullCommand}`);

        commandResult = await sshClient.execCommand(fullCommand, { cwd: `/home/${server.sshUsername}` });

        console.log(`[SSH] Response from ${server.name}: ${JSON.stringify(commandResult)}`);

        output = {
          status: commandResult.code,
          message: ""
        };

        if (commandResult.code != 0 && commandResult.stdout.length === 0) {
          output.message = commandResult.stderr;
        } else {
          const splitStdout = commandResult.stdout.split('\r');
          output.message = splitStdout[splitStdout.length - 1];
        }
      } catch (error) {
        console.error(`[SSH] Error sending command to ${server.name}:`, error);
      } finally {
        try {
          sshClient?.dispose();
        } catch (err) {
          console.error(`[SSH] Error closing connection to ${server.name}:`, err);
        }
      }

      return output;
    }
    
    // **Middleware for API Key Authentication**
    function authenticateApiKey(req, res, next) {
      const requestApiKey = req.headers['x-api-key'];

      if (!requestApiKey || requestApiKey !== process.env.API_KEY) {
        return res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
      }

      next();
    }

    // **Expose an RCON API Endpoint with API Key Protection**
    app.post('/rcon', authenticateApiKey, async (req, res) => {
      const { ip, port, command } = req.body;

      if (!ip || !port || !command) {
        return res.status(400).json({ error: 'Missing required parameters: ip, port, or command' });
      }

      const serverKey = `${ip}:${port}`;
      let server = serverAddressMap[serverKey];

      if (!server) {
        console.log(`[SERVERSTATE MODULE] ${serverKey} not in cache — refreshing before RCON dispatch`);
        await refreshServerData();
        server = serverAddressMap[serverKey];
      }

      if (!server) {
        return res.status(404).json({ error: 'Server not found for the provided IP and port' });
      }

      console.log(`[SERVERSTATE MODULE] Received RCON request for ${server.ip}:${server.port} -> ${command}`);

      let responseData = await enqueueRcon(server, command);

      if (responseData === "") {
        responseData = "No Message";
      }

      if (responseData) {
        return res.json({ success: true, response: responseData });
      } else {
        return res.status(500).json({ success: false, error: 'Failed to execute RCON command' });
      }
    });

    async function updateCategory(categoryChannel, newCategoryName) {
      if (categoryChannel && categoryChannel.type === 4) {
        try {
          await categoryChannel.setName(newCategoryName);
          console.log(`[SERVERSTATE MODULE] Category name updated to: ${newCategoryName}`);
        } catch (error) {
          console.error('[SERVERSTATE MODULE] Error updating category name:', error);
        }
      }
    }

    // **Expose an SSH API Endpoint with API Key Protection**
    app.post('/ssh', authenticateApiKey, async (req, res) => {
      const { ip, port, command } = req.body;

      if (!ip || !port || !command) {
        return res.status(400).json({ error: 'Missing required parameters: ip, port, or command' });
      }

      if (!sshCmdAllowlist.includes(command)) {
        return res.status(400).json({ error: 'Invalid SSH command' });
      }

      const serverKey = `${ip}:${port}`;
      const server = serverAddressMap[serverKey];

      if (!server) {
        return res.status(404).json({ error: 'Server not found for the provided IP and port' });
      }

      console.log(`[SERVERSTATE MODULE] Received SSH request for ${server.name} -> ${command}`);

      let responseData = await sendSshCommand(server, command);

      if (responseData === "") {
        responseData = "No Message";
      }

      if (responseData) {
        return res.json({ success: true, response: responseData });
      } else {
        return res.status(500).json({ success: false, error: 'Failed to execute SSH command' });
      }
    });

    // **Start HTTPS Server with PFX Certificate**
    https.createServer(options, app).listen(3001, '0.0.0.0', () => {
      console.log('[SERVERSTATE MODULE] HTTPS RCON API listening on port 3001 (Protected)');
    });

    client.on('messageCreate', async (message) => {
      // Handle webhook messages in matchroom channels (update category name)
      if (message.webhookId && hardcodedChannelIds.includes(message.channel.id)) {
        const content = message.content;
        if (content.startsWith('sg_relay&hostname')) {
          const newCategoryName = content.split('sg_relay&hostname')[1].trim();
          if (newCategoryName) {
            const categoryChannel = message.channel.parent;
            updateCategory(categoryChannel, newCategoryName);
          }
        }
      }
      // Handle webhook messages in public channels (update channel name)
      if (message.webhookId && publicChannelIds.includes(message.channel.id)) {
        const content = message.content;
        if (content.startsWith('sg_relay&hostname')) {
          const newChannelName = content.split('sg_relay&hostname')[1].trim();
          if (newChannelName) {
            message.channel.setName(newChannelName)
              .then(updated => console.log(`[SERVERSTATE MODULE] Updated channel name to ${updated.name}`))
              .catch(error => console.error('[SERVERSTATE MODULE] Failed to update channel name:', error));
          }
        }
      }

      // Handle user messages in matchroom channels to send RCON commands
      if (!message.webhookId && hardcodedChannelIds.includes(message.channel.id)) {
        const channelId = message.channel.id;
        const userMessage = message.content;
        // Use the channelServers mapping keyed by channel id
        const server = channelServers[channelId];
        if (server) {
          console.log(`[SERVERSTATE MODULE] Sending RCON command to ${server.ip}:${server.port}: ${userMessage}`);
          const response = await enqueueRcon(server, "relay_fbws_speak " + userMessage);
          if (response != null) {
            await message.react('✅');
          } else {
            await message.react('❌');
          }
        } else {
          console.log('[SERVERSTATE MODULE] No server associated with this channel.');
        }
      }
    });
  }
};