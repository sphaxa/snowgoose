const https = require('https');
const fs = require('fs');
const express = require('express');
require('dotenv').config();
const { Rcon } = require('rcon-client');
const axios = require('axios');

module.exports = {
  meta: {
    name: "Serverstate v2",
    enabled: true
  },
  data: {},
  async execute(client) {
    console.log('[SERVERSTATE MODULE] Fetching server data from API...');

    let channelServers = {};
    let hardcodedChannelIds = [];
    let publicChannelIds = []; // New array for channels using PublicChannelId
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
        const response = await axios.get('https://frag.events/api/servers/all-sg', {
          headers: { 'X-Api-Key': process.env.API_KEY }
        });

        const servers = response.data;

        channelServers = servers.reduce((acc, server) => {
          const [ip, port] = server.address.split(':');
          acc[`${ip}:${port}`] = { 
            name: server.name, 
            ip, 
            port: parseInt(port), 
            password: server.rconPassword 
          };
          return acc;
        }, {});

        // These arrays now store the channel IDs for the two types of channels
        hardcodedChannelIds = servers.map(server => server.matchroomId);
        publicChannelIds = servers.map(server => server.publicChannelId);

        console.log('[SERVERSTATE MODULE] Successfully fetched server data.');
      } catch (error) {
        console.error('[SERVERSTATE MODULE] Error fetching server data:', error);
      }
    }

    await fetchServerData();

    async function sendRconCommand(server, command) {
      try {
        const rcon = await Rcon.connect({ host: server.ip, port: server.port, password: server.password });
        const response = await rcon.send(command);
        await rcon.end();
        console.log(`[RCON] Response from ${server.ip}:${server.port}:`, response);
        return response;
      } catch (error) {
        console.error(`[RCON] Error sending command to ${server.ip}:${server.port}:`, error);
        return null;
      }
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
      const server = channelServers[serverKey];

      if (!server) {
        return res.status(404).json({ error: 'Server not found for the provided IP and port' });
      }

      console.log(`[SERVERSTATE MODULE] Received RCON request for ${server.ip}:${server.port} -> ${command}`);

      var response = await sendRconCommand(server, command);

      if (response === "")
      {
        response = "No Message";
      }

      if (response) {
        return res.json({ success: true, response });
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
            // Assumes updateCategory is defined elsewhere to update the category's name
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
        // Note: Adjust the key mapping if necessary. Currently, channelServers keys are based on ip:port.
        const server = channelServers[channelId];
        if (server) {
          console.log(`[SERVERSTATE MODULE] Sending RCON command to ${server.ip}:${server.port}: ${userMessage}`);
          const success = await sendRconCommand(server, "relay_fbws_speak " + userMessage);
          if (success) {
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
