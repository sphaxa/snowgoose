const fs = require('node:fs')
const path = require('node:path')
const { Client, Collection, Events, GatewayIntentBits } = require('discord.js')
// require('dotenv').config()
const express = require('express')
const app = express()

const client = new Client({ intents: [GatewayIntentBits.Guilds] })

client.commands = new Collection()

const foldersPath = path.join(__dirname, 'modules')
const moduleFolders = fs.readdirSync(foldersPath)

for (const folder of moduleFolders) {
  const modulesPath = path.join(foldersPath, folder)
  const moduleFiles = fs.readdirSync(modulesPath).filter(file => file.endsWith('_sgcmd.js'))
  for (const file of moduleFiles) {
    const filePath = path.join(modulesPath, file)
    const module = require(filePath)
    if ('data' in module && 'execute' in module) {
      client.commands.set(module.data.name, module)
    } else {
      console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`)
    }
  }
}

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return

  const command = interaction.client.commands.get(interaction.commandName)

  if (!command) {
    console.error(`No command matching ${interaction.commandName} was found.`)
    return
  }

  try {
    await command.execute(interaction)
  } catch (error) {
    console.error(error)
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: 'There was an error while executing this command!', ephemeral: true })
    } else {
      await interaction.reply({ content: 'There was an error while executing this command!', ephemeral: true })
    }
  }
})

// Please ignore the webserver crap I am totally not scamming heroku with this.
app.use(express.static('public'))

app.get('/', function (req, res) {
  res.send('i am a discord bot, not a website. go away.')
})

app.listen(process.env.PORT || 3000,
  () => console.log('Server is running...'))

client.once(Events.ClientReady, c => {
  console.log(`Ready! Logged in as ${c.user.tag}`)
})

client.login(process.env.DISCORD_BOT_TOKEN)
