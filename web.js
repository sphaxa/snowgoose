// require('dotenv').config()
const express = require('express')
const app = express()

const foldersPath = path.join(__dirname, 'routes')
const routeFolders = fs.readdirSync(foldersPath)

app.use(express.static('public'))

app.get('/', function (req, res) {
  res.send('you didnt do something right.')
})

console.log('[WEBSERVER] Loading routes...')
for (const folder of routeFolders) {
    const modulesPath = path.join(foldersPath, folder)
    const moduleFiles = fs.readdirSync(modulesPath).filter(file => file.endsWith('_sgrte.js'))
    for (const file of moduleFiles) {
        const filePath = path.join(modulesPath, file)
        const module = require(filePath)
        if ('data' in module) {
            app.use('/api/', module);
            console.log(`[WEBSERVER] Loaded route: ${module.data.name}`)
        } else {
            console.log(`[WEBSERVER] The route at ${filePath} is missing a required "data" property. It has not been loaded.`)
        }
    }
}

app.listen(process.env.PORT || 3000,
  () => console.log('[WEBSERVER] Server is running...'))