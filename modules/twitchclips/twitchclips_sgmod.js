require('dotenv').config()
const axios = require('axios')

const REFRESH_TOKEN = process.env.REFRESH_TOKEN
const CLIENT_ID = process.env.CLIENT_ID
const CLIENT_SECRET = process.env.CLIENT_SECRET
const BROADCASTER_ID = process.env.TWITCHCLIPS_BROADCASTER_ID
// const CHANNEL_ID = process.env.TWITCHCLIPS_CHANNEL_ID

async function Authenticate () {
  console.log('[TWITCHCLIPS MODULE] Attempting to authenticate with Twitch')
  axios.post('https://id.twitch.tv/oauth2/token', {
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: REFRESH_TOKEN
  })
    .then(function (response) {
      if (response.status === 200) {
        console.log('[TWITCHCLIPS MODULE] Authenticated with Twitch')
        getClips(response.data.access_token)
      } else {
        console.error('[TWITCHCLIPS MODULE] Failed to authenticate with Twitch')
      }
    })
    .catch(function (error) {
      console.error('Failed to refresh access token.' + error)
    })
}

function getClips (token) {
  axios.get('https://api.twitch.tv/helix/clips', {
    params: {
      broadcaster_id: BROADCASTER_ID,
      first: '5'
    },
    headers: {
      Authorization: 'Bearer ' + encodeURIComponent(token),
      'Client-Id': CLIENT_ID
    }
  })
    .then(function (response) {
      if (response.status === 200) {
        console.log(response.data)
      }
    })
    .catch(function (error) {
      console.log(`[TWITCHCLIPS MODULE] ERROR: ${error}`)
    })
}

module.exports = {
  data: {
    name: 'twitchclips'
  },
  async execute (client) {
    await Authenticate()
  }
}
