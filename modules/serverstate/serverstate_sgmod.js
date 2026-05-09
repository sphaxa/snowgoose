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

    // ── Discord Roster Sync ────────────────────────────────────────────────
    // Pulls team rosters from Nexus and reconciles per-team Discord roles + channels.
    //
    // Multi-guild: snowgoose runs in several guilds. We treat the guild that contains the
    // configured TeamChannelCategoryId as the team-management guild. Anything else gets skipped.
    //
    // Rename-safe: Nexus stores per-team DiscordRoleId / DiscordChannelId. We look up by ID
    // first, fall back to name match, and POST the resolved IDs back so future syncs are stable
    // even if the team or its channel/role gets renamed.

    // v14 permission bit names; raw bigints used so this works on both v13 and v14.
    const PERM_VIEW_CHANNEL = 1n << 10n;
    const PERM_SEND_MESSAGES = 1n << 11n;
    const PERM_READ_HISTORY = 1n << 16n;

    function sanitizeChannelName(name) {
      // Discord channel names: lowercase, alphanumeric/dash/underscore, max 100.
      return (name || '')
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9_-]/g, '')
        .slice(0, 100) || 'team';
    }

    let rosterSyncInFlight = false;

    async function fetchRosterData(teamId) {
      try {
        const url = teamId
          ? `https://frag.to/api/discord/roster-data?teamId=${teamId}`
          : 'https://frag.to/api/discord/roster-data';
        const response = await axios.get(url, {
          headers: { 'X-Api-Key': process.env.API_KEY },
          timeout: 15000
        });
        return response.data;
      } catch (error) {
        console.error('[DISCORD SYNC] Failed to fetch roster data:', error.message);
        return null;
      }
    }

    async function reportTeamIds(teamId, ids) {
      try {
        await axios.post(
          `https://frag.to/api/discord/team/${teamId}/discord-ids`,
          ids,
          {
            headers: { 'X-Api-Key': process.env.API_KEY, 'Content-Type': 'application/json' },
            timeout: 10000
          }
        );
      } catch (error) {
        console.warn(`[DISCORD SYNC] Failed to report IDs for team ${teamId}:`, error.message);
      }
    }

    function findCategoryInGuild(guild, categoryId) {
      if (!categoryId) return null;
      const ch = guild.channels.cache.get(categoryId);
      // type 4 = GuildCategory in both v13 and v14
      return ch && ch.type === 4 ? ch : null;
    }

    async function resolveOrCreateRole(guild, team) {
      // 1) Stored ID — fast path, survives rename
      if (team.discordRoleId) {
        const existing = guild.roles.cache.get(team.discordRoleId)
          || await guild.roles.fetch(team.discordRoleId).catch(() => null);
        if (existing) {
          if (existing.name !== team.name) {
            try { await existing.setName(team.name); }
            catch (err) { console.warn(`[DISCORD SYNC] Could not rename role ${existing.id}: ${err.message}`); }
          }
          return existing;
        }
      }
      // 2) Name match
      const byName = guild.roles.cache.find(r => r.name === team.name);
      if (byName) return byName;
      // 3) Create
      try {
        return await guild.roles.create({
          name: team.name,
          mentionable: true,
          reason: `Team role for ${team.name} (Nexus team ${team.id})`
        });
      } catch (err) {
        console.error(`[DISCORD SYNC] Could not create role for team ${team.id} (${team.name}):`, err.message);
        return null;
      }
    }

    async function resolveOrCreateChannel(guild, team, category, role) {
      const desiredName = sanitizeChannelName(team.name);
      // 1) Stored ID
      if (team.discordChannelId) {
        const existing = guild.channels.cache.get(team.discordChannelId)
          || await guild.channels.fetch(team.discordChannelId).catch(() => null);
        if (existing) {
          if (existing.parentId !== category.id) {
            try { await existing.setParent(category.id, { lockPermissions: false }); }
            catch (err) { console.warn(`[DISCORD SYNC] Could not move channel ${existing.id}: ${err.message}`); }
          }
          if (existing.name !== desiredName) {
            try { await existing.setName(desiredName); }
            catch (err) { console.warn(`[DISCORD SYNC] Could not rename channel ${existing.id}: ${err.message}`); }
          }
          return existing;
        }
      }
      // 2) Name match within the category
      const byName = category.children?.cache?.find(c => c.name === desiredName)
        || guild.channels.cache.find(c => c.parentId === category.id && c.name === desiredName);
      if (byName) return byName;
      // 3) Create
      try {
        return await guild.channels.create({
          name: desiredName,
          type: 0, // GuildText
          parent: category.id,
          permissionOverwrites: [
            { id: guild.roles.everyone.id, deny: PERM_VIEW_CHANNEL },
            { id: role.id, allow: PERM_VIEW_CHANNEL | PERM_SEND_MESSAGES | PERM_READ_HISTORY }
          ],
          reason: `Team channel for ${team.name} (Nexus team ${team.id})`
        });
      } catch (err) {
        console.error(`[DISCORD SYNC] Could not create channel for team ${team.id} (${team.name}):`, err.message);
        return null;
      }
    }

    async function ensureChannelPermissions(channel, guild, role) {
      try {
        await channel.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: false });
        await channel.permissionOverwrites.edit(role, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true
        });
      } catch (err) {
        console.warn(`[DISCORD SYNC] Could not set permissions on channel ${channel.id}: ${err.message}`);
      }
    }

    async function syncRoleMembers(guild, role, discordUsernames) {
      // Normalize roster usernames once (lowercase, trimmed). Discord global usernames are
      // case-insensitive, so match on lowercase.
      const wantedSet = new Set(
        (discordUsernames || []).map(u => (u || '').trim().toLowerCase()).filter(Boolean)
      );

      // Add: search the guild for each wanted username and grant the role.
      for (const username of wantedSet) {
        try {
          const candidates = await guild.members.fetch({ query: username, limit: 5 });
          const member = candidates.find(m =>
            (m.user?.username || '').toLowerCase() === username
            || (m.user?.tag || '').toLowerCase() === username
          );
          if (!member) {
            console.log(`[DISCORD SYNC] No guild member matched '${username}' in ${guild.name}`);
            continue;
          }
          if (!member.roles.cache.has(role.id)) {
            await member.roles.add(role, `Roster sync: add to ${role.name}`);
            console.log(`[DISCORD SYNC] +${member.user.username} → ${role.name}`);
          }
        } catch (err) {
          console.warn(`[DISCORD SYNC] Lookup/add failed for '${username}':`, err.message);
        }
      }

      // Remove: anyone currently holding the role whose username isn't in the wanted set.
      try {
        const holders = role.members; // Collection — populated when GUILD_MEMBERS intent + cache available.
        for (const member of holders.values()) {
          const uname = (member.user?.username || '').toLowerCase();
          if (!wantedSet.has(uname)) {
            try {
              await member.roles.remove(role, 'Roster sync: not on team');
              console.log(`[DISCORD SYNC] -${member.user.username} → ${role.name}`);
            } catch (err) {
              console.warn(`[DISCORD SYNC] Could not remove ${member.user?.username} from ${role.name}: ${err.message}`);
            }
          }
        }
      } catch (err) {
        console.warn(`[DISCORD SYNC] Could not enumerate role.members for ${role.name}: ${err.message}`);
      }
    }

    async function syncTeamInGuild(guild, team, category) {
      if (!team.name) {
        console.warn(`[DISCORD SYNC] Skipping team ${team.id} — no name.`);
        return;
      }
      const role = await resolveOrCreateRole(guild, team);
      if (!role) return;
      const channel = await resolveOrCreateChannel(guild, team, category, role);
      if (!channel) return;
      await ensureChannelPermissions(channel, guild, role);
      await syncRoleMembers(guild, role, team.discordUsernames);

      const resolvedRoleId = role.id;
      const resolvedChannelId = channel.id;
      if (resolvedRoleId !== team.discordRoleId || resolvedChannelId !== team.discordChannelId) {
        await reportTeamIds(team.id, {
          discordRoleId: resolvedRoleId,
          discordChannelId: resolvedChannelId
        });
      }
    }

    async function syncDiscordRoster(teamId) {
      if (rosterSyncInFlight) {
        console.log('[DISCORD SYNC] Sync already in flight, skipping.');
        return;
      }
      rosterSyncInFlight = true;
      try {
        const data = await fetchRosterData(teamId || null);
        if (!data) return;
        if (!data.teamChannelCategoryId) {
          console.log('[DISCORD SYNC] TeamChannelCategoryId not configured in Nexus General settings — skipping.');
          return;
        }
        if (!Array.isArray(data.teams) || data.teams.length === 0) {
          console.log('[DISCORD SYNC] No teams in roster payload — nothing to do.');
          return;
        }

        // Find the (one) guild where the configured team-channel category lives.
        let targetGuild = null;
        let targetCategory = null;
        for (const guild of client.guilds.cache.values()) {
          const cat = findCategoryInGuild(guild, data.teamChannelCategoryId);
          if (cat) {
            targetGuild = guild;
            targetCategory = cat;
            break;
          }
        }

        if (!targetGuild) {
          console.warn(`[DISCORD SYNC] No guild contains TeamChannelCategoryId=${data.teamChannelCategoryId}. Bot may not be in the right guild, or the ID is wrong.`);
          return;
        }

        console.log(`[DISCORD SYNC] Syncing ${data.teams.length} team(s) in guild "${targetGuild.name}" (${targetGuild.id}).`);
        for (const team of data.teams) {
          try {
            await syncTeamInGuild(targetGuild, team, targetCategory);
          } catch (err) {
            console.error(`[DISCORD SYNC] Team ${team.id} (${team.name}) failed:`, err.message);
          }
        }
        console.log('[DISCORD SYNC] Sync complete.');
      } finally {
        rosterSyncInFlight = false;
      }
    }

    // Manual trigger endpoint — Nexus calls this on team-edit and on the manual button.
    app.post('/sync-discord-roster', authenticateApiKey, async (req, res) => {
      const teamId = req.body && Number.isInteger(req.body.teamId) ? req.body.teamId : null;
      // Fire-and-forget so Nexus doesn't block on the actual sync.
      syncDiscordRoster(teamId).catch(err => console.error('[DISCORD SYNC] Background sync failed:', err));
      return res.json({ accepted: true, teamId });
    });

    // Periodic sweep (independent of Nexus). Catches drift, manual Discord edits, missed pushes.
    // Initial delay gives the Discord client time to populate its guild/member cache after boot.
    setTimeout(() => {
      syncDiscordRoster().catch(err => console.error('[DISCORD SYNC] Initial sync failed:', err));
    }, 60 * 1000);
    setInterval(() => {
      syncDiscordRoster().catch(err => console.error('[DISCORD SYNC] Scheduled sync failed:', err));
    }, 30 * 60 * 1000);

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