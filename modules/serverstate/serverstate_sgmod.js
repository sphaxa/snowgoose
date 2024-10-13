module.exports = {
    data: {
      name: 'serverstate'
    },
    async execute(client) {
      console.log('[SERVERSTATE MODULE] Listening for webhook messages...');
  
      const hardcodedChannelIds = ['1233652486628315146', '976588511081799750', '976588551582003220', '976588615993917490', '976588769639682088', '997558408410562671', '997558535586062386', '997558635360174183', '997558728310132746', '997558839643746324', '1017414227125862410', '1017415100459647036'];
  
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
      });
    }
  };
  