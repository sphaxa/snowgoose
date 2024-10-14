const { Rcon } = require('rcon-client'); // Import RCON client

module.exports = {
  data: {
    name: 'serverstate'
  },
  async execute(client) {
    console.log('[SERVERSTATE MODULE] Listening for webhook and real user messages...');

    const hardcodedChannelIds = ['1233652486628315146', '976588511081799750', '976588551582003220', '976588615993917490', '976588769639682088', '997558408410562671', '997558535586062386', '997558635360174183', '997558728310132746', '997558839643746324', '1017414227125862410', '1017415100459647036'];

    // Mapping channels to their associated IP addresses, ports, and passwords
    const channelServers = {
      '1233652486628315146': { ip: '121.127.40.182', port: 25057, password: 'Cr341KvDq' },
      '976588511081799750': { ip: '192.168.1.11', port: 27016, password: 'password2' },
    };

    async function sendRconCommand(server, command) {
      try {
        const rcon = await Rcon.connect({ host: server.ip, port: server.port, password: server.password });
        const response = await rcon.send("relay_fbws_speak " + command);
        await rcon.end();
        console.log(`[RCON] Response from ${server.ip}:${server.port}:`, response);
        return true;
      } catch (error) {
        console.error(`[RCON] Error sending command to ${server.ip}:${server.port}:`, error);
        return false; 
      }
    }

    client.on('messageCreate', async (message) => {
      if (message.webhookId && hardcodedChannelIds.includes(message.channel.id)) {
        const content = message.content;

        if (content.startsWith('sg_relay&hostname')) {
          const newCategoryName = content.split('sg_relay&hostname')[1].trim();

          if (newCategoryName) {
            const categoryChannel = message.channel.parent;
            
            if (categoryChannel && categoryChannel.type === 4) {
              try {
                await categoryChannel.setName(newCategoryName);
                console.log(`[SERVERSTATE MODULE] Category name updated to: ${newCategoryName}`);
              } catch (error) {
                console.error('[SERVERSTATE MODULE] Error updating category name:', error);
              }
            }
          }
        }
      }

      if (!message.webhookId && hardcodedChannelIds.includes(message.channel.id)) {
        const channelId = message.channel.id;
        const userMessage = message.content;
        const server = channelServers[channelId];

        if (server) {
          console.log(`[SERVERSTATE MODULE] Sending RCON command to ${server.ip}:${server.port}: ${userMessage}`);

          const success = await sendRconCommand(server, userMessage);

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