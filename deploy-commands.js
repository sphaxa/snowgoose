const { REST, Routes } = require('discord.js')
require('dotenv').config()
const clientId = process.env.CLIENT_ID
const token = process.env.DISCORD_BOT_TOKEN
const guildId = process.env.GUILD_ID
const fs = require('node:fs')
const path = require('node:path')

const commands = []
const foldersPath = path.join(__dirname, 'modules')
const moduleFolders = fs.readdirSync(foldersPath)

for (const folder of moduleFolders) {
  const modulesPath = path.join(foldersPath, folder)
  const moduleFiles = fs.readdirSync(modulesPath).filter(file => file.endsWith('_sgcmd.js'))
  for (const file of moduleFiles) {
    const filePath = path.join(modulesPath, file)
    const command = require(filePath)
    if ('data' in command && 'execute' in command) {
      commands.push(command.data.toJSON())
    } else {
      console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`)
    }
  }
}

const rest = new REST().setToken(token);

(async () => {
  try {
    console.log(`Started refreshing ${commands.length} application (/) commands.`)

    const data = await rest.put(
      Routes.applicationGuildCommands(clientId, guildId),
      { body: commands }
    )

    console.log(`Successfully reloaded ${data.length} application (/) commands.`)
  } catch (error) {
    console.error(error)
  }
})()
