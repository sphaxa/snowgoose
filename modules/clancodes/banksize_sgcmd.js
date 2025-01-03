const { SlashCommandBuilder } = require('discord.js')
const appRoot = require('app-root-path')
const db = require(appRoot + '/database.js')

module.exports = {
  meta: {
    name: "Get Bank Size",
    enabled: false
  },
  data: new SlashCommandBuilder()
    .setName('banksize')
    .setDescription('Shows how many codes are in the bank.'),
  async execute (interaction) {
    retrieveData().then(async function (val) {
      await interaction.reply({ content: `There are ${val} code(s) in the bank.`, ephemeral: true })
    })
  }
}

async function retrieveData () {
  try {
    const res = await db.pool.query('SELECT COUNT(*) FROM codes WHERE takenby IS NULL')
    return res.rows[0].count
  } catch (error) {
    console.error(error)
  }
}
