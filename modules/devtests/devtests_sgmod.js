const fs = require('fs');
const path = require('path');

module.exports = {
  meta: {
    name: "dev tests",
    enabled: true
  },
  data: {},
  async execute(client) {
    // Written next to this module file; overwritten on every run.
    const outFile = path.join(__dirname, 'channels.txt');

    const run = () => {
      const lines = [];
      let total = 0;

      for (const guild of client.guilds.cache.values()) {
        // `viewable` checks the bot's own ViewChannel permission, so private
        // channels it's locked out of are skipped. Sorted to roughly match the sidebar.
        const channels = [...guild.channels.cache.values()]
            .filter(c => c.viewable)
            .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0));

        lines.push(`Guild "${guild.name}" (${guild.id}) — ${channels.length} visible channel(s)`);
        for (const channel of channels) {
          const parent = channel.parent ? ` [${channel.parent.name}]` : '';
          lines.push(`  #${channel.name}${parent} (${channel.id})`);
        }
        lines.push('');
        total += channels.length;
      }

      lines.push(`Total: ${total} visible channel(s) across ${client.guilds.cache.size} guild(s).`);
      lines.push(`Generated: ${new Date().toISOString()}`);

      try {
        fs.writeFileSync(outFile, lines.join('\n'), 'utf8');
        console.log(`[DEV TESTS] Wrote ${total} channel(s) to ${outFile}`);
      } catch (err) {
        console.error(`[DEV TESTS] Could not write ${outFile}:`, err);
      }
    };

    // Guild/channel caches are only populated once the client is ready.
    if (client.isReady()) {
      run();
    } else {
      client.once('ready', run);
    }
  }
};