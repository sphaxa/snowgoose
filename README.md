# snowgoose 
### a modular discord bot
----------
**if you want to use a module that requires a DB, then youll need a postgres DB**

you'll need to uncomment the dotenv imports if you want to use dotenv, heres an example:
```
DISCORD_BOT_TOKEN=
CLIENT_ID=
GUILD_ID=
DATABASE_URL=
```
just needs your discord bot creds, guild id, and database connection string


**snowgoose uses discordjs**
so just
```
npm i
npm run start
```
to install the requirements and start the bot, assuming you've configured your environment variables

**oh yeah i dont have example database scripts, so just look at the code that uses the database and create the correct fields if you want**
