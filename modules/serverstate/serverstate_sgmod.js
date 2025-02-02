const { Rcon } = require('rcon-client');

module.exports = {
  meta: {
    name: "Serverstate v1",
    enabled: true
  },
  data: {},
  async execute(client) {
    console.log('[SERVERSTATE MODULE] Listening for webhook and user messages...');

    const hardcodedChannelIds = ['1233652486628315146', '976588511081799750', '976588551582003220', '976588615993917490', '976588769639682088', '997558408410562671', '997558535586062386', '997558635360174183', '997558728310132746', '997558839643746324', '1017414227125862410', '1017415100459647036'];

    // Mapping channels to their associated IP addresses, ports, and passwords
    const channelServers = {
      '1233652486628315146': { name: 'Example name', ip: '10.6.1.98', port: 27015, password: 'zzzz' },
    };

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

    async function checkServerStates() {
      for (const [channelId, server] of Object.entries(channelServers)) {
        console.log(`[SERVERSTATE MODULE] Checking server state for ${server.ip}:${server.port}`);

        const success = await sendRconCommand(server, "fb_state_status");

        if (!success) {
          console.error(`[SERVERSTATE MODULE] Failed to connect to ${server.ip}:${server.port}.`);
          const channel = await client.channels.fetch(channelId);
          const category = await client.channels.fetch(channel.parentId);
          updateCategory(category, "🔴 " + server.name + ": OFFLINE");
        }
      }
    }

    setInterval(checkServerStates, 20000);

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

    async function resetAllCategories() {
      console.log('[SERVERSTATE MODULE] Resetting all category names to "UNBOUND"...');
      for (const channelId of hardcodedChannelIds) {
        try {
          const channel = await client.channels.fetch(channelId);
          if (!channel || !channel.parentId) {
            console.warn(`[SERVERSTATE MODULE] No parent category found for matchroom channel ${channelId}`);
            continue;
          }

          const category = await client.channels.fetch(channel.parentId);
          if (!category || category.type !== 4) {
            console.warn(`[SERVERSTATE MODULE] Parent is not a valid category for channel ${channelId}`);
            continue;
          }

          if (category.name !== "UNBOUND") {
            await category.setName("UNBOUND");
            console.log(`[SERVERSTATE MODULE] Set category name to "UNBOUND" for channel ${channelId}`);
          }
        } catch (error) {
          console.error(`[SERVERSTATE MODULE] Error resetting category name for channel ${channelId}:`, error);
        }
      }
    }

    client.once('ready', async () => {
      await resetAllCategories();
      console.log('[SERVERSTATE MODULE] All matchroom categories set to "UNBOUND".');
    });

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