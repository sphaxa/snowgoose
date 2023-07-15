const { ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, SlashCommandBuilder, ComponentType } = require('discord.js')
const pronouns = require('./pronounlist.json')

console.log('[PRONOUN COMMAND PRE-LOAD] Building pronouns list...')
const pronounslist = []
pronouns.forEach(p => {
  pronounslist.push(new StringSelectMenuOptionBuilder()
    .setLabel(p.value)
    .setValue(p.key))
})

module.exports = {
  data: new SlashCommandBuilder()
    .setName('pronouns')
    .setDescription('Allows you to set your pronouns.'),
  async execute (interaction) {
    const select = new StringSelectMenuBuilder()
      .setCustomId('pronouns')
      .setPlaceholder('Select your pronouns.')
      .addOptions(pronounslist)

    const row = new ActionRowBuilder()
      .addComponents(select)

    const response = await interaction.reply({
      content: "If you don't see your pronouns in this list, put a message in <#219605771963334658>.",
      components: [row],
      ephemeral: true
    })

    const collector = response.createMessageComponentCollector({ componentType: ComponentType.StringSelect, time: 3_600_000 })

    collector.on('collect', async i => {
      const selection = i.values[0]
      let message
      try {
        let selectedpronouns
        pronouns.forEach(p => {
          if (p.key === selection) {
            selectedpronouns = p.value
          }
        })
        i.member.setNickname(`${i.user.username} | ${selectedpronouns}`)
        message = 'Your pronouns have been added to your nickname.'
      } catch {
        message = 'I was unable to update your nickname, you are either a higher role than me or I am missing permissions.'
      }
      await i.reply({
        content: message,
        ephemeral: true
      })
    })
  }
}
