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

    async function fetchServerData() {
      try {
        const response = await axios.get('https://frag.events/api/servers/all-sg', {
          headers: { 'X-Api-Key': process.env.API_KEY }
        });

        const servers = response.data;

        channelServers = servers.reduce((acc, server) => {
          const [ip, port] = server.address.split(':');
          acc[server.matchroomId] = { name: server.name, ip, port: parseInt(port), password: server.rconPassword };
          return acc;
        }, {});

        hardcodedChannelIds = servers.map(server => server.matchroomId);

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
        return true;
      } catch (error) {
        console.error(`[RCON] Error sending command to ${server.ip}:${server.port}:`, error);
        return false;
      }
    }

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

    client.on('messageCreate', async (message) => {
      if (message.webhookId && hardcodedChannelIds.includes(message.channel.id)) {
        const content = message.content;

        if (content.startsWith('sg_relay&hostname')) {
          const newCategoryName = content.split('sg_relay&hostname')[1].trim();

          if (newCategoryName) {
            const categoryChannel = message.channel.parent;
            updateCategory(categoryChannel, '🟢 ' + newCategoryName);
          }
        }
      }

      if (!message.webhookId && hardcodedChannelIds.includes(message.channel.id)) {
        const channelId = message.channel.id;
        const userMessage = message.content;
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
