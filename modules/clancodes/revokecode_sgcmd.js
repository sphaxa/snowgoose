const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js')
const appRoot = require('app-root-path')
const db = require(appRoot + '/database.js')

module.exports = {
  meta: {
    name: "Revoke Clan Code",
    enabled: false
  },
  data: new SlashCommandBuilder()
    .setName('revokecode')
    .setDescription('Revoke an invite code from a user.')
    .addUserOption(option =>
      option
        .setName('user')
        .setDescription('The user to revoke a code from.')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
  async execute (interaction) {
    const user = interaction.options.getUser('user')
    const snowflake = user.id
    const msg = await revokeCode(snowflake)
    await interaction.reply({ content: msg, ephemeral: true })
  }
}

async function revokeCode (snowflake) {
  try {
    const res = await db.pool.query("UPDATE codes SET takenby = 'revoked' WHERE CTID IN (SELECT CTID FROM codes WHERE takenby = $1 LIMIT 1) RETURNING *;", [snowflake])
    if (res.rows != null) {
      if (res.rows.length > 0) {
        return 'A code was revoked from the user.'
      } else {
        return 'User does not have a claimed code.'
      }
    } else {
      return 'User does not have a claimed code.'
    }
  } catch (error) {
    console.error(error)
    return 'Something went wrong generating a code.'
  }
}
