const { SlashCommandBuilder } = require('discord.js')
const appRoot = require('app-root-path')
const db = require(appRoot + '/database.js')

module.exports = {
  data: new SlashCommandBuilder()
    .setName('getcode')
    .setDescription('Get an invite code to fl0ms BattleBit clan.'),
  async execute (interaction) {
    const msg = await checkIfValid(interaction.user.id)
    await interaction.reply({ content: msg, ephemeral: true })
  }
}

async function checkIfValid (snowflake) {
  try {
    const res = await db.pool.query('SELECT * FROM codes WHERE takenby = $1', [snowflake])
    if (res.rows.length > 0) {
      return `Here is your code: ${res.rows[0].code}
            If you are having issues, put a message in <#219605771963334658>`
    } else {
      return await claimCode(snowflake)
    }
  } catch (error) {
    console.error(error)
    return 'Something went wrong while trying to verify if you are allowed to get a code.'
  }
}

async function claimCode (snowflake) {
  try {
    const res = await db.pool.query('UPDATE codes SET takenby = $1 WHERE CTID IN (SELECT CTID FROM codes WHERE takenby IS NULL LIMIT 1) RETURNING *;', [snowflake])
    if (res.rows != null) {
      if (res.rows.length > 0) {
        return `Here is your code: ${res.rows[0].code}
                If you are having issues, put a message in <#219605771963334658>`
      } else {
        return 'There are no more codes available, contact sphaxa to add more.'
      }
    } else {
      return 'There are no more codes available, contact sphaxa to add more.'
    }
  } catch (error) {
    console.error(error)
    return 'Something went wrong generating a code.'
  }
}
