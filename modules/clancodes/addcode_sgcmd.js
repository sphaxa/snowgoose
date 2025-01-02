const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js')
const appRoot = require('app-root-path')
const db = require(appRoot + '/database.js')

module.exports = {
  meta: {
    name: "Add Clan Code",
    enabled: false
  },
  data: new SlashCommandBuilder()
    .setName('addcode')
    .setDescription('Add an invite code to the bank.')
    .addStringOption(option =>
      option
        .setName('code')
        .setRequired(true)
        .setDescription('The code you want to add to the bank.'))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
  async execute (interaction) {
    const code = interaction.options.getString('code')
    const msg = await addCode(code)
    await interaction.reply({ content: msg, ephemeral: true })
  }
}

async function addCode (code) {
  try {
    await db.pool.query('INSERT INTO codes (code) VALUES ($1);', [code])
    return 'Code added to bank.'
  } catch (error) {
    console.error(error)
    return "Something went wrong trying to add this code, make sure it's not a duplicate (Use /viewcode)."
  }
}
