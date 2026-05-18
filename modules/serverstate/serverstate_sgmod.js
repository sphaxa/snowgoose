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

    // Snowgoose serves multiple Nexus universes (frag.to, 2.frag.to, …). Each Nexus instance includes
    // its own base URL in the trigger payload; we remember every URL we've seen so the periodic sweep
    // can hit all of them, not just the most recent.
    const knownNexusBaseUrls = new Set();
    let rosterSyncInFlight = false;
    // Triggers that arrived while a sync was in flight. Drained as full syncs once the current
    // sync finishes, so 20 rapid creates collapse into one in-flight sync + one re-run instead of
    // 19 dropped triggers. Keyed by nexusBaseUrl so multi-universe triggers all get serviced.
    const pendingSyncUrls = new Set();

    function rememberNexusBaseUrl(baseUrl) {
      if (typeof baseUrl !== 'string' || !baseUrl.trim()) return;
      knownNexusBaseUrls.add(baseUrl.replace(/\/+$/, ''));
    }

    async function fetchRosterData(baseUrl, teamId) {
      try {
        const url = teamId
            ? `${baseUrl}/api/discord/roster-data?teamId=${teamId}`
            : `${baseUrl}/api/discord/roster-data`;
        const response = await axios.get(url, {
          headers: { 'X-Api-Key': process.env.API_KEY },
          timeout: 15000
        });
        return response.data;
      } catch (error) {
        console.error(`[DISCORD SYNC] Failed to fetch roster data from ${baseUrl}:`, error.message);
        return null;
      }
    }

    async function reportTeamIds(baseUrl, teamId, ids) {
      try {
        await axios.post(
            `${baseUrl}/api/discord/team/${teamId}/discord-ids`,
            ids,
            {
              headers: { 'X-Api-Key': process.env.API_KEY, 'Content-Type': 'application/json' },
              timeout: 10000
            }
        );
      } catch (error) {
        console.warn(`[DISCORD SYNC] Failed to report IDs for team ${teamId} to ${baseUrl}:`, error.message);
      }
    }

    async function reportMatchroomId(baseUrl, matchroomId, channelId) {
      try {
        await axios.post(
            `${baseUrl}/api/discord/matchroom/${matchroomId}/discord-id`,
            { discordChannelId: channelId },
            {
              headers: { 'X-Api-Key': process.env.API_KEY, 'Content-Type': 'application/json' },
              timeout: 10000
            }
        );
      } catch (error) {
        console.warn(`[DISCORD SYNC] Failed to report matchroom ${matchroomId} channel to ${baseUrl}:`, error.message);
      }
    }

    async function reportServerRelay(baseUrl, serverId, body) {
      try {
        await axios.post(
            `${baseUrl}/api/discord/server/${serverId}/relay`,
            body,
            {
              headers: { 'X-Api-Key': process.env.API_KEY, 'Content-Type': 'application/json' },
              timeout: 10000
            }
        );
      } catch (error) {
        console.warn(`[DISCORD SYNC] Failed to report relay IDs for server ${serverId} to ${baseUrl}:`, error.message);
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

    // Returns { channel, created } — `created` is true only when we just made it (so the caller
    // can post a welcome embed on first creation, not on every sync).
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
          return { channel: existing, created: false };
        }
      }
      // 2) Name match within the category
      const byName = category.children?.cache?.find(c => c.name === desiredName)
          || guild.channels.cache.find(c => c.parentId === category.id && c.name === desiredName);
      if (byName) return { channel: byName, created: false };
      // 3) Create
      try {
        const channel = await guild.channels.create({
          name: desiredName,
          type: 0, // GuildText
          parent: category.id,
          permissionOverwrites: [
            { id: guild.roles.everyone.id, deny: PERM_VIEW_CHANNEL },
            { id: role.id, allow: PERM_VIEW_CHANNEL | PERM_SEND_MESSAGES | PERM_READ_HISTORY }
          ],
          reason: `Team channel for ${team.name} (Nexus team ${team.id})`
        });
        return { channel, created: true };
      } catch (err) {
        console.error(`[DISCORD SYNC] Could not create channel for team ${team.id} (${team.name}):`, err.message);
        return { channel: null, created: false };
      }
    }

    // Welcome embed sent into a freshly-created team channel. Edit the JSON below to taste —
    // {team}, {event}, {url}, and {role} are filled in by buildWelcomeEmbed.
    function buildWelcomeEmbed({ team, event, url, role }) {
      return {
        color: 0x000000,
        title: `Welcome, ${team}!`,
        description: `Welcome to **${event}**. Head to ${url} to access your roster and matches.`,
        footer: { text: 'Ping @MatchAdmin if you need anything.' },
        timestamp: new Date().toISOString()
      };
    }

    async function sendWelcomeEmbed(channel, { teamName, eventName, nexusBaseUrl, role }) {
      try {
        const embed = buildWelcomeEmbed({
          team: teamName,
          event: eventName || 'the event',
          url: nexusBaseUrl,
          role: role ? `<@&${role.id}>` : '@team'
        });
        await channel.send({ embeds: [embed] });
      } catch (err) {
        console.warn(`[DISCORD SYNC] Could not post welcome embed in ${channel.id}: ${err.message}`);
      }
    }

    // ── Matchroom channels ────────────────────────────────────────────────

    function buildMatchroomChannelName(team1Name, team2Name, matchroomId) {
      const t1 = sanitizeChannelName(team1Name);
      const t2 = sanitizeChannelName(team2Name);
      // Trim each side so the combined name fits in 100 chars even with the suffix.
      const max = 40;
      return `${t1.slice(0, max)}-vs-${t2.slice(0, max)}-${matchroomId}`.slice(0, 100);
    }

    // Edit this template the same way as buildWelcomeEmbed. Variables filled in by
    // sendMatchroomWelcomeEmbed: {team1}, {team2}, {url}, {vetoStart} (Discord <t:…> tag).
    function buildMatchroomWelcomeEmbed({ team1, team2, url, vetoStart, role1, role2 }) {
      return {
        color: 0x000000,
        title: `${team1} vs ${team2}`,
        description: `Your matchroom is live. Head to ${url} to access vetoes, server info, and chat.`,
        fields: [
          { name: 'Teams',                value: `${role1} vs ${role2}`, inline: false },
          { name: 'Location vetoes start', value: vetoStart, inline: false }
        ],
        footer: { text: 'GLHF.' },
        timestamp: new Date().toISOString()
      };
    }

    async function sendMatchroomWelcomeEmbed(channel, { matchroom, nexusBaseUrl, role1, role2 }) {
      try {
        const url = `${nexusBaseUrl}/matchroom/${matchroom.id}`;
        // Use Discord's relative timestamp tag so it renders correctly in every viewer's timezone.
        const startSeconds = matchroom.startTimeUtc
            ? Math.floor(new Date(matchroom.startTimeUtc).getTime() / 1000)
            : null;
        const vetoStart = startSeconds ? `<t:${startSeconds}:F> (<t:${startSeconds}:R>)` : 'TBD';
        const embed = buildMatchroomWelcomeEmbed({
          team1: matchroom.team1Name,
          team2: matchroom.team2Name,
          url,
          vetoStart,
          role1: role1 ? `<@&${role1.id}>` : `**${matchroom.team1Name}**`,
          role2: role2 ? `<@&${role2.id}>` : `**${matchroom.team2Name}**`
        });

        // Embed mentions don't ping. Put role mentions in `content` and whitelist them in
        // allowedMentions so they ping even if the role's "mentionable" flag is off.
        const mentionRoleIds = [role1?.id, role2?.id].filter(Boolean);
        const content = mentionRoleIds.length
            ? mentionRoleIds.map(id => `<@&${id}>`).join(' ')
            : undefined;

        await channel.send({
          content,
          embeds: [embed],
          allowedMentions: { roles: mentionRoleIds }
        });
      } catch (err) {
        console.warn(`[DISCORD SYNC] Could not post matchroom welcome embed in ${channel.id}: ${err.message}`);
      }
    }

    function resolveTeamRole(guild, teamId, payloadRoleId, teamRolesById) {
      // Order: payload-supplied ID (DB) → just-resolved role from this sync's team pass → null
      if (payloadRoleId) {
        const r = guild.roles.cache.get(payloadRoleId);
        if (r) return r;
      }
      const justResolved = teamRolesById.get(teamId);
      if (justResolved) {
        const r = guild.roles.cache.get(justResolved);
        if (r) return r;
      }
      return null;
    }

    async function resolveOrCreateMatchroomChannel(guild, matchroom, category, role1, role2) {
      const desiredName = buildMatchroomChannelName(matchroom.team1Name, matchroom.team2Name, matchroom.id);

      const everyoneOverwrite = { id: guild.roles.everyone.id, deny: PERM_VIEW_CHANNEL };
      const roleOverwrites = [];
      if (role1) roleOverwrites.push({ id: role1.id, allow: PERM_VIEW_CHANNEL | PERM_SEND_MESSAGES | PERM_READ_HISTORY });
      if (role2) roleOverwrites.push({ id: role2.id, allow: PERM_VIEW_CHANNEL | PERM_SEND_MESSAGES | PERM_READ_HISTORY });

      // 1) Stored ID
      if (matchroom.discordChannelId) {
        const existing = guild.channels.cache.get(matchroom.discordChannelId)
            || await guild.channels.fetch(matchroom.discordChannelId).catch(() => null);
        if (existing) {
          if (existing.parentId !== category.id) {
            try { await existing.setParent(category.id, { lockPermissions: false }); }
            catch (err) { console.warn(`[DISCORD SYNC] Could not move matchroom channel ${existing.id}: ${err.message}`); }
          }
          if (existing.name !== desiredName) {
            try { await existing.setName(desiredName); }
            catch (err) { console.warn(`[DISCORD SYNC] Could not rename matchroom channel ${existing.id}: ${err.message}`); }
          }
          return { channel: existing, created: false };
        }
      }
      // 2) Name match
      const byName = guild.channels.cache.find(c => c.parentId === category.id && c.name === desiredName);
      if (byName) return { channel: byName, created: false };
      // 3) Create
      try {
        const channel = await guild.channels.create({
          name: desiredName,
          type: 0,
          parent: category.id,
          permissionOverwrites: [everyoneOverwrite, ...roleOverwrites],
          reason: `Matchroom channel for ${matchroom.team1Name} vs ${matchroom.team2Name} (Nexus matchroom ${matchroom.id})`
        });
        return { channel, created: true };
      } catch (err) {
        console.error(`[DISCORD SYNC] Could not create matchroom channel for ${matchroom.id}:`, err.message);
        return { channel: null, created: false };
      }
    }

    async function ensureMatchroomChannelPermissions(channel, guild, role1, role2) {
      try {
        await channel.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: false });
        if (role1) {
          await channel.permissionOverwrites.edit(role1, {
            ViewChannel: true, SendMessages: true, ReadMessageHistory: true
          });
        }
        if (role2) {
          await channel.permissionOverwrites.edit(role2, {
            ViewChannel: true, SendMessages: true, ReadMessageHistory: true
          });
        }
      } catch (err) {
        console.warn(`[DISCORD SYNC] Could not set permissions on matchroom channel ${channel.id}: ${err.message}`);
      }
    }

    async function syncMatchroomInGuild(guild, matchroom, category, nexusBaseUrl, teamRolesById) {
      const role1 = resolveTeamRole(guild, matchroom.team1Id, matchroom.team1RoleId, teamRolesById);
      const role2 = resolveTeamRole(guild, matchroom.team2Id, matchroom.team2RoleId, teamRolesById);
      if (!role1 || !role2) {
        console.warn(`[DISCORD SYNC] Matchroom ${matchroom.id} skipped — team role(s) not yet resolved (team1=${!!role1}, team2=${!!role2}).`);
        return null;
      }

      const { channel, created } = await resolveOrCreateMatchroomChannel(guild, matchroom, category, role1, role2);
      if (!channel) return null;
      await ensureMatchroomChannelPermissions(channel, guild, role1, role2);

      if (channel.id !== matchroom.discordChannelId) {
        await reportMatchroomId(nexusBaseUrl, matchroom.id, channel.id);
      }

      if (created) {
        await sendMatchroomWelcomeEmbed(channel, { matchroom, nexusBaseUrl, role1, role2 });
      }

      return { channelId: channel.id };
    }

    async function cleanupMatchroomOrphans(guild, category, expectedChannelIds) {
      const channelsInCategory = guild.channels.cache.filter(c => c.parentId === category.id);
      for (const channel of channelsInCategory.values()) {
        if (expectedChannelIds.has(channel.id)) continue;
        try {
          await channel.delete('Matchroom sync: matchroom no longer exists');
          console.log(`[DISCORD SYNC] -matchroom channel #${channel.name} (${channel.id}) — orphan`);
        } catch (err) {
          console.warn(`[DISCORD SYNC] Could not delete orphan matchroom channel ${channel.id}: ${err.message}`);
        }
      }
    }

    // ── Relay channels (admin-only) ────────────────────────────────────────
    // Relay channels are private mirrors of in-server activity for staff. Created on server provision,
    // deleted on match teardown. Naming mirrors the matchroom channel so admins can pair them by sight.
    // Privacy is enforced solely by denying @everyone ViewChannel — Discord users with the Administrator
    // permission bypass channel-level overrides automatically, so they retain access by default.

    async function fetchRelayDataForServer(baseUrl) {
      try {
        const response = await axios.get(`${baseUrl}/api/discord/roster-data`, {
          headers: { 'X-Api-Key': process.env.API_KEY },
          timeout: 15000
        });
        return response.data;
      } catch (error) {
        console.error(`[DISCORD SYNC] Failed to fetch roster data from ${baseUrl} for relay:`, error.message);
        return null;
      }
    }

    async function createRelayChannel({ serverId, matchroomId, team1Name, team2Name, nexusBaseUrl }) {
      const data = await fetchRelayDataForServer(nexusBaseUrl);
      if (!data || !data.relayCategoryId) {
        console.warn(`[DISCORD SYNC] Cannot create relay channel for server ${serverId} — RelayCategoryId not configured at ${nexusBaseUrl}.`);
        return null;
      }

      // Locate the guild that owns the relay category. Same guild as team/matchroom categories in
      // most setups, but we look it up independently in case an admin split them.
      let targetGuild = null;
      let targetCategory = null;
      for (const guild of client.guilds.cache.values()) {
        const cat = findCategoryInGuild(guild, data.relayCategoryId);
        if (cat) {
          targetGuild = guild;
          targetCategory = cat;
          break;
        }
      }
      if (!targetGuild) {
        console.warn(`[DISCORD SYNC] No guild contains RelayCategoryId=${data.relayCategoryId}.`);
        return null;
      }

      const desiredName = buildMatchroomChannelName(team1Name, team2Name, matchroomId);
      let channel;
      try {
        channel = await targetGuild.channels.create({
          name: desiredName,
          type: 0,
          parent: targetCategory.id,
          permissionOverwrites: [
            { id: targetGuild.roles.everyone.id, deny: PERM_VIEW_CHANNEL }
            // Discord Administrator-permission users bypass overrides — no explicit allow needed.
          ],
          reason: `Relay channel for matchroom ${matchroomId} (server ${serverId})`
        });
      } catch (err) {
        console.error(`[DISCORD SYNC] Could not create relay channel for server ${serverId}:`, err.message);
        return null;
      }

      let webhookUrl = null;
      try {
        const webhook = await channel.createWebhook({
          name: 'Nexus Relay',
          reason: `Relay webhook for matchroom ${matchroomId} (server ${serverId})`
        });
        webhookUrl = webhook.url;
      } catch (err) {
        console.warn(`[DISCORD SYNC] Could not create relay webhook for channel ${channel.id}: ${err.message}`);
      }

      await reportServerRelay(nexusBaseUrl, serverId, {
        matchroomId: channel.id,
        matchroomWebhook: webhookUrl
      });

      // Warm channelServers / hardcodedChannelIds with the new channel ID so the messageCreate
      // handler picks up user messages immediately. Without this, the cache only refreshes on the
      // 5-minute sweep (line 100) — meaning the first user message in a freshly-created relay
      // channel gets silently dropped until then.
      await refreshServerData();

      console.log(`[DISCORD SYNC] +relay channel #${channel.name} (${channel.id}) for server ${serverId}`);
      return { channelId: channel.id, webhookUrl };
    }

    async function deleteRelayChannel(channelId) {
      if (!channelId) return false;
      // Walk every guild — we don't know which one the channel was created in (could be a different
      // guild from the roster sync target if an admin configured it that way).
      for (const guild of client.guilds.cache.values()) {
        const ch = guild.channels.cache.get(channelId)
            || await guild.channels.fetch(channelId).catch(() => null);
        if (!ch) continue;
        try {
          await ch.delete('Match teardown: relay no longer needed');
          console.log(`[DISCORD SYNC] -relay channel #${ch.name} (${ch.id}) — teardown`);
          return true;
        } catch (err) {
          console.warn(`[DISCORD SYNC] Could not delete relay channel ${channelId}: ${err.message}`);
          return false;
        }
      }
      return false;
    }

    async function cleanupRelayOrphans(guild, category, expectedChannelIds) {
      const channelsInCategory = guild.channels.cache.filter(c => c.parentId === category.id);
      for (const channel of channelsInCategory.values()) {
        if (expectedChannelIds.has(channel.id)) continue;
        try {
          await channel.delete('Relay sync: server no longer exists');
          console.log(`[DISCORD SYNC] -relay channel #${channel.name} (${channel.id}) — orphan`);
        } catch (err) {
          console.warn(`[DISCORD SYNC] Could not delete orphan relay channel ${channel.id}: ${err.message}`);
        }
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

      // Resolve wanted usernames against the prefetched guild member cache (populated once
      // per sync at the top of syncDiscordRoster). No per-username API calls.
      for (const username of wantedSet) {
        try {
          const member = guild.members.cache.find(m =>
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

    // Grants the "Player" role to anyone holding at least one team role, removes it from anyone
    // who no longer does. The role is admin-managed (looked up by name, not created here) — if it's
    // missing we log and bail rather than guess what its permissions should be.
    async function syncPlayerRole(guild, expectedTeamRoleIds) {
      const playerRole = guild.roles.cache.find(r => r.name === 'Player');
      if (!playerRole) {
        console.warn(`[DISCORD SYNC] No role named 'Player' found in guild "${guild.name}" — skipping Player role sync.`);
        return;
      }

      for (const member of guild.members.cache.values()) {
        const hasTeamRole = member.roles.cache.some(r => expectedTeamRoleIds.has(r.id));
        const hasPlayerRole = member.roles.cache.has(playerRole.id);

        if (hasTeamRole && !hasPlayerRole) {
          try {
            await member.roles.add(playerRole, 'Roster sync: holds a team role');
            console.log(`[DISCORD SYNC] +${member.user.username} → Player`);
          } catch (err) {
            console.warn(`[DISCORD SYNC] Could not grant Player to ${member.user?.username}: ${err.message}`);
          }
        } else if (!hasTeamRole && hasPlayerRole) {
          try {
            await member.roles.remove(playerRole, 'Roster sync: no team roles');
            console.log(`[DISCORD SYNC] -${member.user.username} → Player`);
          } catch (err) {
            console.warn(`[DISCORD SYNC] Could not remove Player from ${member.user?.username}: ${err.message}`);
          }
        }
      }
    }

    async function syncTeamInGuild(guild, team, category, nexusBaseUrl, eventName) {
      if (!team.name) {
        console.warn(`[DISCORD SYNC] Skipping team ${team.id} — no name.`);
        return null;
      }
      const role = await resolveOrCreateRole(guild, team);
      if (!role) return null;
      const { channel, created } = await resolveOrCreateChannel(guild, team, category, role);
      if (!channel) return { roleId: role.id, channelId: null };
      await ensureChannelPermissions(channel, guild, role);
      await syncRoleMembers(guild, role, team.discordUsernames);

      const resolvedRoleId = role.id;
      const resolvedChannelId = channel.id;
      if (resolvedRoleId !== team.discordRoleId || resolvedChannelId !== team.discordChannelId) {
        await reportTeamIds(nexusBaseUrl, team.id, {
          discordRoleId: resolvedRoleId,
          discordChannelId: resolvedChannelId
        });
      }

      if (created) {
        await sendWelcomeEmbed(channel, {
          teamName: team.name,
          eventName,
          nexusBaseUrl,
          role
        });
      }

      return { roleId: resolvedRoleId, channelId: resolvedChannelId };
    }

    // Deletes channels in the team category that don't belong to any current team, and the roles
    // that gated access to those channels. Only runs on a full sync (teamId == null) — a single-team
    // trigger from a team-edit shouldn't touch other teams' channels.
    async function cleanupOrphans(guild, category, expectedChannelIds, expectedRoleIds) {
      // Collect every channel currently parented to the team category.
      const channelsInCategory = guild.channels.cache.filter(c => c.parentId === category.id);
      for (const channel of channelsInCategory.values()) {
        if (expectedChannelIds.has(channel.id)) continue;

        // Before deleting the channel, note any roles it granted ViewChannel to — those are
        // candidate team roles to delete as well.
        const candidateRoleIds = [];
        try {
          for (const ow of channel.permissionOverwrites.cache.values()) {
            if (ow.type !== 0) continue; // 0 = role overwrite (1 = member)
            const allowBits = typeof ow.allow?.bitfield === 'bigint' ? ow.allow.bitfield : BigInt(ow.allow ?? 0);
            if ((allowBits & PERM_VIEW_CHANNEL) !== 0n && ow.id !== guild.roles.everyone.id) {
              candidateRoleIds.push(ow.id);
            }
          }
        } catch (err) {
          console.warn(`[DISCORD SYNC] Could not read permission overwrites for orphan channel ${channel.id}: ${err.message}`);
        }

        try {
          await channel.delete('Roster sync: team no longer in active event');
          console.log(`[DISCORD SYNC] -channel #${channel.name} (${channel.id}) — orphan`);
        } catch (err) {
          console.warn(`[DISCORD SYNC] Could not delete orphan channel ${channel.id}: ${err.message}`);
          continue;
        }

        for (const roleId of candidateRoleIds) {
          if (expectedRoleIds.has(roleId)) continue;
          const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
          if (!role) continue;
          try {
            await role.delete('Roster sync: team no longer in active event');
            console.log(`[DISCORD SYNC] -role @${role.name} (${role.id}) — orphan`);
          } catch (err) {
            console.warn(`[DISCORD SYNC] Could not delete orphan role ${role.id}: ${err.message}`);
          }
        }
      }
    }

    async function syncDiscordRoster(nexusBaseUrl, teamId) {
      if (!nexusBaseUrl) {
        console.warn('[DISCORD SYNC] No Nexus base URL provided — cannot fetch roster.');
        return;
      }
      if (rosterSyncInFlight) {
        // Coalesce: remember this URL, run a full sync for it once the current one finishes.
        // Set dedupes — N triggers for the same URL mid-sync collapse into one re-run.
        pendingSyncUrls.add(nexusBaseUrl);
        console.log(`[DISCORD SYNC] Sync in flight; queued re-run for ${nexusBaseUrl}.`);
        return;
      }
      rosterSyncInFlight = true;
      try {
        await runOneRosterSync(nexusBaseUrl, teamId);
        // Drain any triggers that arrived while we were busy. Always full syncs — a per-team
        // request is a subset of a full sync, so re-running full covers both cases.
        while (pendingSyncUrls.size > 0) {
          const next = pendingSyncUrls.values().next().value;
          pendingSyncUrls.delete(next);
          console.log(`[DISCORD SYNC] Running queued re-sync for ${next}.`);
          await runOneRosterSync(next, null);
        }
      } finally {
        rosterSyncInFlight = false;
      }
    }

    async function runOneRosterSync(nexusBaseUrl, teamId) {
      const data = await fetchRosterData(nexusBaseUrl, teamId || null);
      if (!data) return;
      if (!data.teamChannelCategoryId) {
        console.log(`[DISCORD SYNC] TeamChannelCategoryId not configured at ${nexusBaseUrl} — skipping.`);
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
        console.warn(`[DISCORD SYNC] No guild contains TeamChannelCategoryId=${data.teamChannelCategoryId} (from ${nexusBaseUrl}). Bot may not be in the right guild, or the ID is wrong.`);
        return;
      }

      // Bulk-fetch the guild member list once so syncRoleMembers can resolve usernames
      // from the cache instead of hitting the rate-limited search endpoint per player.
      // Requires the GuildMembers privileged intent.
      try {
        await targetGuild.members.fetch();
      } catch (err) {
        console.warn(`[DISCORD SYNC] Bulk member fetch failed for guild "${targetGuild.name}": ${err.message}. Falling back to per-username lookups will be slow.`);
      }

      const teams = Array.isArray(data.teams) ? data.teams : [];
      console.log(`[DISCORD SYNC] Syncing ${teams.length} team(s) from ${nexusBaseUrl} in guild "${targetGuild.name}" (${targetGuild.id}).`);

      const expectedChannelIds = new Set();
      const expectedRoleIds = new Set();
      // teamId → resolved Discord role ID, used by matchroom pass to find roles for teams that
      // were freshly created in this same sync (so the DB writeback hasn't propagated yet).
      const teamRolesById = new Map();
      for (const team of teams) {
        try {
          const result = await syncTeamInGuild(targetGuild, team, targetCategory, nexusBaseUrl, data.activeEventName);
          if (result?.roleId) {
            expectedRoleIds.add(result.roleId);
            teamRolesById.set(team.id, result.roleId);
          }
          if (result?.channelId) expectedChannelIds.add(result.channelId);
        } catch (err) {
          console.error(`[DISCORD SYNC] Team ${team.id} (${team.name}) failed:`, err.message);
        }
      }

      // Orphan sweep for team category — only on a full sync.
      if (!teamId) {
        await cleanupOrphans(targetGuild, targetCategory, expectedChannelIds, expectedRoleIds);
        // "Player" umbrella role — granted to anyone holding at least one team role, removed from
        // anyone who no longer holds one. Full syncs only because a per-team trigger only sees one
        // team's role in expectedRoleIds and would wrongly strip Player from members on other teams.
        await syncPlayerRole(targetGuild, expectedRoleIds);
      }

      // ── Matchroom pass — full syncs only. Per-team triggers don't carry matchrooms.
      const matchrooms = Array.isArray(data.matchrooms) ? data.matchrooms : [];
      if (!teamId && data.matchroomCategoryId) {
        const matchroomCategory = findCategoryInGuild(targetGuild, data.matchroomCategoryId);
        if (!matchroomCategory) {
          console.warn(`[DISCORD SYNC] MatchroomCategoryId=${data.matchroomCategoryId} not found in guild "${targetGuild.name}" — skipping matchroom pass.`);
        } else {
          console.log(`[DISCORD SYNC] Syncing ${matchrooms.length} matchroom(s).`);
          const expectedMatchroomChannelIds = new Set();
          for (const mr of matchrooms) {
            try {
              const result = await syncMatchroomInGuild(targetGuild, mr, matchroomCategory, nexusBaseUrl, teamRolesById);
              if (result?.channelId) expectedMatchroomChannelIds.add(result.channelId);
            } catch (err) {
              console.error(`[DISCORD SYNC] Matchroom ${mr.id} failed:`, err.message);
            }
          }
          await cleanupMatchroomOrphans(targetGuild, matchroomCategory, expectedMatchroomChannelIds);
        }
      }

      // ── Relay orphan sweep — full syncs only. We never CREATE relays here (that happens on
      // server provision). We just delete any channel under the relay category that doesn't
      // correspond to a current Server.MatchroomId.
      if (!teamId && data.relayCategoryId) {
        const relayCategory = findCategoryInGuild(targetGuild, data.relayCategoryId);
        if (relayCategory) {
          const expectedRelayChannelIds = new Set(
              Array.isArray(data.expectedRelayChannelIds)
                  ? data.expectedRelayChannelIds.filter(id => typeof id === 'string' && id)
                  : []
          );
          await cleanupRelayOrphans(targetGuild, relayCategory, expectedRelayChannelIds);
        } else {
          console.warn(`[DISCORD SYNC] RelayCategoryId=${data.relayCategoryId} not found in guild "${targetGuild.name}" — skipping relay orphan sweep.`);
        }
      }

      console.log(`[DISCORD SYNC] Sync from ${nexusBaseUrl} complete.`);
    }

    // Relay create — fired by Nexus after a server has been provisioned and its address resolved.
    // Body: { serverId, matchroomId, team1Name, team2Name, nexusBaseUrl }
    app.post('/create-relay-channel', authenticateApiKey, async (req, res) => {
      const body = req.body || {};
      if (!Number.isInteger(body.serverId) || !Number.isInteger(body.matchroomId)) {
        return res.status(400).json({ error: 'serverId and matchroomId must be integers' });
      }
      if (typeof body.team1Name !== 'string' || typeof body.team2Name !== 'string') {
        return res.status(400).json({ error: 'team1Name and team2Name must be strings' });
      }
      if (typeof body.nexusBaseUrl !== 'string' || !body.nexusBaseUrl.trim()) {
        return res.status(400).json({ error: 'nexusBaseUrl is required' });
      }
      const nexusBaseUrl = body.nexusBaseUrl.replace(/\/+$/, '');
      rememberNexusBaseUrl(nexusBaseUrl);
      // Fire-and-forget so Nexus doesn't block on Discord API latency.
      createRelayChannel({
        serverId: body.serverId,
        matchroomId: body.matchroomId,
        team1Name: body.team1Name,
        team2Name: body.team2Name,
        nexusBaseUrl
      }).catch(err => console.error('[DISCORD SYNC] Relay create failed:', err));
      return res.json({ accepted: true, serverId: body.serverId });
    });

    // Relay delete — fired by Nexus on match teardown. Body: { channelId }
    app.post('/delete-relay-channel', authenticateApiKey, async (req, res) => {
      const body = req.body || {};
      if (typeof body.channelId !== 'string' || !body.channelId.trim()) {
        return res.status(400).json({ error: 'channelId is required' });
      }
      deleteRelayChannel(body.channelId)
          .catch(err => console.error('[DISCORD SYNC] Relay delete failed:', err));
      return res.json({ accepted: true, channelId: body.channelId });
    });

    // Manual trigger endpoint — Nexus calls this on team-edit and on the manual button.
    // Body: { teamId: number|null, nexusBaseUrl: "https://frag.to" }
    app.post('/sync-discord-roster', authenticateApiKey, async (req, res) => {
      const teamId = req.body && Number.isInteger(req.body.teamId) ? req.body.teamId : null;
      const nexusBaseUrl = req.body && typeof req.body.nexusBaseUrl === 'string'
          ? req.body.nexusBaseUrl.replace(/\/+$/, '')
          : null;
      if (!nexusBaseUrl) {
        return res.status(400).json({ error: 'Missing nexusBaseUrl in request body' });
      }
      rememberNexusBaseUrl(nexusBaseUrl);
      // Fire-and-forget so Nexus doesn't block on the actual sync.
      syncDiscordRoster(nexusBaseUrl, teamId).catch(err => console.error('[DISCORD SYNC] Background sync failed:', err));
      return res.json({ accepted: true, teamId, nexusBaseUrl });
    });

    // Periodic sweep — covers every Nexus instance we've seen. Catches drift, manual Discord edits,
    // missed pushes. Skipped until we've heard from at least one Nexus (so we know its URL).
    async function periodicSweep() {
      if (knownNexusBaseUrls.size === 0) {
        console.log('[DISCORD SYNC] Periodic sweep skipped — no Nexus base URLs recorded yet.');
        return;
      }
      for (const baseUrl of knownNexusBaseUrls) {
        try {
          await syncDiscordRoster(baseUrl, null);
        } catch (err) {
          console.error(`[DISCORD SYNC] Periodic sweep for ${baseUrl} failed:`, err.message);
        }
      }
    }
    setInterval(() => {
      periodicSweep().catch(err => console.error('[DISCORD SYNC] Periodic sweep error:', err));
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
          if (false) { // disabled category renaming for now
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